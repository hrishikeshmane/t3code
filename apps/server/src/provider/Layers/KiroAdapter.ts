/**
 * KiroAdapterLive — Kiro CLI (`kiro-cli acp`) via ACP.
 *
 * @module KiroAdapterLive
 */
import * as nodePath from "node:path";
import * as os from "node:os";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type ServerProviderSlashCommand,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Queue,
  Random,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";
import { Schema } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { AcpSessionRuntime, type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import { KiroAdapter, type KiroAdapterShape } from "../Services/KiroAdapter.ts";
import { KiroProvider } from "../Services/KiroProvider.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "kiro" as const;
const KIRO_RESUME_VERSION = 1 as const;

export interface KiroAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface KiroSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
  interrupted: boolean;
  mainSessionId: string;
  // The kiro-cli agent the child process was spawned with. Agent is a CLI-level
  // flag (--agent <name>) set at spawn time — it cannot be changed in-session.
  // If a later sendTurn specifies a different agent, we must tear down this
  // session and respawn with the new agent before dispatching the turn.
  activeAgent: string | undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the kiro-cli `--agent` name from a model selection. Returns undefined
 * if the selection targets a different provider, has no options, or carries no
 * non-empty `agent` field.
 */
export function resolveKiroAgent(
  modelSelection:
    | { readonly provider?: string; readonly options?: unknown }
    | null
    | undefined,
): string | undefined {
  if (!modelSelection || modelSelection.provider !== "kiro") return undefined;
  if (!isRecord(modelSelection.options)) return undefined;
  const agent = modelSelection.options.agent;
  if (typeof agent !== "string") return undefined;
  const trimmed = agent.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseKiroResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== KIRO_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function parseKiroSlashCommands(raw: ReadonlyArray<unknown>): ServerProviderSlashCommand[] {
  const commands: ServerProviderSlashCommand[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const cmd = entry as Record<string, unknown>;
    const rawName = typeof cmd.name === "string" ? cmd.name : "";
    const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
    if (!name) continue;
    const description =
      typeof cmd.description === "string" && cmd.description.length > 0
        ? cmd.description
        : undefined;
    const meta =
      cmd.meta && typeof cmd.meta === "object" ? (cmd.meta as Record<string, unknown>) : null;
    const rawInputType = meta?.inputType;
    const inputType =
      rawInputType === "selection"
        ? ("selection" as const)
        : rawInputType === "panel"
          ? ("panel" as const)
          : undefined;
    const hint = typeof meta?.hint === "string" && meta.hint.length > 0 ? meta.hint : undefined;
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
      ...(inputType ? { inputType } : {}),
    });
  }
  return commands;
}

