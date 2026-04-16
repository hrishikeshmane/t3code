import { describe, expect, it } from "vitest";

import { parseKiroSlashCommands } from "./KiroAdapter.ts";
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
