import { describe, expect, it } from "vitest";

import { applyTodoToolCall } from "./KiroAcpExtension.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

function makeToolCall(rawInput: unknown): AcpToolCallState {
  return {
    toolCallId: "tc-1",
    data: { toolCallId: "tc-1", rawInput },
  };
}

describe("applyTodoToolCall", () => {
  it("create seeds the state and emits plan with first entry inProgress", () => {
    const result = applyTodoToolCall(
      makeToolCall({
        command: "create",
        tasks: [
          { id: "t1", task_description: "Fetch data" },
          { id: "t2", task_description: "Render view" },
        ],
      }),
      undefined,
    );

    expect(result).toBeDefined();
    expect(result!.plan.plan).toEqual([
      { step: "Fetch data", status: "inProgress" },
      { step: "Render view", status: "pending" },
    ]);
    expect(result!.nextState.get("t1")).toEqual({ step: "Fetch data", status: "pending" });
    expect(result!.nextState.get("t2")).toEqual({ step: "Render view", status: "pending" });
  });

  it("complete flips matching ids in the prior state", () => {
    const initial = applyTodoToolCall(
      makeToolCall({
        command: "create",
        tasks: [
          { id: "t1", task_description: "Fetch data" },
          { id: "t2", task_description: "Render view" },
          { id: "t3", task_description: "Ship" },
        ],
      }),
      undefined,
    );
    expect(initial).toBeDefined();

    const completed = applyTodoToolCall(
      makeToolCall({ command: "complete", completed_task_ids: ["t1", "t3"] }),
      initial!.nextState,
    );

    expect(completed).toBeDefined();
    expect(completed!.plan.plan).toEqual([
      { step: "Fetch data", status: "completed" },
      { step: "Render view", status: "inProgress" },
      { step: "Ship", status: "completed" },
    ]);
  });

  it("complete without prior state returns undefined", () => {
    const result = applyTodoToolCall(
      makeToolCall({ command: "complete", completed_task_ids: ["t1"] }),
      undefined,
    );
    expect(result).toBeUndefined();
  });

  it("complete with unknown ids is a no-op but still emits the current plan", () => {
    const initial = applyTodoToolCall(
      makeToolCall({
        command: "create",
        tasks: [{ id: "t1", task_description: "Fetch" }],
      }),
      undefined,
    );
    const result = applyTodoToolCall(
      makeToolCall({ command: "complete", completed_task_ids: ["nope"] }),
      initial!.nextState,
    );
    expect(result).toBeDefined();
    expect(result!.plan.plan).toEqual([{ step: "Fetch", status: "inProgress" }]);
  });

  it("create with missing ids falls back to 1-based position keys", () => {
    const result = applyTodoToolCall(
      makeToolCall({
        command: "create",
        tasks: [{ task_description: "Task A" }, { task_description: "Task B" }],
      }),
      undefined,
    );
    expect(result).toBeDefined();
    expect(result!.plan.plan).toEqual([
      { step: "Task A", status: "inProgress" },
      { step: "Task B", status: "pending" },
    ]);
    expect(result!.nextState.get("1")).toEqual({ step: "Task A", status: "pending" });
    expect(result!.nextState.get("2")).toEqual({ step: "Task B", status: "pending" });

    // The follow-up complete with 1-based ids should now WORK.
    const completed = applyTodoToolCall(
      makeToolCall({ command: "complete", completed_task_ids: ["1"] }),
      result!.nextState,
    );
    expect(completed).toBeDefined();
    expect(completed!.plan.plan).toEqual([
      { step: "Task A", status: "completed" },
      { step: "Task B", status: "inProgress" },
    ]);
  });

  it("returns undefined for unknown commands", () => {
    const result = applyTodoToolCall(
      makeToolCall({ command: "rename", tasks: [] }),
      undefined,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when rawInput is not an object", () => {
    const result = applyTodoToolCall(makeToolCall("not-a-record"), undefined);
    expect(result).toBeUndefined();
  });

  it("falls back to Task N when task_description is missing", () => {
    const result = applyTodoToolCall(
      makeToolCall({
        command: "create",
        tasks: [{ id: "1" }, { id: "2", task_description: "  " }],
      }),
      undefined,
    );

    expect(result).toBeDefined();
    expect(result!.plan.plan).toEqual([
      { step: "Task 1", status: "inProgress" },
      { step: "Task 2", status: "pending" },
    ]);
  });

  it("returns undefined for a create with empty tasks", () => {
    const result = applyTodoToolCall(
      makeToolCall({ command: "create", tasks: [] }),
      undefined,
    );
    expect(result).toBeUndefined();
  });

  it("integrates a Kiro-shape create (no ids) + complete (1-based ids)", () => {
    // Exact payloads observed from real Kiro threads
    const initial = applyTodoToolCall(
      makeToolCall({
        command: "create",
        tasks: [
          { task_description: "Expand SPACE_COLORS" },
          { task_description: "Add buttons" },
          { task_description: "Replace grid" },
          { task_description: "Apply scroll" },
        ],
      }),
      undefined,
    );
    expect(initial!.plan.plan).toEqual([
      { step: "Expand SPACE_COLORS", status: "inProgress" },
      { step: "Add buttons", status: "pending" },
      { step: "Replace grid", status: "pending" },
      { step: "Apply scroll", status: "pending" },
    ]);

    const afterFirstComplete = applyTodoToolCall(
      makeToolCall({ command: "complete", completed_task_ids: ["1"] }),
      initial!.nextState,
    );
    expect(afterFirstComplete!.plan.plan).toEqual([
      { step: "Expand SPACE_COLORS", status: "completed" },
      { step: "Add buttons", status: "inProgress" },
      { step: "Replace grid", status: "pending" },
      { step: "Apply scroll", status: "pending" },
    ]);

    const afterCumulativeComplete = applyTodoToolCall(
      makeToolCall({ command: "complete", completed_task_ids: ["2", "3"] }),
      afterFirstComplete!.nextState,
    );
    expect(afterCumulativeComplete!.plan.plan).toEqual([
      { step: "Expand SPACE_COLORS", status: "completed" },
      { step: "Add buttons", status: "completed" },
      { step: "Replace grid", status: "completed" },
      { step: "Apply scroll", status: "inProgress" },
    ]);

    const afterLastComplete = applyTodoToolCall(
      makeToolCall({ command: "complete", completed_task_ids: ["4"] }),
      afterCumulativeComplete!.nextState,
    );
    // All done — no inProgress marker.
    expect(afterLastComplete!.plan.plan).toEqual([
      { step: "Expand SPACE_COLORS", status: "completed" },
      { step: "Add buttons", status: "completed" },
      { step: "Replace grid", status: "completed" },
      { step: "Apply scroll", status: "completed" },
    ]);
  });
});
