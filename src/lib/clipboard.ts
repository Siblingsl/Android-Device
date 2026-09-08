/**
 * Copy text through the WebView's native clipboard when available, with a
 * legacy DOM fallback for environments that do not expose clipboard access.
 */
export async function copyText(text: string): Promise<void> {
  let nativeError: unknown;
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      nativeError = error;
    }
  }

  if (typeof document !== "undefined") {
    const root = document.body ?? document.documentElement;
    if (root) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.setAttribute("aria-hidden", "true");
      textarea.style.position = "fixed";
      textarea.style.top = "-1000px";
      textarea.style.left = "-1000px";
      textarea.style.opacity = "0";
      root.appendChild(textarea);

      try {
        textarea.select();
        if (document.execCommand("copy")) return;
      } catch {
        /* fall through to the native error or a generic unavailable error */
      } finally {
        textarea.remove();
      }
    }
  }

  if (nativeError instanceof Error) throw nativeError;
  throw new Error("Clipboard copy unavailable");
}
