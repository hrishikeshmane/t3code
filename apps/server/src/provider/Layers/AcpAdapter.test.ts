import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type AcpAgentServer, ThreadId } from "@t3tools/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { AcpAdapter } from "../Services/AcpAdapter.ts";
import { AcpAgentRegistry } from "../Services/AcpAgentRegistry.ts";
import { makeAcpAdapterLive } from "./AcpAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

describe("AcpAdapterLive", () => {
  it.effect("writes native ACP observability records and emits runtime events", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        event?: {
          provider?: string;
          kind?: string;
          payload?: Record<string, unknown>;
        };
      }> = [];
      const threadId = ThreadId.make("thread-acp-native");
      const agentServer: AcpAgentServer = {
        id: "agent-1",
        name: "Agent 1",
        enabled: true,
        source: "manual",
        distributionType: "manual",
        launch: { command: "bun", args: [mockAgentPath] },
      };

      const adapterLayer = makeAcpAdapterLive({
        nativeEventLogger: {
          filePath: "memory://acp-native-events",
          write: (event, loggedThreadId) =>
            Effect.sync(() => {
              expect(loggedThreadId).toBe(threadId);
              nativeEvents.push(event as (typeof nativeEvents)[number]);
            }),
          close: () => Effect.void,
        },
      }).pipe(
        Layer.provideMerge(
          Layer.succeed(AcpAgentRegistry, {
            getAgentServers: Effect.succeed([agentServer]),
            listStatuses: Effect.succeed([]),
          }),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-acp-adapter-test-",
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      const result = yield* Effect.gen(function* () {
        const adapter = yield* AcpAdapter;
        const session = yield* adapter.startSession({
          threadId,
          provider: "acp",
          cwd: process.cwd(),
          modelSelection: { provider: "acp", agentServerId: "agent-1", model: "default" },
          runtimeMode: "full-access",
        });

        const deltaEventFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "content.delta"),
          Stream.runHead,
          Effect.forkChild,
        );

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });
        yield* adapter.interruptTurn(session.threadId);
        const deltaEvent = yield* Fiber.join(deltaEventFiber);
        yield* adapter.stopSession(session.threadId);
        return { turn, deltaEvent };
      }).pipe(Effect.provide(adapterLayer));

      expect(result.turn.threadId).toBe(threadId);
      expect(result.deltaEvent._tag).toBe("Some");
      if (result.deltaEvent._tag === "Some") {
        expect(result.deltaEvent.value.type).toBe("content.delta");
        if (result.deltaEvent.value.type === "content.delta") {
          expect(result.deltaEvent.value.payload.delta).toBe("hello from mock");
        }
      }

      expect(
        nativeEvents.some(
          (record) =>
            record.event?.provider === "acp" &&
            record.event?.kind === "request" &&
            record.event?.payload?.method === "session/prompt" &&
            record.event?.payload?.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        nativeEvents.some(
          (record) => record.event?.provider === "acp" && record.event?.kind === "protocol",
        ),
      ).toBe(true);
    }),
  );
});
