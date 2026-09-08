const blockedTargetTags = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

export function validateDeviceText(value: string, emptyMessage: string): string | null {
  return value.trim() ? null : emptyMessage;
}

export type ScreenShortcut = "home" | "back" | "recent" | "wake" | "lock";

export function shortcutForScreenKey(event: KeyboardEvent): ScreenShortcut | null {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return null;
  }

  const target = event.target as HTMLElement | null;
  const tagName = target?.tagName?.toUpperCase();
  if (tagName && blockedTargetTags.has(tagName)) return null;

  const shortcuts: Record<string, ScreenShortcut> = {
    Home: "home",
    Escape: "back",
    End: "recent",
    WakeUp: "wake",
    ScrollLock: "lock",
  };
  return shortcuts[event.key] || null;
}
