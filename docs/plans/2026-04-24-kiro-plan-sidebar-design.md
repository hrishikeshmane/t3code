# Kiro Plan Sidebar — Design

Date: 2026-04-24
Branch: `claude/silly-johnson-ff7d07` (worktree off `kiro-acp`)

## Problem

The Plan sidebar (`apps/web/src/components/PlanSidebar.tsx`) stays empty for Kiro sessions. Cursor and Codex populate it via `turn.plan.updated` runtime events; Kiro does not, despite Kiro emitting usable plan data over ACP today.

Two root causes in [apps/server/src/provider/Layers/KiroAdapter.ts](../../apps/server/src/provider/Layers/KiroAdapter.ts):

1. Line 885 — native ACP `PlanUpdated` case `return;`s with the stale comment "Kiro doesn't emit plan updates in the same way as Cursor". Upstream's `AcpRuntimeModel.ts:435` already parses `session/update` with `kind: "plan"` into `PlanUpdated`; we drop it.
2. The `ToolCallUpdated` case is not inspected for Kiro's built-in `todo_list` tool. When the assistant uses that tool (rather than native plan updates), the plan data lives in `rawInput.command: "create" | "complete"` and is ignored.

Verified against two Amazon-internal Kiro ACP clients:
- `Kirodex` (`src/shared/acp/client.ts:373-416`) — synthesizes plan updates from both `todo_list` tool calls and native `plan` updateType.
- `KiRoom` (`src/kiroom-server/acp-session-manager.ts:606-608` + `routes/message-processor.ts:2040-2045`) — listens for native `plan` events, persists entries, broadcasts to UI.

## Goals

- Populate `PlanSidebar` for Kiro sessions using the same `turn.plan.updated` event the UI already renders for Cursor/Codex.
- Support both Kiro plan sources: native ACP `PlanUpdated` and synthesized from `todo_list` tool calls.
- No changes to contracts, shared packages, or web code — pure server-side adapter wiring.
- Subagent plans continue to be dropped from the main thread (preserved by the existing `sessionId !== ctx.mainSessionId` guard at `KiroAdapter.ts:836`).

## Non-Goals

- Surfacing subagent plans in a nested sidebar section. Out of scope; Work-log grouping already handles subagent visibility.
- Tracking `todo_list` task IDs across events to synthesize status transitions from `command: "complete"`. We rely on Kiro's native `PlanUpdated` to carry current statuses within the same turn. If that assumption fails in testing, a follow-up adds cross-event tracking.
- Refactoring the three-hardcoded-provider-arrays trap in `composerDraftStore.ts`. Not relevant — plan events flow through `turn.plan.updated`, not provider normalization.

## Data Flow

```
ACP session/update (kind: "plan")            ──┐
                                                ├─▶ emitPlanUpdate ──▶ turn.plan.updated ──▶ PlanSidebar
ACP session/update (kind: "tool_call",        ──┘
  rawInput.command = "create"
  on Kiro's todo_list tool)
```

One emitter (`emitPlanUpdate`) fans in from two producers. Mirrors the Cursor adapter, which already fans in from `PlanUpdated` + `cursor/update_todos` ext notification.

## Changes

### 1. `apps/server/src/provider/Layers/KiroAdapter.ts`

- Add `lastPlanFingerprint?: string` to the Kiro session context type.
- Add a local `emitPlanUpdate(ctx, payload, rawPayload, source, method)` helper. Identical semantics to `CursorAdapter.ts:357-388`:
  - Fingerprint on `${activeTurnId}:${JSON.stringify(payload)}` to dedupe.
  - Call `makeAcpPlanUpdatedEvent` → `offerRuntimeEvent`.
- Replace the `PlanUpdated` case body (line 885) with a call to `emitPlanUpdate` using `event.payload` and `event.rawPayload`.
- Extend the `ToolCallUpdated` case (line 888) to additionally call `tryExtractTodoPlan(event.toolCall)` and emit if the extractor returns a plan. The existing `makeAcpToolCallEvent` emission stays unchanged — plan synthesis is additive.

### 2. `apps/server/src/provider/acp/KiroAcpExtension.ts` (new, ~40–60 lines)

Mirrors `CursorAcpExtension.ts` in shape:

```ts
const KiroTodoItem = Schema.Struct({
  id: Schema.optional(Schema.String),
  task_description: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String), // reserved for future use
});

export const KiroTodoListRawInput = Schema.Struct({
  command: Schema.String,
  tasks: Schema.optional(Schema.Array(KiroTodoItem)),
  completed_task_ids: Schema.optional(Schema.Array(Schema.String)),
});

export function tryExtractTodoPlan(toolCall: AcpToolCallState): AcpPlanUpdate | undefined;
```

- Gate on `rawInput.command === "create"` and `rawInput.tasks` being a non-empty array.
- Do NOT gate on tool name — matches Kirodex's approach, robust against tool renames.
- Map `tasks[i].task_description` → `step`; fall back to `Task ${i+1}` if missing.
- All entries start as `status: "pending"`.
- Return `undefined` for `command: "complete"` (by design; see Non-Goals).

### 3. Tests

**`apps/server/src/provider/acp/KiroAcpExtension.test.ts` (new)**

- `create` with populated tasks → correct `{step, status: "pending"}[]`.
- `create` with empty `tasks` → `undefined`.
- `create` with missing `task_description` → falls back to `Task N`.
- `complete` command → `undefined`.
- Non-matching rawInput (no `command` field) → `undefined`.

**`apps/server/src/provider/Layers/KiroAdapter.integration.test.ts` (extend)**

- Inject `session/update` with `kind: "plan"` → exactly one `turn.plan.updated` runtime event fires with the expected payload.
- Inject subagent `session/update` with `kind: "plan"` (non-main `sessionId`) → **no** `turn.plan.updated` fires.
- Inject main-session `session/update` tool call with `todo_list` `rawInput.command: "create"` → one `turn.plan.updated` fires alongside the usual `ToolCallUpdated`.
- Duplicate native `plan` update with identical payload → second event is deduped (fingerprint).

## Error Handling

- `rawInput` shape mismatch or decoding error → `tryExtractTodoPlan` returns `undefined`. Tool call still emits as normal.
- Empty `tasks` array → `undefined`; sidebar untouched.
- Missing `task_description` → `Task N` fallback string.

No throws on the hot path. All failures are silent fall-throughs that preserve existing behavior.

## Verification Checklist

- [ ] `bun typecheck` 0 errors
- [ ] `bun fmt && bun lint` clean
- [ ] `bun run test` green
- [ ] Manual: Kiro session with a planning-flavored prompt → sidebar populates with steps
- [ ] Manual: step status updates (`inProgress` → `completed`) render live as Kiro progresses
- [ ] Manual: Kiro subagent crew runs → subagent plans do NOT leak into sidebar; Work-log grouping intact

## Out-of-Scope Follow-Ups

- `_kiro.dev/compaction/status` handling (KiRoom implements this; useful for context-usage UI).
- Task state transfer across session resets (KiRoom's `acp-task-transfer.ts` persists kiro-cli task files for plan continuity across resumes).
- Agent/mode switching mid-session via JSON-RPC (KiRoom has a clean pattern; we already have `session/set_model`).
- Extract `PROVIDER_KINDS` const tuple from contracts to kill the three-hardcoded-arrays trap referenced in PATCH.md.
