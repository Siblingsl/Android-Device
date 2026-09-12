export interface AgentProfile {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

export type AgentSessionStatus = "planned" | "confirmed" | "rejected" | "success" | "failed";

export interface AgentSession {
  id: string;
  deviceId: string;
  deviceName: string;
  prompt: string;
  tool?: string;
  reason?: string;
  arguments?: Record<string, unknown>;
  status: AgentSessionStatus;
  output?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileState {
  selectedId: string;
  profiles: AgentProfile[];
}

export const AGENT_PROFILES_KEY = "rdc.agent-profiles.v1";
export const AGENT_CONFIG_KEY = "rdc.agent-config.v1";
export const AGENT_SESSIONS_KEY = "rdc.agent-sessions.v1";

const fallbackProfile: AgentProfile = {
  id: "default",
  name: "默认配置",
  endpoint: "",
  model: "",
  apiKey: "",
};

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function normalizeAgentProfile(value: unknown, index = 0): AgentProfile {
  const item = value && typeof value === "object" ? value as Partial<AgentProfile> : {};
  const id = stringValue(item.id).trim() || `profile-${index + 1}`;
  return {
    id,
    name: stringValue(item.name).trim() || (index === 0 ? fallbackProfile.name : `配置 ${index + 1}`),
    endpoint: stringValue(item.endpoint),
    model: stringValue(item.model),
    apiKey: stringValue(item.apiKey),
  };
}

export function parseAgentProfileState(raw: string | null, legacyRaw: string | null = null): AgentProfileState {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const source = parsed && typeof parsed === "object" ? parsed as Partial<AgentProfileState> : {};
  let profiles = Array.isArray(source.profiles)
    ? source.profiles.map((item, index) => normalizeAgentProfile(item, index))
    : [];
  if (!profiles.length) {
    let legacy: unknown;
    try { legacy = legacyRaw ? JSON.parse(legacyRaw) : null; } catch { legacy = null; }
    profiles = [normalizeAgentProfile({ ...fallbackProfile, ...(legacy && typeof legacy === "object" ? legacy : {}) }, 0)];
  }
  const unique = new Map<string, AgentProfile>();
  profiles.forEach((profile, index) => {
    let id = profile.id;
    while (unique.has(id)) id = `${profile.id}-${index + 1}`;
    unique.set(id, { ...profile, id });
  });
  const normalized = [...unique.values()];
  const selectedId = normalized.some((profile) => profile.id === source.selectedId)
    ? String(source.selectedId)
    : normalized[0].id;
  return { selectedId, profiles: normalized };
}

export function serializeAgentProfileState(state: AgentProfileState) {
  return JSON.stringify({
    selectedId: state.selectedId,
    profiles: state.profiles.map((profile) => normalizeAgentProfile(profile)),
  });
}

export function parseAgentSessions(raw: string | null, limit = 50): AgentSession[] {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : []; } catch { parsed = []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is AgentSession => Boolean(item && typeof item === "object"))
    .map((item) => item as AgentSession)
    .filter((item) => typeof item.id === "string" && typeof item.prompt === "string" && typeof item.status === "string")
    .slice(-Math.max(1, limit));
}

export function upsertAgentSession(sessions: AgentSession[], session: AgentSession, limit = 50) {
  const next = [...sessions.filter((item) => item.id !== session.id), session];
  return next.slice(-Math.max(1, limit));
}

export function serializeAgentSessions(sessions: AgentSession[]) {
  return JSON.stringify(sessions.slice(-50));
}

export function createAgentSessionId(now = Date.now()) {
  return `agent-${now}-${Math.random().toString(36).slice(2, 8)}`;
}
