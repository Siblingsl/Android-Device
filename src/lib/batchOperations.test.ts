import { describe, expect, it } from "vitest";
import { batchFileName, batchRemotePath } from "./batchOperations";

describe("batch file operations", () => {
  it("keeps the local file name when building a remote destination", () => {
    expect(batchFileName("C:\\payload\\one.txt")).toBe("one.txt");
    expect(batchRemotePath("/sdcard/Download/", "C:\\payload\\one.txt")).toBe(
      "/sdcard/Download/one.txt",
    );
  });

  it("normalizes an empty or root remote directory safely", () => {
    expect(batchRemotePath("", "C:\\payload\\two.txt")).toBe(
      "/sdcard/Download/two.txt",
    );
    expect(batchRemotePath("/", "C:\\payload\\two.txt")).toBe("/two.txt");
  });
});
