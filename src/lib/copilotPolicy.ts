export const COPILOT_POLICY_STORAGE_KEY = "rdc.copilot.policy";

export interface CopilotPolicyState {
  allowedToolIds: string[];
}

export function readCopilotPolicy(defaultToolIds: string[]): CopilotPolicyState {
  try {
    const raw = localStorage.getItem(COPILOT_POLICY_STORAGE_KEY);
    if (!raw) return { allowedToolIds: [...defaultToolIds] };
    const parsed = JSON.parse(raw) as Partial<CopilotPolicyState>;
    return {
      allowedToolIds: Array.isArray(parsed.allowedToolIds)
        ? parsed.allowedToolIds.filter((id): id is string => typeof id === "string")
        : [...defaultToolIds],
    };
  } catch {
    return { allowedToolIds: [...defaultToolIds] };
  }
}

export function writeCopilotPolicy(state: CopilotPolicyState): void {
  try {
    localStorage.setItem(COPILOT_POLICY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* local persistence is best effort */
  }
}
