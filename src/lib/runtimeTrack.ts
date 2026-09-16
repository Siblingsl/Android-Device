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
 * Read-only source snapshots behind the merged page's badges (merge spec §6.8).
 *
 * Written by each track panel from data it already loaded — the shell never
 * calls `docker_*` / `qemu_*` and never triggers a probe, it only renders what
 * is in the cache. Every field is deliberately "unknown-able" (`null`): the
 * badge must state a reason instead of a made-up `0` when a source is
 * unavailable ("Docker 未启动" / "CLI 缺失" / "未读取").
 */
export type DockerSourceReading = {
  /** Epoch ms of the read this snapshot came from. */
  at: number;
  /** `docker info` reachable and reporting a running engine. */
  running: boolean | null;
  /** Containers reported by `docker info`; only meaningful when `running`. */
  containers: number | null;
  /** Tool probe for the Docker CLI (`probeTool`). */
  cliAvailable: boolean | null;
  /** WSL/binder kernel readiness, `null` when the host has no WSL strategy. */
  kernelBinderEnabled: boolean | null;
};

/** One host check tally of the QEMU `doctor` report (the cached 八项). */
export type QemuCheckTally = {
  /** Timestamp of the check itself, not of this snapshot. */
  at: number;
  total: number;
  ok: number;
  fail: number;
  /** Checks with `status` neither `ok` nor `fail`. */
  other: number;
};

export type QemuSourceReading = {
  /** Epoch ms of the node-list read this snapshot came from (`0` = never). */
  at: number;
  /** Nodes from `vm list`, `null` until that read succeeded once. */
  nodes: number | null;
  /** Instances of `scope` from `redroid list`; `null` = not loaded. */
  instances: number | null;
  /** Node the instance count belongs to (the panel's selected node). */
  scope: string;
  /** Cached `doctor` result, `null` until the track ran one. */
  checks: QemuCheckTally | null;
  /** Last doctor failure, i.e. "CLI 缺失" with the raw text as the tooltip. */
  cliError: string;
};

/** DOM ids wiring the shell's tablist to the panel roots (P5, a11y). */
export function tabDomId(track: RuntimeTrack): string {
  return `runtime-tab-${track}`;
}

export function panelDomId(track: RuntimeTrack): string {
  return `runtime-panel-${track}`;
}

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
