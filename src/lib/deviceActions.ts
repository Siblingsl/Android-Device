export type ShellResultLike = {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export function shellResultFailure(result: ShellResultLike, fallback: string): string | null {
  if (result.success) return null;
  return (result.stderr || result.stdout || fallback).trim() || fallback;
}

export function normalizeActionError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.trim()) return error;
  const message = String(error ?? "").trim();
  return new Error(message || fallback);
}
