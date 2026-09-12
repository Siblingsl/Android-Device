/** Remove only the newline added by the ADB clipboard transport. */
export function normalizeClipboardText(value: string) {
  return value.replace(/\r?\n$/, "");
}
