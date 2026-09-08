import { describe, expect, it } from "vitest";
import { controlBusyState } from "./controlBusy";

describe("controlBusyState", () => {
  it("marks the active control as loading and all controls as locked", () => {
    expect(controlBusyState("home", "home")).toEqual({ disabled: true, loading: true });
    expect(controlBusyState("home", "back")).toEqual({ disabled: true, loading: false });
  });

  it("keeps controls enabled when no action is active", () => {
    expect(controlBusyState(null, "screenshot")).toEqual({ disabled: false, loading: false });
  });
});
