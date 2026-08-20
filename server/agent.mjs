export const AGENTS = Object.freeze(["claude", "codex", "grok"]);
export const DEFAULT_AGENT = "claude";

const AGENT_SET = new Set(AGENTS);
const ISOLATED_AGENTS = new Set(["codex", "grok"]);

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
      "Select Claude, Codex, or Grok for this run.",
    );
  }
  return selected;
}

export function agentLabel(agent) {
  const selected = validateAgent(agent);
  if (selected === "codex") return "Codex";
  if (selected === "grok") return "Grok";
  return "Claude Code";
}

export function isIsolatedAgent(agent) {
  return ISOLATED_AGENTS.has(agent);
}

export function interruptSignal(agent) {
  return isIsolatedAgent(agent) ? "SIGINT" : "SIGTERM";
}

export function followupSignal(agent) {
  return isIsolatedAgent(agent) ? "SIGTERM" : "SIGKILL";
}

export function migrateAgent(value) {
  return value === undefined ? DEFAULT_AGENT : validateAgent(value);
}
