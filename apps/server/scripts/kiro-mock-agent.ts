#!/usr/bin/env bun
/**
 * Mock ACP agent that imitates kiro-cli ACP protocol for integration tests.
 *
 * Responds to: initialize, session/new, session/prompt, session/cancel,
 *              session/set_model, session/set_config_option.
 * Emits: session/update (agent_message_chunk), _kiro.dev/metadata extension.
 */
import * as Effect from "effect/Effect";
import { Schema } from "effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";

const sessionId = "kiro-mock-session-1";

/** Available models — returned in session responses. */
const availableModels = ["auto", "claude-sonnet-4-20250514", "claude-opus-4-20250918"];
let currentModel = "auto";
let currentMode = "kiro_default";

/** Build the model config option structure used in ACP responses. */
function makeModelConfigOption(model: string) {
  return {
    id: "model",
    name: "Model",
    type: "select" as const,
    category: "model" as const,
    currentValue: model,
    options: availableModels.map((m) => ({ value: m, name: m })),
  };
}

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
      modes: {
        currentModeId: currentMode,
        availableModes: [],
      },
      configOptions: [makeModelConfigOption(currentModel)],
    }),
  );

  yield* agent.handleLoadSession(() => Effect.succeed({}));

  yield* agent.handleCancel(() => Effect.void);

  yield* agent.handleSetSessionModel((request) =>
    Effect.gen(function* () {
      if (typeof request.modelId === "string") {
        currentModel = request.modelId;
      }
      return {};
    }),
  );

  yield* agent.handleExtRequest("session/set_mode", Schema.Unknown, (request: any) =>
    Effect.gen(function* () {
      if (typeof request.modeId === "string") {
        currentMode = request.modeId;
      }
      return {};
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (request.configId === "model" && "value" in request && typeof request.value === "string") {
        currentModel = request.value;
      }
      return { configOptions: [makeModelConfigOption(currentModel)] };
    }),
  );

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
