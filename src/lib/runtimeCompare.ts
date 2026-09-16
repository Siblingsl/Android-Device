/**
 * Cross-track comparison view (merge spec §6.8, P6) — pure read-only aggregation.
 *
 * Input: the two session snapshots the track panels publish into
 * `appStore.runtimeSources`. Output: Android-version groups whose metric cells
 * are either a value the snapshot actually carries, or a stated reason such as
 * `不可用（本次读取无指标）` / `Docker 未启动` / `CLI 缺失` / `未读取` — never
 * a made-up `0`.
 *
 * Nothing in this module (or in `pages/containers/RuntimeCompare.tsx`) calls a
 * service or schedules a timer: the data is whatever the panels' own existing
 * read-only loads already published, and a refresh is the user asking a panel
 * to re-run that load (the shell's `refreshSignal` delegation).
 *
 * 指标来源表 (see `COMPARE_METRICS` / `RESOURCE_METRICS`):
 *   - 实例数 / 运行中 ← `DockerSourceReading.instances` (from
 *     `DeviceService.refreshDockerInfo` → `DockerInfo.containers`) and
 *     `QemuSourceReading.instanceRows` (from `QemuService.redroidList(vm)`).
 *   - 健康度摘要 ← the same cached readings the P5 badges render (engine +
 *     `DeviceService.getWslKernelStatus` + `probeTool` for Docker; the cached
 *     `QemuService.doctor` tally / CLI error for QEMU), shared verbatim through
 *     `pages/containers/RuntimeSourceBadges`.
 *   - CPU 配额 / 内存配额 / 磁盘 / 启动耗时 ← per-instance read-only metrics
 *     enriched by the existing Docker and guest detail reads.
 */
import type {
  DockerSourceReading,
  QemuSourceReading,
  RuntimeInstanceRow,
  RuntimeTrack,
} from "./runtimeTrack";
import { RUNTIME_TRACKS } from "./runtimeTrack";

/** Translator shape shared with `useI18n().t` (kept structural: no i18n import). */
export type CompareTranslator = (key: string, vars?: Record<string, string | number>) => string;

export type CompareLevel = "ok" | "warn" | "fail" | "unknown";

/** Metric rows of every comparison group, in render order (spec §6.8). */
export const COMPARE_METRICS = [
  "instances",
  "running",
  "cpuQuota",
  "memQuota",
  "disk",
  "bootTime",
  "health",
] as const;

export type CompareMetricId = (typeof COMPARE_METRICS)[number];

export const COMPARE_METRIC_LABEL_KEY: Record<CompareMetricId, string> = {
  instances: "runtime.compare.metric.instances",
  running: "runtime.compare.metric.running",
  cpuQuota: "runtime.compare.metric.cpuQuota",
  memQuota: "runtime.compare.metric.memQuota",
  disk: "runtime.compare.metric.disk",
  bootTime: "runtime.compare.metric.bootTime",
  health: "runtime.compare.metric.health",
};

/**
 * Kept as an additive export for callers that used the P6 placeholder
 * vocabulary. P6b now supplies all four metrics from the instance snapshots.
 */
export const NO_SOURCE_METRICS: readonly CompareMetricId[] = [];

const RESOURCE_METRICS = [
  "cpuQuota",
  "memQuota",
  "disk",
  "bootTime",
] as const satisfies readonly CompareMetricId[];

/** i18n key of the hint explaining what a no-source metric would need. */
export function noSourceHintKey(metric: CompareMetricId): string {
  return `runtime.compare.gap.${metric}`;
}

/**
 * `docker ps` Status column → run state (`null` = the read reported no usable
 * state). Both tracks use the same format: the host's containers come from
 * `docker ps -a`, the node's instances from the same command inside the guest
 * (`qemu-center redroid list`), which writes `"unknown"` when the VM did not
 * answer — that is an unknown state, not a stopped instance.
 *
 * The `up` test matches the Docker panel's own `isUp` helper, so the compare
 * view and the panel never disagree about the same container.
 */
export function instanceRunState(status: string): boolean | null {
  const text = status.trim().toLowerCase();
  if (!text) return null;
  if (text === "unknown") return null;
  return text.startsWith("up");
}

/**
 * Image reference → tag, `""` when it carries none. Only the part after the
 * last `:` counts, and only when it comes after the last `/` (so
 * `localhost:5000/redroid` is a registry port, not a tag).
 */
