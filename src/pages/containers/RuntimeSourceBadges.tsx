import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import type {
  DockerSourceReading,
  QemuSourceReading,
  RuntimeTrack,
} from "../../lib/runtimeTrack";

/**
 * Source badges of the merged page header (merge spec §6.8, P5).
 *
 * Read-only summary — 数量 + 健康度 — of what each track's own existing reads
 * already know:
 *
 *   - the tracks own every service call; the shell only renders the cache the
 *     panels publish into `appStore.runtimeSources` (session-scoped, so the
 *     badge survives the active-track-only mount strategy);
 *   - entering the page never runs a check: QEMU's WHPX probe costs seconds and
 *     has timeout steps, so the badge shows the *cached* doctor result with its
 *     age and offers an explicit refresh;
 *   - an unavailable source states a reason ("Docker 未启动" / "CLI 缺失" /
 *     "未读取" / "未检查") and never a made-up `0` (spec §6.8 "不可用语义").
 *
 * The refresh button delegates: for a mounted track it raises the panel's
 * `refreshSignal` (the panel then re-runs its own read), for an unmounted track
 * it switches to that track — mounting *is* that track's read, and the user
 * asked for it explicitly. The shell itself never calls `docker_*` / `qemu_*`.
 */
type Level = "ok" | "warn" | "fail" | "unknown";

const LEVEL_CLASS: Record<Level, string> = {
  ok: "badge success",
  warn: "badge warn",
  fail: "badge danger",
  unknown: "badge",
};

const TRACK_LABEL_KEY: Record<RuntimeTrack, string> = {
  docker: "runtime.track.docker",
  qemu: "runtime.track.qemu",
};

type BadgeView = {
  /** 数量 slot: the count, or the reason that replaces it. */
  count: string;
  /** 健康度 slot; omitted when the reason above already carries the state. */
  health?: string;
  level: Level;
  /** Tooltip detail (reading age / raw error / scope of the instance count). */
  detail?: string;
};

/** Whole minutes since `at`, floored at 0 (clock skew, fake timers). */
function minutesAgo(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / 60_000));
}

/** Minute-resolution clock: "N 分钟前" must not go stale on an idle page. */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** Docker: containers from `docker info`, health from engine + WSL binder. */
function dockerView(reading: DockerSourceReading | null, now: number, t: Translator): BadgeView {
  if (!reading) return { count: t("runtime.source.notChecked"), level: "unknown" };
  const detail = t("runtime.source.readTitle", { minutes: minutesAgo(reading.at, now) });
  if (reading.cliAvailable === false) {
    return { count: t("runtime.source.cliMissing"), level: "fail", detail };
  }
  if (reading.running === false) {
    return { count: t("runtime.source.dockerStopped"), level: "fail", detail };
  }
  if (reading.running !== true) {
    return { count: t("runtime.source.notChecked"), level: "unknown", detail };
  }
  const kernelNotReady = reading.kernelBinderEnabled === false;
  return {
    count: t("runtime.source.containers", { count: reading.containers ?? 0 }),
    health: kernelNotReady ? t("runtime.source.kernelNotReady") : t("runtime.source.ok"),
    level: kernelNotReady ? "warn" : "ok",
    detail,
  };
}

/**
 * QEMU: nodes/instances from the panel's own listings, health from the *cached*
 * doctor tally. A failed doctor run reports itself as a missing CLI, the same
 * reading the panel's own CLI-missing banner already shows (raw text in the
 * tooltip). Node run state is not part of `vm list`, so it is not guessed here.
 */
function qemuView(reading: QemuSourceReading | null, now: number, t: Translator): BadgeView {
  if (!reading) {
    return {
      count: t("runtime.source.notRead"),
      health: t("runtime.source.notChecked"),
      level: "unknown",
    };
  }
  const count =
    reading.nodes === null
      ? t("runtime.source.notRead")
      : reading.instances === null
        ? t("runtime.source.nodes", { count: reading.nodes })
        : t("runtime.source.nodesInstances", {
            nodes: reading.nodes,
            instances: reading.instances,
          });
  if (reading.cliError) {
    return { count, health: t("runtime.source.cliMissing"), level: "fail", detail: reading.cliError };
  }
  const details: string[] = [];
  if (reading.instances !== null && reading.scope) {
    details.push(t("runtime.source.instancesScope", { scope: reading.scope }));
  }
  if (!reading.checks) {
    details.push(t("runtime.source.readTitle", { minutes: minutesAgo(reading.at, now) }));
    return { count, health: t("runtime.source.notChecked"), level: "unknown", detail: details.join(" · ") };
  }
  const { ok, total, fail, other, at } = reading.checks;
  const minutes = minutesAgo(at, now);
  details.push(t("runtime.source.doctorTitle", { ok, total, fail, other, minutes }));
  return {
    count,
    health:
      minutes < 1
        ? t("runtime.source.doctorJustNow", { ok, total })
        : t("runtime.source.doctorAgo", { ok, total, minutes }),
    level: fail > 0 ? "fail" : other > 0 ? "warn" : "ok",
    detail: details.join(" · "),
  };
}

function SourceBadge({
  track,
  view,
  inPlace,
  onRefresh,
}: {
  track: RuntimeTrack;
  view: BadgeView;
  inPlace: boolean;
  onRefresh: (track: RuntimeTrack) => void;
}) {
  const { t } = useI18n();
  const label = t(TRACK_LABEL_KEY[track]);
  return (
    <div className="runtime-source" data-level={view.level} data-track={track} title={view.detail}>
      <span className="runtime-source-track">{label}</span>
      <span className="runtime-source-count">{view.count}</span>
      {view.health ? <span className={LEVEL_CLASS[view.level]}>{view.health}</span> : null}
      <button
        type="button"
        className="runtime-source-refresh"
        aria-label={t("runtime.source.refresh", { track: label })}
        title={
          inPlace
            ? t("runtime.source.refresh", { track: label })
            : t("runtime.source.refreshSwitch", { track: label })
        }
        onClick={() => onRefresh(track)}
      >
        <RefreshCw size={11} />
      </button>
    </div>
  );
}

export default function RuntimeSourceBadges({
  onRefresh,
  inPlace,
}: {
  /** Delegated refresh; see the component comment for the two paths. */
  onRefresh: (track: RuntimeTrack) => void;
  /** Tracks whose panel is mounted right now (their read can run in place). */
  inPlace: Record<RuntimeTrack, boolean>;
}) {
  const { t } = useI18n();
  const docker = useAppStore((s) => s.runtimeSources.docker);
  const qemu = useAppStore((s) => s.runtimeSources.qemu);
  const now = useNowTick();

  return (
    <div className="row runtime-badges" role="group" aria-label={t("runtime.source.label")}>
      <SourceBadge
        track="docker"
        view={dockerView(docker, now, t)}
        inPlace={inPlace.docker}
        onRefresh={onRefresh}
      />
      <SourceBadge
        track="qemu"
        view={qemuView(qemu, now, t)}
        inPlace={inPlace.qemu}
        onRefresh={onRefresh}
      />
    </div>
  );
}
