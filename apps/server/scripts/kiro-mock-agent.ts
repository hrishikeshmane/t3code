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
      const promptText = Array.isArray(request.prompt)
        ? request.prompt
            .map((p) =>
              typeof p === "object" && p && "text" in p
                ? ((p as { text?: string }).text ?? "")
                : "",
            )
            .join(" ")
        : String(request.prompt ?? "");

      // Emit a content delta (default behavior preserved)
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello from kiro mock" },
        },
      });

      // Gated: native plan update
      if (promptText.includes("emit:plan")) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Research spec", status: "in_progress", priority: "medium" },
              { content: "Draft PR", status: "pending", priority: "medium" },
            ],
          },
        });
      }

      // Gated: todo_list tool call progression (create + complete)
      if (promptText.includes("emit:todos-progression")) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "todo-progression-create",
            title: "Create progression",
            kind: "think",
            status: "completed",
            rawInput: {
              command: "create",
              tasks: [
                { task_description: "First task" },
                { task_description: "Second task" },
              ],
            },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "todo-progression-complete",
            title: "Complete progression",
            kind: "think",
            status: "completed",
            rawInput: {
              command: "complete",
              completed_task_ids: ["1"],
            },
          },
        });
      }
      // Gated: todo_list tool call (basic create only)
      else if (promptText.includes("emit:todos")) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "todo-mock-1",
            title: "Create todo list",
            kind: "think",
            status: "completed",
            rawInput: {
              command: "create",
              tasks: [
                { task_description: "Read files" },
                { task_description: "Write tests" },
              ],
            },
          },
        });
      }

      // Emit kiro metadata extension notification (default behavior preserved)
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
