export type FileClipboardMode = "copy" | "cut";

export interface FileClipboard {
  mode: FileClipboardMode;
  paths: string[];
}

export function normalizeRemotePath(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/");
  if (!value) return "/";
  const absolute = value.startsWith("/") ? value : `/${value}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}` || "/";
}

export function remoteChildPath(parent: string, name: string): string {
  const cleanName = name.trim().replace(/[\\/]/g, "");
  if (!cleanName || cleanName === "." || cleanName === "..") return normalizeRemotePath(parent);
  const base = normalizeRemotePath(parent);
  return base === "/" ? `/${cleanName}` : `${base}/${cleanName}`;
}

export function remoteBaseName(path: string): string {
  const normalized = normalizeRemotePath(path);
  return normalized === "/" ? "/" : normalized.split("/").pop() || "/";
}

function quoteShell(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function quoteRemotePath(path: string): string {
  return quoteShell(normalizeRemotePath(path));
}

export function remoteFileCommand(
  action: "copy" | "move" | "touch" | "read" | "write",
  source: string,
  target?: string,
  contentBase64?: string,
): string {
  const quotedSource = quoteRemotePath(source);
  if (action === "copy") return `cp -R ${quotedSource} ${quoteRemotePath(target || "/")}`;
  if (action === "move") return `mv ${quotedSource} ${quoteRemotePath(target || "/")}`;
  if (action === "touch") return `touch ${quotedSource}`;
  if (action === "read") return `cat ${quotedSource}`;
  return `printf '%s' ${quoteShell(contentBase64 || "")} | base64 -d > ${quotedSource}`;
}

export function dialogPaths(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
