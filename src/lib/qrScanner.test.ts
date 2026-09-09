import { describe, expect, it, vi } from "vitest";

vi.mock("jsqr", () => ({
  default: vi.fn(() => ({ data: "WIFI:T:ADB;S:phone;P:515109;;" })),
}));

import { decodeQrImageData } from "./qrScanner";

describe("QR scanner helpers", () => {
  it("returns the decoded payload from image pixels", () => {
    expect(decodeQrImageData(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBe("WIFI:T:ADB;S:phone;P:515109;;");
  });
});
