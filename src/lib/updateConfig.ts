export function isUpdaterConfigured(flag: string | undefined): boolean {
  return flag === "1";
}

export function updateStateAfterCancellation() {
  return { state: "idle" as const, progress: 0, message: "已取消更新下载" };
}
