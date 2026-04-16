import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";

import * as AcpClient from "./client";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

it.layer(NodeServices.layer)("effect-acp client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const command = ChildProcess.make("bun", ["run", yield* mockPeerPath], {
        cwd: path.join(import.meta.dirname, ".."),
        shell: process.platform === "win32",
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, prompts, receives updates, and handles permission requests", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<unknown>>([]);
      const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
      const typedRequests = yield* Ref.make<Array<unknown>>([]);
      const typedNotifications = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const acpLayer = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(acpLayer, scope);

      const ext = yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleRequestPermission(() =>
          Effect.succeed({
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          }),
        );
        yield* acp.handleElicitation(() =>
          Effect.succeed({
            action: {
              action: "accept",
              content: {
                approved: true,
              },
            },
          }),
        );
        yield* acp.handleSessionUpdate((notification) =>
          Ref.update(updates, (current) => [...current, notification]),
        );
        yield* acp.handleElicitationComplete((notification) =>
          Ref.update(elicitationCompletions, (current) => [...current, notification]),
        );
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          (payload) =>
            Ref.update(typedRequests, (current) => [...current, payload]).pipe(
              Effect.as({
                ok: true,
                echoedMessage: payload.message,
              }),
            ),
        );
        yield* acp.handleExtNotification(
          "x/typed_notification",
          Schema.Struct({ count: Schema.Number }),
          (payload) => Ref.update(typedNotifications, (current) => [...current, payload]),
        );

        const init = yield* acp.agent.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        });
        assert.equal(init.protocolVersion, 1);

        yield* acp.agent.authenticate({ methodId: "cursor_login" });

        const session = yield* acp.agent.createSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        assert.equal(session.sessionId, "mock-session-1");

        const prompt = yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });
        assert.equal(prompt.stopReason, "end_turn");

        const streamed = yield* Stream.runCollect(Stream.take(acp.raw.notifications, 2));
        assert.equal(streamed.length, 2);
        assert.equal(streamed[0]?._tag, "SessionUpdate");
        assert.equal(streamed[1]?._tag, "ElicitationComplete");
        assert.equal((yield* Ref.get(updates)).length, 1);
        assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);
        assert.deepEqual(yield* Ref.get(typedRequests), [{ message: "hello from typed request" }]);
        assert.deepEqual(yield* Ref.get(typedNotifications), [{ count: 2 }]);

        return yield* acp.raw.request("x/echo", {
          hello: "world",
        });
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.deepEqual(ext, {
        echoedMethod: "x/echo",
        echoedParams: {
          hello: "world",
        },
      });
    }),
  );

  it.effect(
    "returns formatted invalid params when a typed extension request payload is wrong",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeHandle({ ACP_MOCK_BAD_TYPED_REQUEST: "1" });
        const scope = yield* Scope.make();
        const acpLayer = AcpClient.layerChildProcess(handle);
        const context = yield* Layer.buildWithScope(acpLayer, scope);

        const result = yield* Effect.gen(function* () {
          const acp = yield* AcpClient.AcpClient;

          yield* acp.handleRequestPermission(() =>
            Effect.succeed({
              outcome: {
                outcome: "selected",
                optionId: "allow",
              },
            }),
          );
          yield* acp.handleElicitation(() =>
            Effect.succeed({
              action: {
                action: "accept",
                content: {
                  approved: true,
                },
              },
            }),
          );
          yield* acp.handleExtRequest(
            "x/typed_request",
            Schema.Struct({ message: Schema.String }),
            () => Effect.succeed({ ok: true }),
          );

          yield* acp.agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: {
              name: "effect-acp-test",
              version: "0.0.0",
            },
          });

          yield* acp.agent.authenticate({ methodId: "cursor_login" });

          const session = yield* acp.agent.createSession({
            cwd: process.cwd(),
            mcpServers: [],
          });

          return yield* Effect.exit(
            acp.agent.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "hello" }],
            }),
          );
        }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

        if (result._tag !== "Failure") {
          assert.fail("Expected prompt to fail for invalid typed extension payload");
        }
        const rendered = Cause.pretty(result.cause);
        assert.include(rendered, "Invalid x/typed_request payload:");
        assert.include(rendered, "Expected string, got 123");
      }),
  );
});