export function parseKiroPrompts(raw: ReadonlyArray<unknown>): ServerProviderSlashCommand[] {
  const commands: ServerProviderSlashCommand[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name : "";
    if (!name) continue;
    const description =
      typeof p.description === "string" && p.description.length > 0 ? p.description : undefined;
    const hintParts: string[] = [];
    if (Array.isArray(p.arguments)) {
      for (const arg of p.arguments) {
        if (!arg || typeof arg !== "object") continue;
        const a = arg as Record<string, unknown>;
        if (typeof a.name !== "string" || !a.name) continue;
        hintParts.push(a.required ? `<${a.name}>` : `[${a.name}]`);
      }
    }
    const hint = hintParts.length > 0 ? hintParts.join(" ") : undefined;
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return commands;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

/**
 * Kiro-specific model context window mapping.
 */
function getContextWindowForModel(model: string | null | undefined): number {
  if (!model) return 200_000;
  const normalized = model.toLowerCase().trim();

  // 1M context models
  if (
    normalized.includes("opus-4.6-1m") ||
    normalized.includes("sonnet-4.6-1m") ||
    normalized.includes("minimax-m2.5") ||
    normalized.includes("minimax-m2.1") ||
    normalized.includes("agi-nova-beta-1m")
  ) {
    return 1_000_000;
  }

  // 128k context models
  if (
    normalized.includes("deepseek-3.2") ||
    normalized.includes("kimi-k2.5") ||
    normalized.includes("glm-5") ||
    normalized.includes("qwen3-coder-next") ||
    normalized.includes("qwen3-coder-480b")
  ) {
    return 128_000;
  }

  // Default 200k for auto, opus-4.6, sonnet-4.6, haiku-4.5
  return 200_000;
}

/**
 * Resolve kiro-cli binary path — try ~/.toolbox/bin/kiro-cli first, then PATH.
 */
async function resolveKiroCliBinary(fileSystem: FileSystem.FileSystem): Promise<string> {
  const toolboxPath = nodePath.join(os.homedir(), ".toolbox", "bin", "kiro-cli");
  const exists = await Effect.runPromise(
    fileSystem.exists(toolboxPath).pipe(Effect.orElseSucceed(() => false)),
  );
  return exists ? toolboxPath : "kiro-cli";
}

const KiroMetadataNotification = Schema.Struct({
  contextUsagePercentage: Schema.optional(Schema.Number),
});

function makeKiroAdapter(options?: KiroAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const kiroProvider = yield* KiroProvider;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const sessions = new Map<ThreadId, KiroSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.kiro.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<KiroSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: KiroSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: KiroAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const cwd = nodePath.resolve(input.cwd.trim());
        const kiroModelSelection =
          input.modelSelection?.provider === "kiro" ? input.modelSelection : undefined;
        const kiroAgent = resolveKiroAgent(input.modelSelection);
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const kiroCliBinary = yield* Effect.promise(() => resolveKiroCliBinary(fileSystem));
        const args = ["acp", "--trust-all-tools"];
        if (kiroAgent) args.push("--agent", kiroAgent);
        const spawnOptions = {
          command: kiroCliBinary,
          args,
          cwd,
        };

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        let ctx!: KiroSessionContext;

        const resumeSessionId = parseKiroResume(input.resumeCursor)?.sessionId;
        const acpNativeLoggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        });

        const acpContextScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(acpContextScope, Exit.void),
        );
        const acpContext = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn: spawnOptions,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3code", version: "1.0.0" },
            protocolLogging: {
              logIncoming: false,
              logOutgoing: false,
            },
            ...acpNativeLoggers,
          }).pipe(
            Layer.provide(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            ),
          ),
        ).pipe(
          Effect.provideService(Scope.Scope, acpContextScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        const acp = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
        const started = yield* Effect.gen(function* () {
          // Register Kiro-specific extension notification handlers
          yield* acp.handleExtNotification(
            "_kiro.dev/metadata",
            KiroMetadataNotification,
            (params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "_kiro.dev/metadata",
                  params,
                  "acp.kiro.extension",
                );
                if (params.contextUsagePercentage !== undefined && ctx) {
                  const maxTokens = getContextWindowForModel(ctx.session.model);
                  const usedTokens = Math.round((params.contextUsagePercentage / 100) * maxTokens);
                  yield* offerRuntimeEvent({
                    type: "thread.token-usage.updated",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    payload: {
                      usage: {
                        usedTokens,
                        maxTokens,
                        compactsAutomatically: true,
                      },
                    },
                  });
                }
              }),
          );

          yield* acp.handleExtNotification(
            "_kiro.dev/commands/available",
            Schema.Unknown,
            (params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "_kiro.dev/commands/available",
                  params,
                  "acp.kiro.extension",
                );
                const cmdParams = params as Record<string, unknown>;
                const commands = Array.isArray(cmdParams.commands)
                  ? parseKiroSlashCommands(cmdParams.commands)
                  : [];
                const prompts = Array.isArray(cmdParams.prompts)
                  ? parseKiroPrompts(cmdParams.prompts)
                  : [];
                if (commands.length > 0 || prompts.length > 0) {
                  yield* kiroProvider.patchSlashCommands([...commands, ...prompts]);
                }
              }),
          );

          // Log Kiro subagent / MCP lifecycle notifications; we don't surface
          // them as runtime events, but the native log captures the payloads
          // for debugging and reproduction.
          yield* acp.handleExtNotification(
            "_kiro.dev/subagent/list_update",
            Schema.Unknown,
            (params) =>
              logNative(
                input.threadId,
                "_kiro.dev/subagent/list_update",
                params,
                "acp.kiro.extension",
              ),
          );

          yield* acp.handleExtNotification(
            "_kiro.dev/mcp/server_initialized",
            Schema.Unknown,
            (params) =>
              logNative(
                input.threadId,
                "_kiro.dev/mcp/server_initialized",
                params,
                "acp.kiro.extension",
              ),
          );

          yield* acp.handleExtNotification(
            "_kiro.dev/mcp/server_init_failure",
            Schema.Unknown,
            (params) =>
              logNative(
                input.threadId,
                "_kiro.dev/mcp/server_init_failure",
                params,
                "acp.kiro.extension",
              ),
          );

          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params, "acp.jsonrpc");
              if (ctx?.session.runtimeMode === "full-access") {
                const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                if (autoApprovedOptionId !== undefined) {
                  return {
                    outcome: {
                      outcome: "selected" as const,
                      optionId: autoApprovedOptionId,
                    },
                  };
                }
              }
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pendingApprovals.set(requestId, {
                decision,
                kind: permissionRequest.kind,
              });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              return {
                outcome:
                  resolved === "cancel"
                    ? ({ outcome: "cancelled" } as const)
                    : {
                        outcome: "selected" as const,
                        optionId: acpPermissionOutcome(resolved),
                      },
              };
            }),
          );
          // Log unknown extension traffic from Kiro, but respond per the ACP
          // spec: unknown ext requests get `-32601 Method not found`; unknown
          // ext notifications are silently ignored beyond logging.
          yield* acp.handleUnknownExtRequest((method, params) =>
            logNative(input.threadId, method, params, "acp.kiro.extension").pipe(
              Effect.flatMap(() =>
                Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(method)),
              ),
            ),
          );
          yield* acp.handleUnknownExtNotification((method, params) =>
            logNative(input.threadId, method, params, "acp.kiro.extension"),
          );

          return yield* acp.start();
        }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );

        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model: kiroModelSelection?.model,
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: KIRO_RESUME_VERSION,
            sessionId: started.sessionId,
          },
          createdAt: now,
          updatedAt: now,
        };

        ctx = {
          threadId: input.threadId,
          session,
          scope: acpContextScope,
          acp,
          notificationFiber: undefined,
          pendingApprovals,
          turns: [],
          activeTurnId: undefined,
          stopped: false,
          interrupted: false,
          mainSessionId: started.sessionId,
          activeAgent: kiroAgent,
        };

        const nf = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              switch (event._tag) {
                case "ModeChanged":
                  return;
                case "AssistantItemStarted":
                  yield* offerRuntimeEvent(
                    makeAcpAssistantItemEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
                      itemId: event.itemId,
                      lifecycle: "item.started",
                    }),
                  );
                  return;
                case "AssistantItemCompleted":
                  yield* offerRuntimeEvent(
                    makeAcpAssistantItemEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
                      itemId: event.itemId,
                      lifecycle: "item.completed",
                    }),
                  );
                  return;
                case "PlanUpdated":
                  // Kiro doesn't emit plan updates in the same way as Cursor
                  return;
                case "ToolCallUpdated":
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
                  yield* offerRuntimeEvent(
                    makeAcpToolCallEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ContentDelta":
                  // Filter out content deltas if interrupted
                  if (ctx.interrupted) {
                    return;
                  }
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
                  yield* offerRuntimeEvent(
                    makeAcpContentDeltaEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
              }
            }),
          ),
        ).pipe(Effect.forkChild);

        ctx.notificationFiber = nf;
        sessions.set(input.threadId, ctx);
        sessionScopeTransferred = true;

        yield* offerRuntimeEvent({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Kiro ACP session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });

        return session;
      }).pipe(Effect.scoped);

    const sendTurn: KiroAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* requireSession(input.threadId);

        // Kiro's agent is set via the `--agent` CLI flag at spawn time and
        // cannot be changed on a running child process. If the incoming turn
        // targets a different agent, we must respawn the session before we
        // dispatch the prompt. Re-lookup the context after the respawn because
        // startSession tears down the prior session and installs a new one.
        const requestedAgent = resolveKiroAgent(input.modelSelection);
        if (requestedAgent !== existing.activeAgent) {
          yield* startSession({
            threadId: input.threadId,
            provider: PROVIDER,
            cwd: existing.session.cwd,
            runtimeMode: existing.session.runtimeMode,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            ...(existing.session.resumeCursor
              ? { resumeCursor: existing.session.resumeCursor }
              : {}),
          });
        }

        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === "kiro" ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model ?? "auto";

        // Reset interrupted flag on new turn
        ctx.interrupted = false;

        // Only switch model if different from current
        if (model !== ctx.session.model && model !== "auto") {
          yield* ctx.acp.setModel(model).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", error),
            ),
            // Kiro may not support session/set_config_option — ignore errors
            Effect.catch(() => Effect.void),
          );
        }
        ctx.activeTurnId = turnId;
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model },
        });

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text input.",
          });
        }

        const result = yield* ctx.acp
          .prompt({
            prompt: promptParts,
          })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );

        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          model,
        };

        const stopReason = ctx.interrupted ? "interrupted" : (result.stopReason ?? null);

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" || ctx.interrupted ? "cancelled" : "completed",
            stopReason,
          },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: KiroAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);

        // Set interrupted flag to gate residual streaming chunks
        ctx.interrupted = true;

        // Clear pending approvals
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);

        // Fire session/cancel as fire-and-forget
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );

        // Emit turn.completed with interrupted immediately
        if (ctx.activeTurnId) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: ctx.activeTurnId,
            payload: {
              state: "cancelled",
              stopReason: "interrupted",
            },
          });
        }
      });

    const respondToRequest: KiroAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: KiroAdapterShape["respondToUserInput"] = () => Effect.void; // No-op for Kiro

    const readThread: KiroAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: KiroAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: KiroAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      });

    const listSessions: KiroAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: KiroAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: KiroAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies KiroAdapterShape;
  });
}

export const KiroAdapterLive = Layer.effect(KiroAdapter, makeKiroAdapter());

export function makeKiroAdapterLive(opts?: KiroAdapterLiveOptions) {
  return Layer.effect(KiroAdapter, makeKiroAdapter(opts));
}
