#!/usr/bin/env bun
/**
 * Mock ACP agent that imitates kiro-cli ACP protocol for integration tests.
 *
 * Responds to: initialize, session/new, session/prompt, session/cancel.
 * Emits: session/update (agent_message_chunk), _kiro.dev/metadata extension.
 */
import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";

const sessionId = "kiro-mock-session-1";

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: {
        name: "kiro-mock-agent",
        version: "0.0.0",
      },
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));

  yield* agent.handleCreateSession(() =>
    Effect.succeed({
      sessionId,
    }),
  );

  yield* agent.handleLoadSession(() => Effect.succeed({}));

  yield* agent.handleCancel(() => Effect.void);

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);

      // Emit a content delta
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello from kiro mock" },
        },
      });

      // Emit kiro metadata extension notification
      yield* agent.client.extNotification("_kiro.dev/metadata", {
        contextUsagePercentage: 10,
      });

      return { stopReason: "end_turn" };
    }),
  );

  yield* agent.handleUnknownExtRequest((_method, _params) => Effect.succeed({}));

  return yield* Effect.never;
}).pipe(
  Effect.provide(EffectAcpAgent.layerStdio()),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
