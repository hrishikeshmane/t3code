# Kiro Provider — Protocol and Integration Notes

Kiro is an Amazon CLI that speaks the Agent Communication Protocol (ACP) over stdio. This doc captures the non-obvious pieces of the integration. For the fork's maintenance guide (sync, rebuild, conflict zones, verification checklist), see `../PATCH.md`.

## Spawn and Authentication

```
kiro-cli acp --trust-all-tools [--agent <name>]
```

- Authentication is OIDC via `kiro-cli login`, performed **out-of-band** before the ACP session starts.
- The `initialize` response returns an empty `authMethods: []`.
- Per the ACP spec, an empty `authMethods` means the client must skip `authenticate` and proceed directly to `session/new`.
- Upstream's `AcpSessionRuntime` types `authMethodId` as required; the fork relaxes it to optional for this reason. Do not re-tighten.
- `--agent` is passed at spawn as a hint for Kiro's initial mode. Model is **not** passed via `--model` — see "In-Session Model and Agent Switching" below.

## session/new Requirements

- `mcpServers: []` is **required**. Omitting it can cause kiro-cli to exit silently with no diagnostic.
- The `session/new` response returns `models.availableModels[]`, `models.currentModelId`, `modes.availableModes[]`, and `modes.currentModeId`. These carry Kiro's initial model/agent state before any RPC switches.

## In-Session Model and Agent Switching

Kiro supports switching the active model and agent mid-session via RPCs — no respawn required. A single `kiro-cli acp` child process handles the entire thread.

| Change        | RPC                   | Semantics                                                                |
| ------------- | --------------------- | ------------------------------------------------------------------------ |
| Model switch  | `session/set_model`   | `{sessionId, modelId}` → `{}`; Kiro reroutes the next prompt to the new model |
| Agent switch  | `session/set_mode`    | `{sessionId, modeId}` → `{}`; Kiro swaps system prompt + MCP toolset |

**Bypass upstream `AcpSessionRuntime.setConfigOption`**. Upstream's unified helper routes both changes through `session/set_config_option`, which Kiro rejects with `-32601 "Method not found"`. The adapter issues `session/set_model` and `session/set_mode` directly via the raw request channel (`ctx.acp.request(method, payload)`).

**Tracking state.** `KiroSessionContext` holds two fields:
- `activeModel: string | undefined` — model Kiro last confirmed via `set_model`. Undefined at spawn. First turn with a concrete model fires the RPC; subsequent turns only fire on user switch.
- `activeMode: string | undefined` — agent Kiro last confirmed via `set_mode`. Same semantics.

