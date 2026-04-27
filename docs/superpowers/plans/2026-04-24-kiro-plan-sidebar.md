# Kiro Plan Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the Plan sidebar (`apps/web/src/components/PlanSidebar.tsx`) for Kiro sessions by wiring native ACP `PlanUpdated` events and synthesized plans from Kiro's `todo_list` tool calls into the existing `turn.plan.updated` runtime-event pipeline.

**Architecture:** Two producers fan into one emitter on the server-side Kiro adapter. Mirrors the existing Cursor adapter pattern — no contract changes, no web changes. Scope is bounded to main-session events; subagent filtering already in place continues unchanged.

**Tech Stack:** TypeScript, Effect v4, Vitest (`@effect/vitest`), effect `Schema`, Bun runtime.

**Context docs:**
- Design: [docs/plans/2026-04-24-kiro-plan-sidebar-design.md](../../plans/2026-04-24-kiro-plan-sidebar-design.md)
- Maintenance guide: [PATCH.md](../../../PATCH.md)
- Agent guide: [AGENTS.md](../../../AGENTS.md)

**Pre-flight commands you should know:**
- Run all tests: `bun run test` (never `bun test`)
- Run a single test file: `cd apps/server && bun run vitest run src/provider/acp/KiroAcpExtension.test.ts`
- Typecheck: `bun typecheck`
- Lint: `bun lint`
- Format: `bun fmt`