export function imageTag(image: string): string {
  const colon = image.lastIndexOf(":");
  if (colon < 0 || colon < image.lastIndexOf("/")) return "";
  return image.slice(colon + 1).trim();
}

/**
 * Version label of one instance: what the track read, else the image tag (the
 * only version evidence a Docker container carries). `""` = no version at all.
 */
export function instanceVersionLabel(row: RuntimeInstanceRow): string {
  return row.androidVersion.trim() || imageTag(row.image);
}

/**
 * Grouping key: the Android *major* version (first number in the label), which
 * is the only level at which the two tracks' labels align — Docker reports
 * `13.0.0-latest` (image tag), the QEMU preset detail may report `13` or
 * `13.0.0`. `null` = not alignable (no digits), listed under 未标注版本.
 */
export function androidVersionKey(label: string): string | null {
  const match = label.match(/\d+/);
  return match ? match[0] : null;
}

export const UNKNOWN_VERSION_KEY = "unknown";

export type CompareCell =
  /** A number the snapshot carries; `share` (0..1) drives the bar, null = none. */
  | { kind: "count"; text: string; share: number | null; note: string }
  /** A read-only resource aggregate backed by one or more instance metrics. */
  | { kind: "value"; text: string; detail: string; complete: boolean }
  /** A stated state (health summary); `level` reuses the badge palette. */
  | { kind: "text"; text: string; level: CompareLevel; detail: string }
  /** Legacy placeholder shape; current builders use `value` or `unavailable`. */
  | { kind: "noSource"; hint: string }
  /** The track has no usable reading: reason + raw detail, never a 0. */
  | { kind: "unavailable"; reason: string; detail: string };

export type CompareInstanceView = {
  name: string;
  host: string;
  /** Raw version label as read (`""` = 未标注). */
  versionLabel: string;
  /** `null` = the read reported no run state (QEMU node did not answer). */
  running: boolean | null;
  /** Raw status text, verbatim (tooltip). */
  status: string;
  /** Read-only resource/start metrics, when inspect returned them. */
  metrics: RuntimeInstanceRow["metrics"];
};

export type CompareSideView = {
  track: RuntimeTrack;
  /** false = no usable snapshot: every cell states the reason. */
  available: boolean;
  /** Reason shown in the cells when `available` is false. */
  unavailable: string;
  /** Tooltip detail behind `unavailable` (raw CLI error / read age). */
  detail: string;
  /** Track-level scope note (redroid-only, selected node). */
  scope: string;
  /** Instances of this side **in this group**, in read order. */
  instances: CompareInstanceView[];
  cells: Record<CompareMetricId, CompareCell>;
};

/** How a group's two sides line up (spec §6.8: 单轨独有 must be labelled). */
export type CompareAlignment = "aligned" | "single" | "unresolved";

export type CompareGroupView = {
  /** Android major version, or `UNKNOWN_VERSION_KEY`. */
  key: string;
  title: string;
  /** Raw labels seen in this group, deduped (honest detail under the title). */
  rawLabels: string[];
  alignment: CompareAlignment;
  /** Set when exactly one available track has instances of this version. */
  singleTrack: RuntimeTrack | null;
  sides: Record<RuntimeTrack, CompareSideView>;
};

export type CompareTrackSummary = {
  track: RuntimeTrack;
  /** Instances in the whole snapshot, `null` = unavailable (reason below). */
  count: number | null;
  /** Reason when `count` is null (engine down / CLI missing / not read). */
  unavailable: string;
  detail: string;
  scope: string;
  /** Epoch ms of the read (0 = never); the view prints it as an absolute time. */
  at: number;
};

export type CompareView = {
  summaries: Record<RuntimeTrack, CompareTrackSummary>;
  groups: CompareGroupView[];
};

/**
 * One track's rows, or the reason there are none. `null` rows are what keeps
 * "not read" apart from "read and empty": only the latter may render as `0`.
 */
type TrackRows =
  | { rows: RuntimeInstanceRow[]; at: number; scope: string }
  | { reason: string; detail: string; at: number; scope: string };

/**
 * Docker rows: redroid containers of `docker info` (same filter the panel's own
 * instance list uses). Everything else the panel read — engine state, CLI
 * probe, kernel — only decides whether the row list may be trusted.
 */
