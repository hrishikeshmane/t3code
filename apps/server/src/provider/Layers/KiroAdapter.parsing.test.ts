import { describe, expect, it } from "vitest";

import { RuntimeTaskId } from "@t3tools/contracts";

import {
  diffKiroSubagentRoster,
  formatSubagentToolLabel,
  parseKiroPrompts,
  parseKiroSlashCommands,
  parseKiroSubagentList,
} from "./KiroAdapter.ts";
import { parseKiroAgentListOutput } from "./KiroProvider.ts";

describe("parseKiroSlashCommands", () => {
  it("strips leading / from command names", () => {
    const result = parseKiroSlashCommands([
      { name: "/agent", description: "Run an agent task" },
      { name: "/compact", description: "Compact context" },
      { name: "tools" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]!.name).toBe("agent");
    expect(result[0]!.description).toBe("Run an agent task");
    expect(result[1]!.name).toBe("compact");
    expect(result[1]!.description).toBe("Compact context");
    expect(result[2]!.name).toBe("tools");
    expect(result[2]!.description).toBeUndefined();
  });

  it("parses inputType and hint from meta", () => {
    const result = parseKiroSlashCommands([
      { name: "/agent", meta: { inputType: "selection", hint: "Choose agent" } },
      { name: "/usage", meta: { inputType: "panel" } },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.inputType).toBe("selection");
    expect(result[0]!.input?.hint).toBe("Choose agent");
    expect(result[1]!.inputType).toBe("panel");
    expect(result[1]!.input).toBeUndefined();
  });

  it("ignores invalid inputType values", () => {
    const result = parseKiroSlashCommands([{ name: "/test", meta: { inputType: "bogus" } }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.inputType).toBeUndefined();
  });

  it("skips malformed entries", () => {
    const result = parseKiroSlashCommands([null, undefined, {}, { name: "" }, "string", 42]);
    expect(result).toHaveLength(0);
  });

  it("handles commands with no meta field", () => {
    const result = parseKiroSlashCommands([{ name: "help" }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("help");
    expect(result[0]!.inputType).toBeUndefined();
    expect(result[0]!.input).toBeUndefined();
  });

  it("handles empty array", () => {
    expect(parseKiroSlashCommands([])).toEqual([]);
  });
});

describe("parseKiroPrompts", () => {
  it("preserves prompt names verbatim including colons", () => {
    const result = parseKiroPrompts([
      { name: "agent-sop:pdd", description: "Plan-driven development" },
      { name: "fix-integration-test" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("agent-sop:pdd");
    expect(result[0]!.description).toBe("Plan-driven development");
    expect(result[1]!.name).toBe("fix-integration-test");
    expect(result[1]!.description).toBeUndefined();
  });

  it("builds a hint from required and optional arguments", () => {
    const result = parseKiroPrompts([
      {
        name: "scaffold",
        arguments: [
          { name: "path", required: true },
          { name: "template", required: false },
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.input?.hint).toBe("<path> [template]");
  });

  it("skips argument entries without a name", () => {
    const result = parseKiroPrompts([
      {
        name: "partial",
        arguments: [{ required: true }, { name: "valid", required: false }],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.input?.hint).toBe("[valid]");
  });

  it("omits hint when arguments is not an array", () => {
    const result = parseKiroPrompts([{ name: "plain" }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.input).toBeUndefined();
  });

  it("skips malformed entries", () => {
    const result = parseKiroPrompts([null, undefined, {}, { name: "" }, "string", 42]);
    expect(result).toHaveLength(0);
  });
});

describe("parseKiroAgentListOutput", () => {
  it("parses agent list with default marker", () => {
    const output = [
      "Global:",
      "* kiro_default            (Built-in)    Default agent",
      "  amzn-builder            Global        Amazon builder agent",
      "",
    ].join("\n");
    const agents = parseKiroAgentListOutput(output);
    expect(agents).toHaveLength(2);
    expect(agents[0]!.name).toBe("kiro_default");
    expect(agents[0]!.isDefault).toBe(true);
    expect(agents[0]!.scope).toBe("Built-in");
    expect(agents[0]!.description).toBe("Default agent");
    expect(agents[1]!.name).toBe("amzn-builder");
    expect(agents[1]!.isDefault).toBeUndefined();
    expect(agents[1]!.scope).toBe("Global");
    expect(agents[1]!.description).toBe("Amazon builder agent");
  });

  it("strips ANSI escape codes", () => {
    const output = "\x1b[1m* kiro_default\x1b[0m            (Built-in)    Default\n";
    const agents = parseKiroAgentListOutput(output);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("kiro_default");
    expect(agents[0]!.isDefault).toBe(true);
    expect(agents[0]!.description).toBe("Default");
  });

  it("returns empty array for empty input", () => {
    expect(parseKiroAgentListOutput("")).toEqual([]);
  });

  it("skips Workspace: and Global: header lines", () => {
    const output = [
      "Workspace:",
      "  some-agent            Workspace        My agent",
      "Global:",
      "  another            Global        Other",
      "",
    ].join("\n");
    const agents = parseKiroAgentListOutput(output);
    expect(agents).toHaveLength(2);
    expect(agents[0]!.name).toBe("some-agent");
    expect(agents[0]!.scope).toBe("Workspace");
    expect(agents[0]!.description).toBe("My agent");
    expect(agents[1]!.name).toBe("another");
    expect(agents[1]!.scope).toBe("Global");
    expect(agents[1]!.description).toBe("Other");
  });

  it("handles agents with no description", () => {
    const output = "* kiro_default            (Built-in)\n";
    const agents = parseKiroAgentListOutput(output);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("kiro_default");
    expect(agents[0]!.description).toBeUndefined();
  });
});

describe("parseKiroSubagentList", () => {
  it("extracts sessionId, names, and status", () => {
    const result = parseKiroSubagentList({
      subagents: [
        {
          sessionId: "s1",
          sessionName: "sdk-serialization",
          agentName: "codebase-explorer",
          status: { type: "working", message: "Running" },
          group: "crew-1",
          role: "codebase-explorer",
          dependsOn: [],
        },
        {
          sessionId: "s2",
          sessionName: "cli-serialization",
          agentName: "codebase-explorer",
          status: { type: "terminated" },
        },
      ],
      pendingStages: [],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      sessionId: "s1",
      sessionName: "sdk-serialization",
      agentName: "codebase-explorer",
      statusType: "working",
    });
    expect(result[1]!.statusType).toBe("terminated");
  });

  it("falls back to sessionId when sessionName is missing", () => {
    const result = parseKiroSubagentList({
      subagents: [{ sessionId: "abc", status: { type: "working" } }],
    });
    expect(result[0]!.sessionName).toBe("abc");
    expect(result[0]!.agentName).toBe("subagent");
  });

  it("treats unknown status shapes as 'unknown'", () => {
    const result = parseKiroSubagentList({
      subagents: [{ sessionId: "x", status: { type: "mystery" } }],
    });
    expect(result[0]!.statusType).toBe("unknown");
  });

  it("skips entries missing sessionId", () => {
    const result = parseKiroSubagentList({
      subagents: [{ sessionName: "no-id", status: { type: "working" } }, null, "string"],
    });
    expect(result).toHaveLength(0);
  });

  it("returns [] for non-object input", () => {
    expect(parseKiroSubagentList(null)).toEqual([]);
    expect(parseKiroSubagentList({ subagents: "nope" })).toEqual([]);
  });
});

describe("diffKiroSubagentRoster", () => {
  const trackedWorking = () =>
    new Map([
      [
        "s1",
        {
          taskId: RuntimeTaskId.make("s1"),
          sessionName: "sdk-serialization",
          agentName: "codebase-explorer",
          statusType: "working" as const,
          seenToolCallIds: new Set<string>(),
        },
      ],
    ]);

  it("emits 'started' for a new working entry", () => {
    const changes = diffKiroSubagentRoster(new Map(), [
      {
        sessionId: "s1",
        sessionName: "sdk",
        agentName: "codebase-explorer",
        statusType: "working",
      },
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("started");
  });

  it("emits 'completed' when a tracked entry transitions to terminated", () => {
    const changes = diffKiroSubagentRoster(trackedWorking(), [
      { sessionId: "s1", sessionName: "sdk", agentName: "x", statusType: "terminated" },
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("completed");
  });

  it("emits 'completed' when a tracked entry disappears from the roster", () => {
    const changes = diffKiroSubagentRoster(trackedWorking(), []);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("completed");
  });

  it("does not re-emit 'started' for already-tracked entries", () => {
    const changes = diffKiroSubagentRoster(trackedWorking(), [
      { sessionId: "s1", sessionName: "sdk", agentName: "x", statusType: "working" },
    ]);
    expect(changes).toHaveLength(0);
  });

  it("does not re-emit 'completed' for already-terminated entries", () => {
    const tracked = new Map([
      [
        "s1",
        {
          taskId: RuntimeTaskId.make("s1"),
          sessionName: "sdk",
          agentName: "x",
          statusType: "terminated" as const,
          seenToolCallIds: new Set<string>(),
        },
      ],
    ]);
    const changes = diffKiroSubagentRoster(tracked, [
      { sessionId: "s1", sessionName: "sdk", agentName: "x", statusType: "terminated" },
    ]);
    expect(changes).toHaveLength(0);
  });
});

describe("formatSubagentToolLabel", () => {
  it("combines presentation title with its payload detail", () => {
    expect(formatSubagentToolLabel({ title: "Ran command", detail: "bun test" })).toBe(
      "Ran command: bun test",
    );
    expect(formatSubagentToolLabel({ title: "Read file", detail: "src/foo.ts" })).toBe(
      "Read file: src/foo.ts",
    );
    expect(formatSubagentToolLabel({ title: "Searched files", detail: "useState" })).toBe(
      "Searched files: useState",
    );
  });

  it("falls back to command when detail is missing", () => {
    expect(formatSubagentToolLabel({ title: "Ran command", command: "ls -la" })).toBe(
      "Ran command: ls -la",
    );
  });

  it("returns the title alone when no detail is available", () => {
    expect(formatSubagentToolLabel({ title: "Summarizing" })).toBe("Summarizing");
  });

  it("returns the detail alone when no title is available", () => {
    expect(formatSubagentToolLabel({ detail: "apps/server/foo.ts" })).toBe(
      "apps/server/foo.ts",
    );
  });

  it("does not duplicate when title and detail are identical", () => {
    expect(formatSubagentToolLabel({ title: "Summarizing", detail: "Summarizing" })).toBe(
      "Summarizing",
    );
  });

  it("falls through to kind when everything else is empty", () => {
    expect(formatSubagentToolLabel({ kind: "execute" })).toBe("execute");
  });

  it("returns 'Working' as a last-resort fallback", () => {
    expect(formatSubagentToolLabel({})).toBe("Working");
  });

  it("trims whitespace on all inputs", () => {
    expect(formatSubagentToolLabel({ title: "  Ran command  ", detail: "  ls  " })).toBe(
      "Ran command: ls",
    );
  });
});
