import { describe, expect, it } from "vitest";
import { createRequestSequence } from "./requestSequence";

describe("request sequence", () => {
  it("accepts only the newest request token", () => {
    const sequence = createRequestSequence();
    const first = sequence.begin();
    const second = sequence.begin();

    expect(sequence.isCurrent(first)).toBe(false);
    expect(sequence.isCurrent(second)).toBe(true);
  });

  it("invalidates pending work when the owner is disposed", () => {
    const sequence = createRequestSequence();
    const token = sequence.begin();

    sequence.invalidate();

    expect(sequence.isCurrent(token)).toBe(false);
  });
});
