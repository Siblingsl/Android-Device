/**
 * Track selection for the merged containers page (`/containers`).
 *
 * Resolution priority (decided in the page-merge spec, §6.1):
 *   URL `?track=`  >  remembered choice (`AppSettings.defaultTrack`)  >  docker
 *
 * The remembered choice reuses the existing settings preference instead of a
 * second localStorage key: `defaultTrack` is already persisted by the backend
 * settings layer (same channel as the theme/language preferences) and is what
 * the Settings page "运行轨道" card edits, so both surfaces stay one source of
 * truth. No new backend command or field is introduced.
 */

/** Route of the merged page. */
export const RUNTIME_ROUTE = "/containers";

export const RUNTIME_TRACKS = ["docker", "qemu"] as const;

export type RuntimeTrack = (typeof RUNTIME_TRACKS)[number];

/** First-visit fallback (spec §6.1: "首次兜底「本机 Docker」"). */
export const FALLBACK_RUNTIME_TRACK: RuntimeTrack = "docker";

/** Any stored/typed string → a known track, or null when unusable. */
export function normalizeRuntimeTrack(value: string | null | undefined): RuntimeTrack | null {
  return value === "docker" || value === "qemu" ? value : null;
}

/** `?track=` wins, then the remembered choice, then the fallback. */
export function resolveRuntimeTrack(
  trackParam: string | null | undefined,
  rememberedTrack: string | null | undefined,
): RuntimeTrack {
  return (
    normalizeRuntimeTrack(trackParam) ??
    normalizeRuntimeTrack(rememberedTrack) ??
    FALLBACK_RUNTIME_TRACK
  );
}

/**
 * What a track panel reports upwards while it runs a long task (merge spec
 * §6.4). The shell uses it to decide the mount strategy and to label the
 * background-task bar; the label is already localized by the panel, which owns
 * its own `docker.*` / `qemu.*` namespace.
 */
export type TrackTaskInfo = {
  /** Short description of what is running, e.g. "正在探测 Docker…". */
  label: string;
};

/**
 * Legacy runtime route → merged-page link.
 *
 * For navigation targets that are not literals in our own JSX: the Dashboard's
 * first-use checklist navigates to `ReadinessItem.cta`, which the backend
 * (`src-tauri/src/services/readiness.rs`) still emits as `/docker` / `/qemu`.
 * Resolving it here keeps every in-app click on the merged route (P4) while the
 * redirects in `App.tsx` stay reserved for bookmarks and external docs.
 * Any other target is returned untouched.
 */
export function resolveRuntimeLink(to: string): string {
  const track = to === "/docker" || to === "/qemu" ? (to.slice(1) as RuntimeTrack) : null;
  return track ? `${RUNTIME_ROUTE}?track=${track}` : to;
}
