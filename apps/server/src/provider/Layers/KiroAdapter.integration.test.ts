import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import { it } from "@effect/vitest";
import { type ServerProvider, ThreadId } from "@t3tools/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";

import { KiroAdapter } from "../Services/KiroAdapter.ts";
import { KiroProvider, type KiroProviderShape } from "../Services/KiroProvider.ts";
import { makeKiroAdapterLive } from "./KiroAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/kiro-mock-agent.ts");

/**
 * Build a ChildProcessSpawner that intercepts kiro-cli commands and redirects
 * them to the mock agent script. All other commands pass through to the real
 * Node spawner.
 *
 * `capturedArgs` records every intercepted spawn for test assertions.
 */
const capturedArgs: Array<ReadonlyArray<string>> = [];

const redirectingSpawnerLayer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => {
      // The KiroAdapter passes a StandardCommand with command "kiro-cli" or a
      // full path ending in kiro-cli. Intercept and redirect to mock agent.
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options: Record<string, unknown>;
      };
      if (cmd.command.includes("kiro-cli") || cmd.command.includes("kiro")) {
        capturedArgs.push(cmd.args);
        const redirected = ChildProcess.make("bun", ["run", mockAgentPath], {
          cwd: (cmd.options?.cwd as string) ?? process.cwd(),
          shell: process.platform === "win32",
        });
        return realSpawner.spawn(redirected);
      }
      return realSpawner.spawn(command);
    });
  }),
).pipe(Layer.provide(NodeChildProcessSpawner.layer));

/**
 * Minimal KiroProvider mock — we only need the service tag satisfied.
 */
const fakeSnapshot: ServerProvider = {
  provider: "kiro",
  enabled: true,
  installed: true,
  version: "0.0.0-test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: new Date().toISOString(),
  models: [],
  slashCommands: [],
  skills: [],
};

const fakeKiroProvider: KiroProviderShape = {
  getSnapshot: Effect.succeed(fakeSnapshot),
  refresh: Effect.succeed(fakeSnapshot),
  streamChanges: Stream.empty,
  patchSlashCommands: () => Effect.void,
};

/**
 * Compose the adapter layer with test dependencies.
 *
 * NodeServices provides FileSystem, Path, Stdio, Terminal, and the base
 * ChildProcessSpawner. We then override the spawner with our redirecting
 * layer so kiro-cli calls go to the mock agent.
 */
const adapterLayer = makeKiroAdapterLive().pipe(
  Layer.provideMerge(Layer.succeed(KiroProvider, fakeKiroProvider)),
  Layer.provideMerge(redirectingSpawnerLayer),
  Layer.provideMerge(NodeServices.layer),
);