function dockerRows(reading: DockerSourceReading | null, t: CompareTranslator): TrackRows {
  if (!reading) return { reason: t("runtime.source.notRead"), detail: "", at: 0, scope: "" };
  if (reading.cliAvailable === false) {
    return { reason: t("runtime.source.cliMissing"), detail: "", at: reading.at, scope: "" };
  }
  if (reading.running === false) {
    return { reason: t("runtime.source.dockerStopped"), detail: "", at: reading.at, scope: "" };
  }
  if (reading.running !== true || !reading.instances) {
    return { reason: t("runtime.source.notRead"), detail: "", at: reading.at, scope: "" };
  }
  const scope =
    reading.containers === null
      ? t("runtime.compare.scope.dockerUnknown")
      : t("runtime.compare.scope.docker", {
          containers: reading.containers,
          redroid: reading.instances.length,
        });
  return { rows: reading.instances, at: reading.at, scope };
}

/** QEMU rows: instances of the panel's selected node, or the reason there are none. */
function qemuRows(reading: QemuSourceReading | null, t: CompareTranslator): TrackRows {
  if (!reading) return { reason: t("runtime.source.notRead"), detail: "", at: 0, scope: "" };
  if (reading.cliError) {
    return { reason: t("runtime.source.cliMissing"), detail: reading.cliError, at: reading.at, scope: "" };
  }
  const scope = reading.scope
    ? t("runtime.compare.scope.qemuNode", { node: reading.scope })
    : t("runtime.compare.scope.qemuNoNode");
  if (reading.instances === null || !reading.instanceRows) {
    return { reason: t("runtime.source.notRead"), detail: scope, at: reading.at, scope };
  }
  return { rows: reading.instanceRows, at: reading.at, scope };
}

/** Pick the health summary of a track (already localized by the caller). */
export type CompareHealth = { text: string; level: CompareLevel; detail: string };

function instanceView(row: RuntimeInstanceRow): CompareInstanceView {
  return {
    name: row.name,
    host: row.host,
    versionLabel: instanceVersionLabel(row),
    running: instanceRunState(row.status),
    status: row.status,
    metrics: row.metrics ?? null,
  };
}

/** One side of one group: availability, its instances there, and its cells. */
function sideView(
  track: RuntimeTrack,
  source: TrackRows,
  instances: CompareInstanceView[],
  otherInstances: number,
  health: CompareHealth,
  t: CompareTranslator,
  now: number,
): CompareSideView {
  const available = "rows" in source;
  const list = available ? instances : [];
  const unavailable = available ? "" : source.reason;
  const detail = available ? "" : source.detail;
  return {
    track,
    available,
    unavailable,
    detail,
    scope: source.scope,
    instances: list,
    cells: sideCells(
      { track, available, unavailable, detail, instances: list, otherInstances, health },
      t,
      now,
    ),
  };
}

/**
 * Metric cells of one side of one group.
 *
 * Precedence, in order (so a cell never shows a number it cannot back):
 *   1. track snapshot unusable    → `unavailable` with the track's reason
 *   2. value from the snapshot    → `count` / `text` / `value`
 *   3. a missing per-instance field → `unavailable` with its source reason
 */
function sideCells(
  input: {
    track: RuntimeTrack;
    available: boolean;
    unavailable: string;
    detail: string;
    instances: CompareInstanceView[];
    otherInstances: number;
    health: CompareHealth;
  },
  t: CompareTranslator,
  now: number,
): Record<CompareMetricId, CompareCell> {
  const cells = {} as Record<CompareMetricId, CompareCell>;
  cells.health = {
    kind: "text",
    text: input.health.text,
    level: input.health.level,
    detail: input.health.detail,
  };

  if (!input.available) {
    const reason = { kind: "unavailable" as const, reason: input.unavailable, detail: input.detail };
    cells.instances = reason;
    cells.running = reason;
    for (const metric of RESOURCE_METRICS) cells[metric] = reason;
    return cells;
  }

  const total = input.instances.length;
  const groupTotal = total + input.otherInstances;
  cells.instances = {
    kind: "count",
    text: String(total),
    share: groupTotal > 0 ? total / groupTotal : null,
    note: total === 0 ? t("runtime.compare.zeroNote") : "",
  };

  const running = input.instances.filter((instance) => instance.running === true).length;
  const known = input.instances.filter((instance) => instance.running !== null).length;
  if (total > 0 && known === 0) {
    // Every status was `unknown`: the node answered nothing, so this is a
    // missing reading (spec §6.8 不可用语义), not "0 running".
    const statuses = Array.from(new Set(input.instances.map((i) => i.status).filter(Boolean)));
    cells.running = {
      kind: "unavailable",
      reason: t("runtime.compare.statusUnknown"),
      detail: statuses.join(" · "),
    };
  } else {
    const unknown = total - known;
    cells.running = {
      kind: "count",
      text: t("runtime.compare.runningRatio", { running, total }),
      share: total > 0 ? running / total : null,
      note: unknown > 0 ? t("runtime.compare.runningUnknown", { count: unknown }) : "",
    };
  }
  for (const metric of RESOURCE_METRICS) {
    cells[metric] = resourceMetricCell(metric, input.instances, now, input.track, t);
  }
  return cells;
}

