export type ShellHistoryDirection = "up" | "down";

export interface ShellHistoryState {
  index: number;
  value: string;
}

/**
 * Navigate a newest-first shell history. An index of -1 means the input is
 * showing the user's unsent draft rather than a history entry.
 */
export function navigateShellHistory(
  history: string[],
  index: number,
  draft: string,
  direction: ShellHistoryDirection,
): ShellHistoryState {
  if (!history.length) return { index: -1, value: draft };

  if (direction === "up") {
    const nextIndex = index < history.length - 1 ? index + 1 : index;
    return { index: nextIndex, value: history[nextIndex] ?? draft };
  }

  if (index < 0) return { index: -1, value: draft };
  const nextIndex = index - 1;
  return nextIndex < 0
    ? { index: -1, value: draft }
    : { index: nextIndex, value: history[nextIndex] ?? draft };
}
