import { describe, expect, it } from "vitest";

import {
  agentLabel,
  AgentError,
  migrateAgent,
  validateAgent,
} from "../agent.mjs";

describe("agent contract", () => {
  it.each([
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["grok", "Grok"],
  ])("accepts %s", (agent, label) => {
    expect(validateAgent(agent)).toBe(agent);
    expect(agentLabel(agent)).toBe(label);
  });

  it("defaults only explicit legacy and migrated records to Claude", () => {
    expect(validateAgent(undefined, { legacy: true })).toBe("claude");
    expect(migrateAgent(undefined)).toBe("claude");
    expect(() => validateAgent(undefined)).toThrow(AgentError);
  });

  it.each(["", "Codex", "claude-code", null, 1, {}])(
    "rejects an invalid agent",
    (agent) => {
      expect(() => validateAgent(agent)).toThrow(
        "Select Claude, Codex, or Grok",
      );
    },
  );
});
