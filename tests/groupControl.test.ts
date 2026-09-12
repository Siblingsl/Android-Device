import { describe, expect, it } from "vitest";
import { normalizeGroupResult } from "../src/lib/groupControl";

describe("normalizeGroupResult", () => {
  it("keeps a single device failure isolated and actionable", () => {
    expect(
      normalizeGroupResult(
        { id: "d2", name: "测试设备" },
        { item: { id: "d2", name: "测试设备" }, status: "rejected", reason: "ADB 未授权" },
      ),
    ).toEqual({ id: "d2", name: "测试设备", ok: false, detail: "ADB 未授权", state: "failed" });
  });

  it("shows queued devices as cancelled instead of fake success", () => {
    expect(
      normalizeGroupResult(
        { id: "d3", name: "待执行设备" },
        { item: { id: "d3", name: "待执行设备" }, status: "cancelled" },
      ),
    ).toEqual({ id: "d3", name: "待执行设备", ok: false, detail: "已取消", state: "cancelled" });
  });

  it("does not treat an unstructured worker result as success", () => {
    expect(
      normalizeGroupResult(
        { id: "d4", name: "无返回设备" },
        { item: { id: "d4", name: "无返回设备" }, status: "fulfilled", value: undefined },
      ),
    ).toEqual({ id: "d4", name: "无返回设备", ok: false, detail: "未返回成功状态", state: "failed" });
  });
});