function numberText(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function bytesText(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${numberText(value)} ${units[index]}`;
}

function durationText(ms: number, t: CompareTranslator): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t("runtime.compare.duration.seconds", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder
      ? t("runtime.compare.duration.minutesSeconds", { m: minutes, s: remainder })
      : t("runtime.compare.duration.minutes", { n: minutes });
  }
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder
    ? t("runtime.compare.duration.hoursMinutes", { h: hours, m: minuteRemainder })
    : t("runtime.compare.duration.hours", { n: hours });
}

function startDurationMs(
  metrics: NonNullable<CompareInstanceView["metrics"]>,
  now: number,
): number | null {
  if (!metrics.startedAt) return null;
  const started = Date.parse(metrics.startedAt);
  if (!Number.isFinite(started)) return null;
  const finished = metrics.finishedAt ? Date.parse(metrics.finishedAt) : now;
  if (!Number.isFinite(finished) || finished < started) return null;
  return finished - started;
}

function resourceMetricCell(
  metric: (typeof RESOURCE_METRICS)[number],
  instances: CompareInstanceView[],
  now: number,
  track: RuntimeTrack,
  t: CompareTranslator,
): CompareCell {
  if (instances.length === 0) {
    return { kind: "unavailable", reason: t("runtime.compare.noInstances"), detail: "" };
  }

  const cpuValues: string[] = [];
  const memoryValues: string[] = [];
  const diskValues: number[] = [];
  const bootValues: number[] = [];
  for (const instance of instances) {
    const metrics = instance.metrics;
    if (!metrics) continue;
    if (metric === "cpuQuota") {
      if (metrics.cpuUnlimited === true) cpuValues.push(t("runtime.compare.unlimited"));
      else if (metrics.cpuQuotaCores !== null && metrics.cpuQuotaCores !== undefined && Number.isFinite(metrics.cpuQuotaCores) && metrics.cpuQuotaCores > 0) {
        cpuValues.push(t("runtime.compare.value.cpu", { value: numberText(metrics.cpuQuotaCores) }));
      }
    } else if (metric === "memQuota") {
      if (metrics.memoryUnlimited === true) memoryValues.push(t("runtime.compare.unlimited"));
      else if (metrics.memoryQuotaBytes !== null && metrics.memoryQuotaBytes !== undefined && Number.isFinite(metrics.memoryQuotaBytes) && metrics.memoryQuotaBytes > 0) {
        memoryValues.push(bytesText(metrics.memoryQuotaBytes));
      }
    } else if (metric === "disk") {
      if (metrics.diskBytes !== null && metrics.diskBytes !== undefined && Number.isFinite(metrics.diskBytes) && metrics.diskBytes >= 0) {
        diskValues.push(metrics.diskBytes);
      }
    } else {
      const duration = startDurationMs(metrics, now);
      if (duration !== null) bootValues.push(duration);
    }
  }

  const known = metric === "cpuQuota" ? cpuValues.length
    : metric === "memQuota" ? memoryValues.length
      : metric === "disk" ? diskValues.length
        : bootValues.length;
  if (known === 0) {
    return {
      kind: "unavailable",
      reason: t("runtime.compare.metricUnavailable"),
      detail: t(
        track === "qemu"
          ? "runtime.compare.metricSource.qemu"
          : "runtime.compare.metricSource.docker",
        { metric: t(COMPARE_METRIC_LABEL_KEY[metric]) },
      ),
    };
  }

  const missing = instances.length - known;
  const partial = missing > 0 ? ` · ${t("runtime.compare.metricPartial", { known, total: instances.length })}` : "";
  let text: string;
  if (metric === "cpuQuota") {
    text = [...new Set(cpuValues)].join(" · ");
  } else if (metric === "memQuota") {
    text = [...new Set(memoryValues)].join(" · ");
  } else if (metric === "disk") {
    text = bytesText(diskValues.reduce((sum, value) => sum + value, 0));
  } else {
    const average = bootValues.reduce((sum, value) => sum + value, 0) / bootValues.length;
    const formatted = durationText(average, t);
    text = bootValues.length > 1 ? t("runtime.compare.average", { value: formatted }) : formatted;
  }
  return {
    kind: "value",
    text: text + partial,
    detail: t(
      track === "qemu"
        ? "runtime.compare.metricSource.qemu"
        : "runtime.compare.metricSource.docker",
      { metric: t(COMPARE_METRIC_LABEL_KEY[metric]) },
    ),
    complete: missing === 0,
  };
}

/**
 * Build the whole comparison: per-track summaries (availability + counts) and
 * one group per Android version, sorted numerically with 未标注版本 last.
 */
export function buildCompareView(
  readings: { docker: DockerSourceReading | null; qemu: QemuSourceReading | null },
  health: Record<RuntimeTrack, CompareHealth>,
  t: CompareTranslator,
  now = Date.now(),
): CompareView {
  const sources: Record<RuntimeTrack, TrackRows> = {
    docker: dockerRows(readings.docker, t),
    qemu: qemuRows(readings.qemu, t),
  };

  const summaries = {} as Record<RuntimeTrack, CompareTrackSummary>;
  for (const track of RUNTIME_TRACKS) {
    const source = sources[track];
    summaries[track] = {
      track,
      count: "rows" in source ? source.rows.length : null,
      unavailable: "reason" in source ? source.reason : "",
      detail: "reason" in source ? source.detail : "",
      scope: source.scope,
      at: source.at,
    };
  }

  // Bucket every side's rows by Android major version. Sides without a usable
  // snapshot contribute no group — their reason is stated in every cell instead.
  const buckets = new Map<string, Record<RuntimeTrack, CompareInstanceView[]>>();
  const labels = new Map<string, Set<string>>();
  for (const track of RUNTIME_TRACKS) {
    const source = sources[track];
    if (!("rows" in source)) continue;
    for (const row of source.rows) {
      const view = instanceView(row);
      const key = androidVersionKey(view.versionLabel) ?? UNKNOWN_VERSION_KEY;
      const bucket = buckets.get(key) ?? { docker: [], qemu: [] };
      bucket[track].push(view);
      buckets.set(key, bucket);
      const seen = labels.get(key) ?? new Set<string>();
      seen.add(view.versionLabel || t("runtime.compare.group.unknown"));
      labels.set(key, seen);
    }
  }

  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === UNKNOWN_VERSION_KEY) return 1;
    if (b === UNKNOWN_VERSION_KEY) return -1;
    return Number(a) - Number(b) || a.localeCompare(b);
  });

  const groups: CompareGroupView[] = keys.map((key) => {
    const bucket = buckets.get(key) as Record<RuntimeTrack, CompareInstanceView[]>;
    const sides = {} as Record<RuntimeTrack, CompareSideView>;
    for (const track of RUNTIME_TRACKS) {
      const other = RUNTIME_TRACKS.find((candidate) => candidate !== track) as RuntimeTrack;
      sides[track] = sideView(
        track,
        sources[track],
        bucket[track],
        bucket[other].length,
        health[track],
        t,
        now,
      );
    }

    const docker = sides.docker;
    const qemu = sides.qemu;
    const canAlign = docker.available && qemu.available;
    const dockerHas = docker.instances.length > 0;
    const qemuHas = qemu.instances.length > 0;
    // 单轨独有 may only be claimed when the *other* track's snapshot is usable:
    // an unavailable track could well have instances of this version.
    const alignment: CompareAlignment = !canAlign
      ? "unresolved"
      : dockerHas && qemuHas
        ? "aligned"
        : dockerHas || qemuHas
          ? "single"
          : "aligned";
    return {
      key,
      title:
        key === UNKNOWN_VERSION_KEY
          ? t("runtime.compare.group.unknown")
          : t("runtime.compare.group.android", { version: key }),
      rawLabels: [...(labels.get(key) ?? new Set<string>())].sort(),
      alignment,
      singleTrack:
        alignment === "single" ? (dockerHas ? ("docker" as const) : ("qemu" as const)) : null,
      sides,
    };
  });

  return { summaries, groups };
}
