import { describe, expect, it } from "vitest";
import {
  dialogPaths,
  encodeUtf8Base64,
  normalizeRemotePath,
  quoteRemotePath,
  remoteBaseName,
  remoteChildPath,
  remoteFileCommand,
} from "./fileManager";

describe("file manager helpers", () => {
  it("normalizes remote paths without allowing traversal", () => {
    expect(normalizeRemotePath("sdcard/Download/../Pictures")).toBe("/sdcard/Pictures");
    expect(remoteChildPath("/sdcard", "report.txt")).toBe("/sdcard/report.txt");
    expect(remoteBaseName("/sdcard/report.txt")).toBe("report.txt");
  });

  it("quotes shell paths and preserves apostrophes", () => {
    expect(quoteRemotePath("/sdcard/A'B.txt")).toBe("'/sdcard/A'\"'\"'B.txt'");
    expect(remoteFileCommand("copy", "/sdcard/a", "/sdcard/b")).toBe("cp -R '/sdcard/a' '/sdcard/b'");
    expect(remoteFileCommand("write", "/sdcard/a", undefined, "aGk=")).toContain("base64 -d");
  });

  it("normalizes single and multi-select dialog results", () => {
    expect(dialogPaths("C:/a.txt")).toEqual(["C:/a.txt"]);
    expect(dialogPaths(["C:/a.txt", "", 2])).toEqual(["C:/a.txt"]);
    expect(dialogPaths(null)).toEqual([]);
    expect(encodeUtf8Base64("你好")).toBe("5L2g5aW9");
  });
});
