const storageKey = (serial: string) => `rdc.files.path.${serial}`;

export function readInitialPath(
  serial: string,
  storage: Storage | undefined = typeof sessionStorage === "undefined" ? undefined : sessionStorage,
): string {
  try {
    return storage?.getItem(storageKey(serial)) || "/sdcard";
  } catch {
    return "/sdcard";
  }
}
