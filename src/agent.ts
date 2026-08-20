import { useCallback, useSyncExternalStore } from "react";

import type { Agent } from "./types";

export const AGENT_STORAGE_KEY = "puller.agent.v1";

const CHANGE_EVENT = "puller:agent-change";
const VERSION = 1;
const DEFAULT_AGENT: Agent = "claude";
let snapshot: Agent = DEFAULT_AGENT;
let storageReference: Storage | null = null;
let memoryOnly = false;

type StoredAgent = {
  agent: Agent;
  version: typeof VERSION;
};

export const isAgent = (value: unknown): value is Agent =>
  value === "claude" || value === "codex" || value === "grok";

export const normalizeAgent = (value: unknown): Agent =>
  isAgent(value) ? value : DEFAULT_AGENT;

export const agentLabel = (agent: unknown): string => {
  const selected = normalizeAgent(agent);
  if (selected === "codex") return "Codex";
  if (selected === "grok") return "Grok";
  return "Claude";
};

export const agentProductLabel = (agent: unknown): string => {
  const selected = normalizeAgent(agent);
  if (selected === "codex") return "Codex";
  if (selected === "grok") return "Grok";
  return "Claude Code";
};

const parseAgent = (raw: string | null): Agent => {
  if (raw === null) return DEFAULT_AGENT;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === VERSION &&
      "agent" in value
    ) {
      return normalizeAgent(value.agent);
    }
  } catch {
    // Malformed storage safely falls back to Claude.
  }
  return DEFAULT_AGENT;
};

const storage = (): Storage | null => {
  if (typeof window === "undefined") return null;
  try {
    const current = window.localStorage;
    if (storageReference !== current) {
      storageReference = current;
      snapshot = DEFAULT_AGENT;
      memoryOnly = false;
    }
    return current;
  } catch {
    return null;
  }
};

const readAgent = (): Agent => {
  if (typeof window === "undefined") return DEFAULT_AGENT;
  const current = storage();
  if (current === null || memoryOnly) return snapshot;
  try {
    snapshot = parseAgent(current.getItem(AGENT_STORAGE_KEY));
  } catch {
    // Keep the last known in-memory value when storage cannot be read.
  }
  return snapshot;
};

const subscribe = (notify: () => void): (() => void) => {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== AGENT_STORAGE_KEY) return;
    storage();
    snapshot = event.key === null ? DEFAULT_AGENT : parseAgent(event.newValue);
    memoryOnly = false;
    notify();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, notify);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, notify);
  };
};

export const setAgentPreference = (agent: Agent): void => {
  const current = storage();
  snapshot = agent;
  memoryOnly = true;
  const value: StoredAgent = { agent, version: VERSION };
  if (current !== null) {
    try {
      if (agent === DEFAULT_AGENT) current.removeItem(AGENT_STORAGE_KEY);
      else current.setItem(AGENT_STORAGE_KEY, JSON.stringify(value));
      memoryOnly = false;
    } catch {
      // The in-memory preference remains authoritative for this page.
    }
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export const useAgentPreference = (): {
  agent: Agent;
  setAgent: (agent: Agent) => void;
} => {
  const agent = useSyncExternalStore(subscribe, readAgent, () => DEFAULT_AGENT);
  const setAgent = useCallback((value: Agent) => {
    setAgentPreference(value);
  }, []);
  return { agent, setAgent };
};
