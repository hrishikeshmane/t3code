/**
 * Kiro ACP extraction helpers.
 *
 * Kiro does not ship an ACP ext notification for todos; instead the
 * assistant uses a built-in `todo_list` tool. The tool call carries
 * state in `rawInput`:
 *   - `command: "create"` → full task list with `id` + `task_description`.
 *     Seeds the plan; all entries are `pending`.
 *   - `command: "complete"` → only `completed_task_ids`. Requires prior
 *     state from a `create` to rebuild the full plan. Flips matching
 *     ids to `completed`.
 *
 * We inspect rawInput shape (not tool name) so future Kiro tool renames
 * don't break extraction. Verified shape mirrors Kirodex's
 * src/shared/acp/client.ts:379-395.
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

export interface TodoPlanEntry {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

export interface ApplyTodoResult {
  readonly nextState: Map<string, TodoPlanEntry>;
  readonly plan: AcpPlanUpdate;
}

/**
 * Decorate a plan with an `inProgress` marker on the first pending entry.
 *
 * Kiro's todo_list tool only emits `create` + `complete`, with no explicit
 * in-progress signal. We derive it heuristically: the first pending task
 * after the last completed one is the current task. This gives the sidebar
 * a "you are here" indicator.
 */
function withInProgressMarker(
  entries: ReadonlyArray<TodoPlanEntry>,
): ReadonlyArray<TodoPlanEntry> {
  const firstPending = entries.findIndex((entry) => entry.status === "pending");
  if (firstPending === -1) {
    return entries;
  }
  return entries.map((entry, index) =>
    index === firstPending ? { ...entry, status: "inProgress" as const } : entry,
  );
}

/**
 * Apply a `todo_list` tool call to the existing plan state.
 *
 * Returns `undefined` if the tool call doesn't match a recognizable
 * command or if a `complete` arrives without any prior state. Callers
 * should emit the tool-call envelope normally regardless of this result.
 */
export function applyTodoToolCall(
  toolCall: AcpToolCallState,
  state: Map<string, TodoPlanEntry> | undefined,
): ApplyTodoResult | undefined {
  const rawInput = toolCall.data.rawInput;
  const decoded = Schema.decodeUnknownOption(KiroTodoListRawInput)(rawInput);
  if (decoded._tag === "None") {
    return undefined;
  }
  const params = decoded.value;

  if (params.command === "create") {
    const tasks = params.tasks ?? [];
    if (tasks.length === 0) {
      return undefined;
    }
    const nextState = new Map<string, TodoPlanEntry>();
    tasks.forEach((task, index) => {
      const description = task.task_description?.trim();
      const step = description && description.length > 0 ? description : `Task ${index + 1}`;
      // Kiro does not emit explicit task IDs. Its `completed_task_ids` payload
      // references tasks by 1-based position strings ("1", "2", "3", ...) that
      // correspond to the order of tasks in the preceding `create`. Use the same
      // convention as the default key so `complete` can match. Respect an
      // explicit `id` when present for forward-compat with future Kiro versions.
      const id = task.id && task.id.length > 0 ? task.id : String(index + 1);
      nextState.set(id, { step, status: "pending" });
    });
    return {
      nextState,
      plan: { plan: withInProgressMarker(Array.from(nextState.values())) },
    };
  }

  if (params.command === "complete") {
    if (!state) {
      return undefined;
    }
    const completedIds = params.completed_task_ids ?? [];
    const nextState = new Map(state);
    for (const id of completedIds) {
      const entry = nextState.get(id);
      if (entry) {
        nextState.set(id, { ...entry, status: "completed" });
      }
    }
    return {
      nextState,
      plan: { plan: withInProgressMarker(Array.from(nextState.values())) },
    };
  }

  return undefined;
}
