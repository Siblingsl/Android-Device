import { describe, expect, it } from "vitest";
import { isRetryableControlAction, prependControlFeedback, type ControlFeedback } from "./controlFeedback";

const feedback = (id: number): ControlFeedback => ({
  id,
  action: `action-${id}`,
  status: "success",
  message: "ok",
  at: id,
  retryable: false,
});

describe("controlFeedback", () => {
  it("allows retry only for repeatable device actions", () => {
    expect(isRetryableControlAction("home")).toBe(true);
    expect(isRetryableControlAction("screenshot")).toBe(true);
    expect(isRetryableControlAction("power")).toBe(false);
    expect(isRetryableControlAction("tap")).toBe(false);
    expect(isRetryableControlAction("text")).toBe(false);
  });

  it("prepends new feedback and keeps the newest five entries", () => {
    const result = prependControlFeedback(
      [feedback(5), feedback(4), feedback(3), feedback(2), feedback(1)],
      feedback(6),
    );
    expect(result.map((item) => item.id)).toEqual([6, 5, 4, 3, 2]);
  });
});
