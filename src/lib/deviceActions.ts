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

export interface DeviceActionOptions<T extends ShellResultLike> {
  fallback: string;
  onStart?: () => void | Promise<void>;
  onSuccess?: (result: T) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  onFinally?: () => void | Promise<void>;
}

export async function runDeviceAction<T extends ShellResultLike>(
  operation: () => Promise<T>,
  options: DeviceActionOptions<T>,
): Promise<T> {
  try {
    await options.onStart?.();
    const result = await operation();
    const failure = shellResultFailure(result, options.fallback);
    if (failure) throw new Error(failure);
    await options.onSuccess?.(result);
    return result;
  } catch (error) {
    const normalized = normalizeActionError(error, options.fallback);
    await options.onError?.(normalized);
    throw normalized;
  } finally {
    await options.onFinally?.();
  }
}

export function formatShellOutput(stdout: string, stderr: string, exitCode?: number): string {
  const lines = [stdout.trim(), stderr.trim()].filter(Boolean);
  if (exitCode !== undefined) lines.push(`[exit ${exitCode}]`);
  return lines.join("\n");
}
