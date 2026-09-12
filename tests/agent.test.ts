import { describe, expect, it } from "vitest";
import {
  parseAgentProfileState,
  parseAgentSessions,
  serializeAgentProfileState,
  upsertAgentSession,
  type AgentSession,
} from "../src/lib/agent";

describe("agent profiles and sessions", () => {
  it("migrates the previous single AI config into a selectable profile", () => {
    const state = parseAgentProfileState(null, JSON.stringify({ endpoint: "http://localhost", model: "demo", apiKey: "secret" }));
    expect(state.selectedId).toBe(state.profiles[0].id);
    expect(state.profiles[0]).toMatchObject({ endpoint: "http://localhost", model: "demo", apiKey: "secret" });
  });

  it("deduplicates profile ids and keeps the selected profile valid", () => {
    const state = parseAgentProfileState(JSON.stringify({ selectedId: "missing", profiles: [{ id: "same", name: "A" }, { id: "same", name: "B" }] }));
    expect(state.profiles).toHaveLength(2);
    expect(new Set(state.profiles.map((item) => item.id)).size).toBe(2);
    expect(state.selectedId).toBe(state.profiles[0].id);
    expect(JSON.parse(serializeAgentProfileState(state)).profiles).toHaveLength(2);
  });

  it("upserts bounded task sessions and ignores malformed stored entries", () => {
    const valid: AgentSession = { id: "a", deviceId: "d", deviceName: "设备", prompt: "截图", tool: "screenshot", status: "planned", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const updated = { ...valid, status: "success" as const, output: "完成", updatedAt: "2026-01-01T00:01:00.000Z" };
    expect(parseAgentSessions(JSON.stringify([{ nope: true }, valid]))).toEqual([valid]);
    expect(upsertAgentSession([valid], updated)).toEqual([updated]);
  });
});
