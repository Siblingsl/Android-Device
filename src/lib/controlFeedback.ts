export type ControlFeedbackStatus = "success" | "error";

export interface ControlFeedback {
  id: number;
  action: string;
  status: ControlFeedbackStatus;
  message: string;
  at: number;
  retryable: boolean;
  retry?: () => void | Promise<void>;
}

const RETRYABLE_ACTIONS = new Set([
  "home",
  "back",
  "recent",
  "wake",
  "lock",
  "volup",
  "voldown",
  "notify",
  "settings",
  "rotate",
  "screenshot",
]);

export function isRetryableControlAction(action: string): boolean {
  return RETRYABLE_ACTIONS.has(action);
}

export function prependControlFeedback(
  items: ControlFeedback[],
  item: ControlFeedback,
  limit = 5,
): ControlFeedback[] {
  return [item, ...items].slice(0, Math.max(0, limit));
}