**Reference files (read once before starting):**
- `apps/server/src/provider/Layers/CursorAdapter.ts:357-388` — the `emitPlanUpdate` helper we mirror
- `apps/server/src/provider/Layers/CursorAdapter.ts:726-740` — how Cursor wires `PlanUpdated` to the helper
- `apps/server/src/provider/Layers/CursorAdapter.ts:562-583` — how Cursor wires `cursor/update_todos` to the helper (structural analog to Kiro's `todo_list` tool)
- `apps/server/src/provider/acp/CursorAcpExtension.ts:50-99` — `CursorUpdateTodosRequest` schema and `extractTodosAsPlan`
- `apps/server/src/provider/acp/CursorAcpExtension.test.ts:86-107` — parse test shape we mirror
- `apps/server/src/provider/acp/AcpRuntimeModel.ts:30-36` — `AcpPlanUpdate` type
- `apps/server/src/provider/acp/AcpRuntimeModel.ts:18-28` — `AcpToolCallState` type (note `data: Record<string, unknown>` carries `rawInput`)

---

## Task 1: Add `lastPlanFingerprint` to `KiroSessionContext` + reset on each turn

**Why:** We need per-session state to dedupe plan emissions (same payload arriving twice from different producers, or repeated `PlanUpdated` events with identical content). Cursor tracks the fingerprint on `ctx` and clears it on each new turn so the first plan of a turn always emits.

**Files:**
- Modify: `apps/server/src/provider/Layers/KiroAdapter.ts:73-95` (add field to interface)
- Modify: `apps/server/src/provider/Layers/KiroAdapter.ts:806-820` (init in session context literal)
- Modify: `apps/server/src/provider/Layers/KiroAdapter.ts:1008` (reset on turn start)

- [ ] **Step 1: Add `lastPlanFingerprint` field to the `KiroSessionContext` interface**

At `KiroAdapter.ts:73`, change the `KiroSessionContext` interface. The current shape ends with `subagentTasks: Map<string, KiroSubagentTaskState>;` — add `lastPlanFingerprint` above it, right after `activeAgent`, to match the visual order of the init literal:

```ts
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
  activeAgent: string | undefined;
  // Fingerprint of the last-emitted plan payload, used to dedupe plan
  // updates arriving from multiple sources (native PlanUpdated and
  // todo_list tool-call synthesis). Reset to `undefined` on each turn
  // start so the first plan of a turn always emits.
  lastPlanFingerprint: string | undefined;
  readonly subagentTasks: Map<string, KiroSubagentTaskState>;
}
```

- [ ] **Step 2: Initialize the field in the session-context literal**

At `KiroAdapter.ts:806-820`, the `ctx = { ... }` block. Add `lastPlanFingerprint: undefined,` right after `activeAgent: kiroAgent,`:

```ts
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
  lastPlanFingerprint: undefined,
  subagentTasks: new Map(),
};
```

- [ ] **Step 3: Reset fingerprint at the top of each turn**

Find `ctx.activeTurnId = turnId;` at `KiroAdapter.ts:1008`. Directly after that line, add `ctx.lastPlanFingerprint = undefined;`:

```ts
ctx.activeTurnId = turnId;
ctx.lastPlanFingerprint = undefined;
ctx.session = {
  ...ctx.session,
  activeTurnId: turnId,
  updatedAt: yield* nowIso,
};
```

- [ ] **Step 4: Typecheck**

Run: `bun typecheck`
Expected: 0 errors. (At this point the field exists but is unused — that's fine; the interface and init are consistent.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/KiroAdapter.ts
git commit -m "feat(kiro): add lastPlanFingerprint to session context

Adds per-session state for plan-update dedupe. Reset on each turn
start. Unused until emitPlanUpdate helper lands."
```

---

## Task 2: Write parse tests for `tryExtractTodoPlan` (failing)

**Why:** TDD — define the contract for the todo-list extractor before implementing it. Gate logic: `command === "create"` with non-empty `tasks` returns a plan; `command === "complete"` returns `undefined` (by design; rely on native `PlanUpdated` for completion state); everything else returns `undefined`.

**Files:**
- Create: `apps/server/src/provider/acp/KiroAcpExtension.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/server/src/provider/acp/KiroAcpExtension.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { tryExtractTodoPlan } from "./KiroAcpExtension.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

function makeToolCall(rawInput: unknown): AcpToolCallState {
  return {
    toolCallId: "tc-1",
    data: { toolCallId: "tc-1", rawInput },
  };
}

describe("tryExtractTodoPlan", () => {
  it("projects a create command into a pending plan", () => {
    const plan = tryExtractTodoPlan(
      makeToolCall({
        command: "create",
        tasks: [
          { id: "1", task_description: "Fetch data" },
          { id: "2", task_description: "Render view" },
        ],
      }),
    );

    expect(plan).toEqual({
      plan: [
        { step: "Fetch data", status: "pending" },
        { step: "Render view", status: "pending" },
      ],
    });
  });

  it("falls back to Task N when task_description is missing", () => {
    const plan = tryExtractTodoPlan(
      makeToolCall({
        command: "create",
        tasks: [{ id: "1" }, { id: "2", task_description: "  " }],
      }),
    );

    expect(plan).toEqual({
      plan: [
        { step: "Task 1", status: "pending" },
        { step: "Task 2", status: "pending" },
      ],
    });
  });

  it("returns undefined for a create with empty tasks", () => {
    const plan = tryExtractTodoPlan(
      makeToolCall({ command: "create", tasks: [] }),
    );
    expect(plan).toBeUndefined();
  });

  it("returns undefined for the complete command (by design)", () => {
    const plan = tryExtractTodoPlan(
      makeToolCall({ command: "complete", completed_task_ids: ["1", "2"] }),
    );
    expect(plan).toBeUndefined();
  });

  it("returns undefined for an unrelated tool call", () => {
    const plan = tryExtractTodoPlan(makeToolCall({ path: "foo.ts" }));
    expect(plan).toBeUndefined();
  });

  it("returns undefined when rawInput is absent", () => {
    const plan = tryExtractTodoPlan({
      toolCallId: "tc-1",
      data: { toolCallId: "tc-1" },
    });
    expect(plan).toBeUndefined();
  });

  it("returns undefined when rawInput is not an object", () => {
    const plan = tryExtractTodoPlan(makeToolCall("not-an-object"));
    expect(plan).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun run vitest run src/provider/acp/KiroAcpExtension.test.ts`
Expected: All tests FAIL with `Cannot find module './KiroAcpExtension.ts'` (module doesn't exist yet).

- [ ] **Step 3: Commit the failing tests**

```bash
git add apps/server/src/provider/acp/KiroAcpExtension.test.ts
git commit -m "test(kiro): add failing parse tests for tryExtractTodoPlan"
```

---

## Task 3: Implement `tryExtractTodoPlan` and pass the tests

**Why:** Pure parse function. Gates on `rawInput.command === "create"` and `tasks` being a non-empty array; no tool-name gate (matches Kirodex's robust approach). Returns `AcpPlanUpdate` shape the existing pipeline already understands.

**Files:**
- Create: `apps/server/src/provider/acp/KiroAcpExtension.ts`

- [ ] **Step 1: Create the module**

Create `apps/server/src/provider/acp/KiroAcpExtension.ts`:

```ts
/**
 * Kiro ACP extraction helpers.
 *
 * Kiro does not ship an ACP ext notification for todos; instead the
 * assistant uses a built-in `todo_list` tool. The tool call carries
 * the full state in `rawInput`. We inspect the rawInput shape (not
 * the tool name) so future Kiro tool renames don't break extraction.
 *
 * Verified shape (Kirodex/src/shared/acp/client.ts:379-395):
 *   {
 *     command: "create" | "complete" | string,
 *     tasks?: Array<{ id?: string; task_description?: string; status?: string }>,
 *     completed_task_ids?: string[],
 *   }
 */
import { Schema } from "effect";

import type { AcpPlanUpdate, AcpToolCallState } from "./AcpRuntimeModel.ts";

const KiroTodoItem = Schema.Struct({
  id: Schema.optional(Schema.String),
  task_description: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});

export const KiroTodoListRawInput = Schema.Struct({
  command: Schema.String,
  tasks: Schema.optional(Schema.Array(KiroTodoItem)),
  completed_task_ids: Schema.optional(Schema.Array(Schema.String)),
});

/**
 * Synthesize a plan update from a Kiro `todo_list` tool call's `rawInput`.
 *
 * Returns `undefined` when the input doesn't match the expected shape
 * or the command isn't one we map to a plan. Callers should emit the
 * tool-call envelope normally regardless of this result.
 */
export function tryExtractTodoPlan(toolCall: AcpToolCallState): AcpPlanUpdate | undefined {
  const rawInput = toolCall.data.rawInput;
  const decoded = Schema.decodeUnknownOption(KiroTodoListRawInput)(rawInput);
  if (decoded._tag === "None") {
    return undefined;
  }
  const params = decoded.value;

  if (params.command !== "create") {
    return undefined;
  }

  const tasks = params.tasks ?? [];
  if (tasks.length === 0) {
    return undefined;
  }

  const plan = tasks.map((task, index) => {
    const description = task.task_description?.trim();
    const step = description && description.length > 0 ? description : `Task ${index + 1}`;
    return { step, status: "pending" as const };
  });

  return { plan };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/server && bun run vitest run src/provider/acp/KiroAcpExtension.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 3: Typecheck**

Run: `bun typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/provider/acp/KiroAcpExtension.ts
git commit -m "feat(kiro): add tryExtractTodoPlan for todo_list tool calls

Synthesizes AcpPlanUpdate from the Kiro todo_list tool's rawInput
when command === 'create' and tasks is non-empty. Pattern matches
Kirodex's extraction — gates on rawInput shape rather than tool
name so future Kiro renames don't break extraction."
```

---

## Task 4: Add `emitPlanUpdate` helper to `KiroAdapter`

**Why:** Mirrors `CursorAdapter.ts:357-388`. Centralizes plan emission so both producers (`PlanUpdated` case + `ToolCallUpdated` synthesis) go through one fingerprint-dedupe path.

**Files:**
- Modify: `apps/server/src/provider/Layers/KiroAdapter.ts` (add helper near other local helpers in the adapter make function)

- [ ] **Step 1: Locate insertion point**

Run: `grep -n "const offerRuntimeEvent\|const makeEventStamp\|const logNative" apps/server/src/provider/Layers/KiroAdapter.ts | head -5`

Pick the function body area that contains these local helpers (around the `makeEventStamp`/`offerRuntimeEvent` definitions). `emitPlanUpdate` is a closure over `offerRuntimeEvent` and `makeEventStamp` — it must be defined where both are in scope. Insert it right after the last local helper and before the main `Stream.runDrain` loop that handles `acp.getEvents()`.

- [ ] **Step 2: Verify imports**

Confirm `makeAcpPlanUpdatedEvent` is imported. Run:

```bash
grep -n "makeAcpPlanUpdatedEvent\|from \"../acp/AcpCoreRuntimeEvents" apps/server/src/provider/Layers/KiroAdapter.ts
```

If `makeAcpPlanUpdatedEvent` is not already imported, add it to the existing import from `../acp/AcpCoreRuntimeEvents.ts` (alongside `makeAcpToolCallEvent`, `makeAcpAssistantItemEvent`, etc.). The import line is near the top of the file.

- [ ] **Step 3: Add the helper**

Insert the helper. It's a closure; don't lift it to module scope. Add it in the same `Effect.gen` block where `ctx` is initialized and the `Stream.runDrain` loop lives — same scope as `offerRuntimeEvent` and `makeEventStamp`. Use the exact pattern from `CursorAdapter.ts:357-388`:

```ts
const emitPlanUpdate = (
  sessionCtx: KiroSessionContext,
  payload: {
    readonly explanation?: string | null;
    readonly plan: ReadonlyArray<{
      readonly step: string;
      readonly status: "pending" | "inProgress" | "completed";
    }>;
  },
  rawPayload: unknown,
  source: "acp.jsonrpc",
  method: string,
) =>
  Effect.gen(function* () {
    const fingerprint = `${sessionCtx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
    if (sessionCtx.lastPlanFingerprint === fingerprint) {
      return;
    }
    sessionCtx.lastPlanFingerprint = fingerprint;
    yield* offerRuntimeEvent(
      makeAcpPlanUpdatedEvent({
        stamp: yield* makeEventStamp(),
        provider: PROVIDER,
        threadId: sessionCtx.threadId,
        turnId: sessionCtx.activeTurnId,
        payload,
        source,
        method,
        rawPayload,
      }),
    );
  });
```

Notes:
- `source` is narrowed to `"acp.jsonrpc"` because Kiro has no Cursor-style ext channel for plans. Both producers feed through `session/update`.
- Argument name `sessionCtx` avoids shadowing outer `ctx` variable in the handler.

- [ ] **Step 4: Typecheck**

Run: `bun typecheck`
Expected: 0 errors. (Helper is defined but unused — expected until next task.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/KiroAdapter.ts
git commit -m "feat(kiro): add emitPlanUpdate helper (unused)

Mirrors CursorAdapter's helper. Fingerprints on turn + payload so
duplicate plan emissions from multiple producers collapse to one
turn.plan.updated runtime event. Wired in next commits."
```

---

## Task 5: Wire native `PlanUpdated` through `emitPlanUpdate`

**Why:** Closes the original bug. The current `return;` at `KiroAdapter.ts:885` silently drops every native plan update Kiro sends. Upstream already parses `session/update` with `kind: "plan"` into a `PlanUpdated` event — we just need to forward it.

**Files:**
- Modify: `apps/server/src/provider/Layers/KiroAdapter.ts:885-887`

- [ ] **Step 1: Replace the dropped case**

Find the `case "PlanUpdated":` block at `KiroAdapter.ts:885`. Current body:

```ts
case "PlanUpdated":
  // Kiro doesn't emit plan updates in the same way as Cursor
  return;
```

Replace with:

```ts
case "PlanUpdated":
  yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
  yield* emitPlanUpdate(
    ctx,
    event.payload,
    event.rawPayload,
    "acp.jsonrpc",
    "session/update",
  );
  return;
```

- [ ] **Step 2: Typecheck**

Run: `bun typecheck`
Expected: 0 errors.

- [ ] **Step 3: Run existing Kiro tests to confirm no regressions**

Run: `cd apps/server && bun run vitest run src/provider/Layers/KiroAdapter`
Expected: all existing tests pass (baseline from PATCH.md checklist).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/provider/Layers/KiroAdapter.ts
git commit -m "fix(kiro): emit turn.plan.updated from native PlanUpdated

Replaces the no-op 'Kiro doesn't emit plan updates' comment with
the actual wiring. Main-session PlanUpdated events now reach the
Plan sidebar via the existing turn.plan.updated pipeline.
Subagent PlanUpdated still drops (sessionId guard above)."
```

---

## Task 6: Wire `todo_list` tool calls through `emitPlanUpdate`

**Why:** Kiro's assistant frequently uses the built-in `todo_list` tool instead of native plan updates. Without this, planning-via-tool-call never reaches the sidebar.

**Files:**
- Modify: `apps/server/src/provider/Layers/KiroAdapter.ts` (the `ToolCallUpdated` case, currently around line 888)

- [ ] **Step 1: Add the `tryExtractTodoPlan` import**

At the top of `KiroAdapter.ts`, add the import next to other `../acp/*` imports. Run:

```bash
grep -n "from \"../acp/" apps/server/src/provider/Layers/KiroAdapter.ts | head -5
```

Pick a nearby import line and add (or extend an existing import from `./KiroAcpExtension.ts` if you prefer, but the file is new so it'll be a fresh line):

```ts
import { tryExtractTodoPlan } from "../acp/KiroAcpExtension.ts";
```

- [ ] **Step 2: Extend the `ToolCallUpdated` case**

Find `case "ToolCallUpdated":` at `KiroAdapter.ts:888`. The current body emits a `makeAcpToolCallEvent` and returns. Keep that emission **unchanged**; add the synthesis call after it, before the `return`:

```ts
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
  const synthesized = tryExtractTodoPlan(event.toolCall);
  if (synthesized) {
    yield* emitPlanUpdate(
      ctx,
      synthesized,
      event.rawPayload,
      "acp.jsonrpc",
      "session/update:todo_list",
    );
  }
  return;
```

Notes:
- The synthesis is additive. The tool call still flows to the chat transcript as before.
- `method: "session/update:todo_list"` distinguishes this source in logs/events.
- Dedupe via `lastPlanFingerprint` prevents a duplicate emit if Kiro follows up with a native `PlanUpdated` carrying the same payload.

- [ ] **Step 3: Typecheck**

Run: `bun typecheck`
Expected: 0 errors.

- [ ] **Step 4: Run existing Kiro tests to confirm no regressions**

Run: `cd apps/server && bun run vitest run src/provider/Layers/KiroAdapter`
Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/KiroAdapter.ts
git commit -m "feat(kiro): synthesize plan updates from todo_list tool calls

When Kiro's built-in todo_list tool is invoked with command: 'create',
synthesize a turn.plan.updated runtime event alongside the usual
tool-call envelope. Mirrors Cursor's cursor/update_todos handling
but gates on rawInput shape (not tool name) so extraction survives
future Kiro tool renames. Dedupe via lastPlanFingerprint prevents
duplicate emits when Kiro also sends a native PlanUpdated."
```

---

## Task 7: Extend mock agent to emit plan + tool_call updates

**Why:** The existing `kiro-mock-agent.ts` only emits `agent_message_chunk` and a metadata ext notification. The integration test in Task 8 needs the mock to emit a native `plan` update and a `tool_call` with `todo_list`-shaped `rawInput`. We extend the mock, gated by prompt content, so other tests still get the default behavior.

**Files:**
- Modify: `apps/server/scripts/kiro-mock-agent.ts` (the `handlePrompt` body)

- [ ] **Step 1: Gate mock behavior on prompt content**

Find `agent.handlePrompt` (around `apps/server/scripts/kiro-mock-agent.ts:79`). The current body unconditionally emits `agent_message_chunk` and the metadata ext notification, then returns `{stopReason: "end_turn"}`. We add two new gated branches: `emit:plan` and `emit:todos` — the integration test sends these as prompt text.

Replace the `handlePrompt` body with:

```ts
  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      const promptText = Array.isArray(request.prompt)
        ? request.prompt
            .map((p) => (typeof p === "object" && p && "text" in p ? (p as { text?: string }).text ?? "" : ""))
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

      // Gated: todo_list tool call
      if (promptText.includes("emit:todos")) {
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
                { id: "t1", task_description: "Read files" },
                { id: "t2", task_description: "Write tests" },
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
```

Notes:
- If `priority` field is not part of the effect-acp Plan schema, drop it — it's optional in the ACP spec. If the typechecker complains in Step 2, remove both `priority` entries.
- `kind: "think"` is a valid ACP `ToolKind`. If the schema rejects it, fall back to `"other"`.

- [ ] **Step 2: Typecheck**

Run: `bun typecheck`
Expected: 0 errors. If `priority` or `kind: "think"` fails type checks, remove/adjust per the notes above and re-run.

- [ ] **Step 3: Confirm existing tests still pass**

Run: `cd apps/server && bun run vitest run src/provider/Layers/KiroAdapter.integration.test.ts`
Expected: all existing integration tests pass (they don't include `emit:plan` / `emit:todos` in their prompts).

- [ ] **Step 4: Commit**

```bash
git add apps/server/scripts/kiro-mock-agent.ts
git commit -m "test(kiro): extend mock agent with plan + todo_list emission

Adds gated branches in handlePrompt that emit a native ACP plan
update or a todo_list tool_call when the prompt contains
'emit:plan' or 'emit:todos'. Used by upcoming plan-sidebar
integration tests; other tests unaffected."
```

---

## Task 8: Add integration tests for both plan producers

**Why:** End-to-end verification. Asserts that from the WebSocket-style runtime-event boundary, sending a prompt that triggers a Kiro plan produces exactly one `turn.plan.updated` event with the correct payload. Separate tests for native plan vs. `todo_list` synthesis.

**Files:**
- Modify: `apps/server/src/provider/Layers/KiroAdapter.integration.test.ts` (add new `it.effect` blocks at the bottom of the `describe` block)

- [ ] **Step 1: Add test for native `PlanUpdated` → `turn.plan.updated`**

Open `apps/server/src/provider/Layers/KiroAdapter.integration.test.ts`. Find the closing `});` of the final `it.effect` in the `describe("KiroAdapterLive integration", () => {` block. Add the new test **inside** the `describe`, right before its closing `});`:

```ts
  it.effect("emits turn.plan.updated from native ACP plan session/update", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-plan-native-1");

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
        input: "emit:plan please",
        attachments: [],
      });

      const events = yield* Fiber.join(eventsFiber);
      const planEvents = events.filter((e) => e.type === "turn.plan.updated");

      expect(planEvents).toHaveLength(1);
      const [planEvent] = planEvents;
      expect(planEvent).toBeDefined();
      // `payload` on turn.plan.updated carries the AcpPlanUpdate.
      const plan = (planEvent as { payload: { plan: ReadonlyArray<{ step: string; status: string }> } }).payload.plan;
      expect(plan).toEqual([
        { step: "Research spec", status: "inProgress" },
        { step: "Draft PR", status: "pending" },
      ]);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );
```

- [ ] **Step 2: Add test for `todo_list` tool call → `turn.plan.updated`**

Add directly after the previous test, still inside the `describe`:

```ts
  it.effect("synthesizes turn.plan.updated from todo_list tool call", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const threadId = ThreadId.make("kiro-int-plan-todos-1");

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
        input: "emit:todos please",
        attachments: [],
      });

      const events = yield* Fiber.join(eventsFiber);
      const planEvents = events.filter((e) => e.type === "turn.plan.updated");

      expect(planEvents).toHaveLength(1);
      const [planEvent] = planEvents;
      expect(planEvent).toBeDefined();
      const plan = (planEvent as { payload: { plan: ReadonlyArray<{ step: string; status: string }> } }).payload.plan;
      expect(plan).toEqual([
        { step: "Read files", status: "pending" },
        { step: "Write tests", status: "pending" },
      ]);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(adapterLayer)),
  );
```

- [ ] **Step 3: Run the two new tests**

Run: `cd apps/server && bun run vitest run src/provider/Layers/KiroAdapter.integration.test.ts -t "turn.plan.updated"`
Expected: both new tests PASS.

- [ ] **Step 4: Run the full integration file to confirm no regressions**

Run: `cd apps/server && bun run vitest run src/provider/Layers/KiroAdapter.integration.test.ts`
Expected: all tests pass (pre-existing tests + 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/KiroAdapter.integration.test.ts
git commit -m "test(kiro): add integration tests for plan sidebar wiring

Two new tests covering both plan producers end-to-end:
- Native ACP plan session/update -> turn.plan.updated
- todo_list tool call with command:create -> turn.plan.updated"
```

---

## Task 9: Full suite + lint + format + manual smoke

**Why:** PATCH.md post-rebuild verification checklist. Catches any collateral damage (schema tests, composer-draft tests, etc.) before we declare the feature done.

- [ ] **Step 1: Typecheck**

Run: `bun typecheck`
Expected: 0 errors.

- [ ] **Step 2: Lint**

Run: `bun lint`
Expected: clean.

- [ ] **Step 3: Format check**

Run: `bun fmt`
Expected: no files changed (or only the files you edited, which should already be formatted).

- [ ] **Step 4: Full test suite**

Run: `bun run test`
Expected: baseline count (99 files / 902 passing per PATCH.md) **plus** the 7 new `KiroAcpExtension` tests and 2 new integration tests. Final: 99 files / 911+ passing (file count unchanged since we added one test file but removed zero).

If the final tally shows 100 files (one new KiroAcpExtension.test.ts), that's also correct. Either way, no regressions.

- [ ] **Step 5: Manual smoke test**

Run: `bun run dev` from repo root.

Steps:
1. Launch, pair, enable Kiro in settings, select a Kiro model.
2. Open a thread, type a prompt that will cause Kiro to plan (e.g. "plan out a refactor of X").
3. Verify the Plan sidebar opens/populates with steps as Kiro responds.
4. Verify step statuses progress (`pending` → `inProgress` → `completed`) live.
5. Trigger a subagent crew (e.g. a prompt that causes Kiro to fan out). Verify:
   - Subagent Work-log group renders as before.
   - Subagent plans do **NOT** appear in the main Plan sidebar.
6. Close the thread. Start a new one. Repeat with a planning prompt. Sidebar should clear between threads.

- [ ] **Step 6: Commit any final touch-ups if the manual smoke exposed issues**

If the smoke test surfaced a real bug (e.g. duplicate emission you didn't anticipate), fix it as a new task following the TDD pattern: failing test → fix → passing test → commit. Do **not** amend prior commits.

---

## Self-Review

Completed after writing the plan:

**Spec coverage vs. design doc:**
- Native `PlanUpdated` wiring → Task 5 ✓
- `todo_list` synthesis → Tasks 2, 3, 6 ✓
- `lastPlanFingerprint` dedupe → Task 1 (field) + Task 4 (helper) ✓
- Unit tests for extractor → Task 2 + 3 ✓
- Integration tests for both producers → Task 7 (mock) + Task 8 ✓
- Subagent plans continue to drop → existing guard at `KiroAdapter.ts:836`, preserved because all new emissions happen inside the main-session branch of the switch. Verified by not modifying that guard; worth an explicit assertion. **Follow-up:** consider adding a subagent-plan integration test that asserts zero `turn.plan.updated` events when subagent emits plan. Deferred — current subagent filter test coverage already asserts the broader guard.

**Placeholder scan:** no TBDs, TODOs, "similar to Task N", or vague "add error handling". Each step has complete code or a precise command.

**Type consistency check:**
- `KiroSessionContext.lastPlanFingerprint: string | undefined` (Task 1) — referenced by `emitPlanUpdate` helper (Task 4 reads `sessionCtx.lastPlanFingerprint`) and turn-start reset (Task 1 `ctx.lastPlanFingerprint = undefined`). Consistent.
- `tryExtractTodoPlan(toolCall: AcpToolCallState): AcpPlanUpdate | undefined` (Task 3) — called by `ToolCallUpdated` case (Task 6). `event.toolCall` is `AcpToolCallState`. Consistent.
- `emitPlanUpdate(sessionCtx, payload, rawPayload, source, method)` (Task 4) — called with `source: "acp.jsonrpc"` in both producers (Tasks 5, 6). Consistent.
- `makeAcpPlanUpdatedEvent` import (Task 4 Step 2) — referenced in Task 4 Step 3 helper body. Consistent.
- Mock agent prompt-gate strings `"emit:plan"` and `"emit:todos"` (Task 7) — referenced by integration tests as prompt input (Task 8 `input: "emit:plan please"` / `"emit:todos please"`). Consistent.

All checks green.
