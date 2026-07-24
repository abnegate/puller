export const AGENTS = Object.freeze(["claude", "codex"]);
export const DEFAULT_AGENT = "claude";

const AGENT_SET = new Set(AGENTS);

export class AgentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AgentError";
    this.status = status;
    this.code = code;
  }
}

export function validateAgent(value, { legacy = false } = {}) {
  const selected = value === undefined && legacy ? DEFAULT_AGENT : value;
  if (typeof selected !== "string" || !AGENT_SET.has(selected)) {
    throw new AgentError(
      400,
      "agent_invalid",
      "Select Claude or Codex for this run.",
    );
  }
  return selected;
}

export function agentLabel(agent) {
  return validateAgent(agent) === "codex" ? "Codex" : "Claude Code";
}

export function migrateAgent(value) {
  return value === undefined ? DEFAULT_AGENT : validateAgent(value);
}