Both init to `undefined` at spawn so the first turn always aligns Kiro's state with the user's selection, even if the user picked the spawn-time default (closes a first-turn no-op that bit us in PR #4).

### Why we do NOT pass `--model` at spawn

Passing `--model <slug>` to `kiro-cli acp` at spawn time **locks** Kiro's model and makes every subsequent `session/set_model` RPC a silent no-op. The RPC still returns `{}`, but Kiro keeps using the spawn-pinned model and the user sees "I switched to X" with replies still coming from the original model.

We pass `--agent` at spawn because that one is safe (it sets the initial mode as a hint, and `set_mode` RPC still works afterward), but we deliberately omit `--model`. Compliance: `rg '"--model"' apps/server/src/provider/Layers/KiroAdapter.ts` must return zero matches.

### Known limitation: cross-family model switches

Switching across model families mid-conversation (e.g., Claude → DeepSeek → Kimi) can trigger an AWS Bedrock `ValidationException` on the next prompt. Kiro replays the existing conversation history to the new model, and content-block shapes (`tool_use` blocks especially) are not portable across families. The adapter surfaces the error to the user rather than hiding it; a true fix requires Kiro-side history re-serialization.

Same-family switches (Claude ↔ Claude, Kimi ↔ Kimi) are reliable.

## Streaming and Turn End

- Streaming content arrives as `session/update` notifications (no `id` field).
- The turn ends with the RPC response to `session/prompt`: `{stopReason: "end_turn"}`.
  - Do not wait for a notification-based end signal.
- Cancellation uses `session/cancel`.

## Plan Sidebar Wiring

Kiro feeds the Plan sidebar (shared with Cursor/Codex) through `turn.plan.updated` events. Two producers, one emitter, deduped by fingerprint per turn:

| Source | Trigger | Handler |
| ------ | ------- | ------- |
| Native ACP plan | `session/update` with `kind: "plan"` | `PlanUpdated` case → `emitPlanUpdate(ctx, event.payload, ...)` |
| `todo_list` tool call | `session/update` with `kind: "tool_call"`, rawInput `command: "create"` / `"complete"` | `ToolCallUpdated` case → `applyTodoToolCall(event.toolCall, ctx.todoPlanState)` → `emitPlanUpdate` |

Subagent plans are filtered by the existing `sessionId !== ctx.mainSessionId` guard, so they never leak into the main thread sidebar.

### `todo_list` state model

Kiro's `todo_list` tool carries plan state in `rawInput`:
- `{ command: "create", tasks: [{ task_description: "..." }, ...] }` — seeds the plan. Tasks have **no explicit `id`**.
- `{ command: "complete", completed_task_ids: ["1", "2"] }` — flips tasks done. IDs are **1-based position strings** referencing the `create` order.

`applyTodoToolCall` (in `apps/server/src/provider/acp/KiroAcpExtension.ts`):
- Keys tasks by `String(index + 1)` on `create` to match Kiro's 1-based position convention (respecting explicit `id` when present for forward-compat).
- Tracks the plan as `ctx.todoPlanState: Map<id, {step, status}>`, reset on each turn start.
- Returns a merged plan on every call so UI sees aggregate state, not deltas.

### `inProgress` marker

Kiro's `todo_list` tool only emits `create` + `complete` — no explicit in-progress signal. We derive it: **the first pending entry after the last completed one is `inProgress`**. This gives the sidebar a "you are here" indicator that advances as tasks complete. The `ctx.todoPlanState` stays as pure `pending`/`completed`; only the emitted plan payload carries the decoration.

### Known limitation

Native ACP plan updates (via `kind: "plan"`) carry explicit `pending` / `in_progress` / `completed` per step. Some Kiro agents emit those; most use `todo_list` instead. If an agent mixes both sources within one turn, the fingerprint dedup ensures we don't double-emit the same state.

## Kiro Extensions (`_kiro.dev/*`)

Ext methods Kiro emits that the adapter handles:

| Method                         | Effect                                                        |
| ------------------------------ | ------------------------------------------------------------- |
| `_kiro.dev/commands/available` | Runtime-patch provider slash commands — delivered mid-session |
| `_kiro.dev/metadata`           | Context window usage stats                                    |

**Protocol correctness:** Any `_kiro.dev/*` request the adapter does _not_ handle **must** be answered with JSON-RPC error `-32601` ("method not found"). Returning `{}` as a success result is a spec violation — some agents tolerate it silently, others deadlock.

## Agent Discovery

```
kiro-cli agent list
```

- Parsed by `KiroProvider` and written to `~/.t3/caches/kiro.json`.
- Injected into every model's `optionDescriptors` as a `{id: "agent", type: "select", options: [...]}` descriptor. This is the post-PR#2246 shape — agents are no longer a bespoke `agentOptions` field.
- The web `TraitsPicker` renders any `"agent"` descriptor automatically through the generic descriptor pipeline (no per-provider gate).

## Settings and Caches

| Path                      | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `~/.t3/dev/settings.json` | `providers.kiro.enabled`, `binaryPath`, `customModels` |
| `~/.t3/caches/kiro.json`  | Cached discovered models and agents                    |

## Agent Dispatch Path

Agent selection flows: TraitsPicker → `composerDraftStore` → `composerProviderState` → WebSocket → `KiroAdapter.sendTurn`. The normalization gate that can silently drop the agent:

- `normalizeProviderKind` + the three adjacent hardcoded `ProviderKind` arrays in `composerDraftStore.ts` (see below). Missing `"kiro"` in any of them makes `setModelSelection` return `null` silently.

(Upstream PR #2246 deleted the old `normalizeProviderModelOptionsWithCapabilities` switch entirely — the generic descriptor pipeline in `composerProviderState.tsx` handles dispatch uniformly now.)

`KiroAdapter.sendTurn` compares the requested agent against `ctx.activeMode` and fires `session/set_mode` RPC when they differ. No respawn — the child process stays alive across agent switches. Integration tests assert the spawn count is stable across agent changes.

## Composer State Model

Per-thread composer draft state lives in `apps/web/src/composerDraftStore.ts`. After the 2026-04-24 upstream sync, **four** hardcoded `ProviderKind` arrays in that file **all** need `"kiro"`:

1. `normalizeProviderKind` (~line 558) — normalization gatekeeper
2. `legacyToModelSelectionByProvider` (~line 618) — migration loop
3. `setModelOptions` provider iteration (~line 735)
4. Secondary `setModelOptions` loop (~line 2284)

Missing any one produces a silent no-op: the UI accepts the model-selector click but reverts to whatever the last valid selection was. No error, no log. This has bitten us once (2026-04-20). See `PATCH.md` → "Hidden Traps" for audit grep and the planned single-source refactor.

## Files Owned Entirely by This Fork

```
apps/server/src/provider/Services/KiroAdapter.ts
apps/server/src/provider/Services/KiroProvider.ts
apps/server/src/provider/Layers/KiroAdapter.ts
apps/server/src/provider/Layers/KiroProvider.ts
apps/server/src/provider/Layers/KiroAdapter.integration.test.ts
apps/server/src/provider/Layers/KiroAdapter.parsing.test.ts
apps/server/src/provider/acp/KiroAcpExtension.ts
apps/server/src/provider/acp/KiroAcpExtension.test.ts
apps/server/scripts/kiro-mock-agent.ts
```

These live entirely within our fork — upstream never touches them. Safe to iterate freely.

## References

- `PATCH.md` — maintenance guide (sync, rebuild, verification checklist)
- `docs/effect-fn-checklist.md` — Effect v4 patterns used throughout the adapter
- Upstream PR [pingdotgg/t3code#1355](https://github.com/pingdotgg/t3code/pull/1355) — shared ACP infrastructure the Kiro layer builds on
