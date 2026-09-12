export function batchFileName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized;
}

export function batchRemotePath(directory: string, localPath: string): string {
  const name = batchFileName(localPath);
  const raw = directory.trim().replace(/\\/g, "/");
  if (!raw) return `/sdcard/Download/${name}`;
  if (raw === "/") return `/${name}`;
  const normalized = raw.replace(/\/+$/, "");
  return `${normalized}/${name}`;
}
