import type { QueueItemResult } from "../types";

export interface GroupDevice {
  id: string;
  name: string;
}

export interface GroupResult {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  state: "success" | "failed" | "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeGroupResult(
  device: GroupDevice,
  result: QueueItemResult<GroupDevice, unknown>,
): GroupResult {
  if (result.status === "cancelled") {
    return { id: device.id, name: device.name, ok: false, detail: "已取消", state: "cancelled" };
  }
  if (result.status === "rejected") {
    return { id: device.id, name: device.name, ok: false, detail: result.reason || "执行失败", state: "failed" };
  }
  const output = isRecord(result.value) ? result.value : {};
  const hasSuccess = typeof output.success === "boolean";
  const ok = hasSuccess ? Boolean(output.success) : false;
  const stdout = typeof output.stdout === "string" ? output.stdout.trim() : "";
  const stderr = typeof output.stderr === "string" ? output.stderr.trim() : "";
  return {
    id: device.id,
    name: device.name,
    ok,
    detail: ok ? stdout || "已完成" : stderr || stdout || "未返回成功状态",
    state: ok ? "success" : "failed",
  };
}