describe("KiroAdapterLive integration", () => {
  it.effect("startSession initializes and creates session, hasSession returns true", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-start-1");

      const session = yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      expect(session.provider).toBe("kiro");
      expect(session.threadId).toBe(threadId);
      expect(session.status).toBe("ready");
      expect(session.resumeCursor).toBeDefined();

      const has = yield* adapter.hasSession(threadId);
      expect(has).toBe(true);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("stopSession tears down and hasSession returns false", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-stop-1");

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);

      const has = yield* adapter.hasSession(threadId);
      expect(has).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("sendTurn dispatches prompt and receives content.delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-turn-1");

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      // Fork a fiber to collect the first content.delta event
      const deltaFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "content.delta"),
        Stream.runHead,
        Effect.forkChild,
      );

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hello kiro",
        attachments: [],
      });

      expect(turn.threadId).toBe(threadId);
      expect(turn.turnId).toBeDefined();

      const deltaEvent = yield* Fiber.join(deltaFiber);
      expect(deltaEvent._tag).toBe("Some");
      if (deltaEvent._tag === "Some") {
        expect(deltaEvent.value.type).toBe("content.delta");
        if (deltaEvent.value.type === "content.delta") {
          expect(deltaEvent.value.payload.delta).toBe("hello from kiro mock");
        }
      }

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("emits session.started and turn.completed runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-events-1");

      // Collect runtime events
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
      });

      const events = yield* Fiber.join(eventsFiber);
      const eventTypes = events.map((e) => e.type);

      expect(eventTypes).toContain("session.started");
      expect(eventTypes).toContain("turn.started");
      expect(eventTypes).toContain("turn.completed");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("listSessions returns active sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-list-1");

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sessions = yield* adapter.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions.some((s) => s.threadId === threadId)).toBe(true);

      yield* adapter.stopSession(threadId);

      const afterStop = yield* adapter.listSessions();
      expect(afterStop.some((s) => s.threadId === threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect("passes --agent flag when agent is selected in model options", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-agent-flag-1");

      yield* adapter.startSession({
        threadId,
        provider: "kiro",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          provider: "kiro",
          model: "auto",
          options: { agent: "custom-agent" },
        },
      });

      // Verify the spawned args include --agent custom-agent
      const spawnedArgs = capturedArgs[capturedArgs.length - 1];
      expect(spawnedArgs).toBeDefined();
      expect(spawnedArgs).toContain("--agent");
      expect(spawnedArgs).toContain("custom-agent");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "respawns session with new --agent when sendTurn changes agent mid-session",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-agent-change-1");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: { agent: "agent-one" },
          },
        });

        const startupSpawnCount = capturedArgs.length;
        const startupArgs = capturedArgs[startupSpawnCount - 1];
        expect(startupArgs).toContain("--agent");
        expect(startupArgs).toContain("agent-one");

        // Changing the agent mid-session must trigger a respawn because
        // --agent is a kiro-cli spawn flag, not an in-session protocol field.
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: { agent: "agent-two" },
          },
        });

        expect(capturedArgs.length).toBeGreaterThan(startupSpawnCount);
        const latestArgs = capturedArgs[capturedArgs.length - 1];
        expect(latestArgs).toContain("--agent");
        expect(latestArgs).toContain("agent-two");
        expect(latestArgs).not.toContain("agent-one");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "does not respawn when sendTurn keeps the same agent",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-agent-same-1");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: { agent: "agent-stable" },
          },
        });

        const spawnCountAfterStart = capturedArgs.length;

        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "auto",
            options: { agent: "agent-stable" },
          },
        });

        expect(capturedArgs.length).toBe(spawnCountAfterStart);

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "switches model in-session without restarting the process",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-model-switch-1");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { provider: "kiro", model: "auto" },
        });

        const spawnCountAfterStart = capturedArgs.length;

        // First turn with default model
        yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
        });

        // Second turn with different model — should NOT respawn
        yield* adapter.sendTurn({
          threadId,
          input: "second turn after model switch",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "claude-sonnet-4-20250514",
          },
        });

        // Session should NOT have been restarted — only one spawn
        expect(capturedArgs.length).toBe(spawnCountAfterStart);

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "updates session.model immediately after in-session model switch",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-model-state-1");

        const session = yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { provider: "kiro", model: "auto" },
        });

        expect(session.model).toBe("auto");

        // Collect turn.started events to verify model is correct
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) => event.type === "turn.started" || event.type === "turn.completed",
          ),
          Stream.take(2), // turn.started + turn.completed for the model-switch turn
          Stream.runCollect,
          Effect.forkChild,
        );

        // Send turn with new model
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "switch model turn",
          attachments: [],
          modelSelection: {
            provider: "kiro",
            model: "claude-sonnet-4-20250514",
          },
        });

        expect(turn.threadId).toBe(threadId);

        const events = yield* Fiber.join(eventsFiber);
        const turnStarted = events.find((e) => e.type === "turn.started");
        expect(turnStarted).toBeDefined();
        if (turnStarted?.type === "turn.started") {
          expect(turnStarted.payload.model).toBe("claude-sonnet-4-20250514");
        }

        // Verify session state reflects the new model
        const sessions = yield* adapter.listSessions();
        const currentSession = sessions.find((s) => s.threadId === threadId);
        expect(currentSession?.model).toBe("claude-sonnet-4-20250514");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );

  it.effect(
    "does not call setModel when model is unchanged between turns",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.make("kiro-int-model-unchanged-1");

        yield* adapter.startSession({
          threadId,
          provider: "kiro",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { provider: "kiro", model: "auto" },
        });

        // Two turns with the same model — should not trigger setModel
        yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
          modelSelection: { provider: "kiro", model: "auto" },
        });

        yield* adapter.sendTurn({
          threadId,
          input: "second turn same model",
          attachments: [],
          modelSelection: { provider: "kiro", model: "auto" },
        });

        // Both turns should succeed without issues (no setModel called)
        const sessions = yield* adapter.listSessions();
        const currentSession = sessions.find((s) => s.threadId === threadId);
        expect(currentSession?.model).toBe("auto");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );
});
