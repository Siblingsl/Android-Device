import { Card } from "../../components/ui/Card";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import {
  buildCompareView,
  COMPARE_METRIC_LABEL_KEY,
  COMPARE_METRICS,
  type CompareCell,
  type CompareGroupView,
  type CompareMetricId,
  type CompareSideView,
  type CompareTrackSummary,
} from "../../lib/runtimeCompare";
import {
  RUNTIME_COMPARE_PANEL_ID,
  RUNTIME_TRACKS,
  type RuntimeTrack,
} from "../../lib/runtimeTrack";
import { RefreshCw } from "lucide-react";
import { LEVEL_CLASS, dockerHealthView, qemuHealthView } from "./RuntimeSourceBadges";

const TRACK_LABEL_KEY: Record<RuntimeTrack, string> = {
  docker: "runtime.track.docker",
  qemu: "runtime.track.qemu",
};

/**
 * Cross-track comparison view (merge spec §6.8, P6): a read-only aggregation of
 * the two panels' session snapshots, grouped by Android version.
 *
 * Zero service calls and zero timers — the view renders the `runtimeSources`
 * cache and nothing else:
 *
 *   - entering it never triggers a read (the panels' snapshots are session-
 *     scoped, so it shows the same cache the badges show);
 *   - a refresh click is delegated up to the shell through `onRefresh`, which
 *     bumps a *mounted* panel's `refreshSignal` or mounts the other track
 *     (mounting *is* that track's read) — the view itself still calls nothing;
 *   - snapshot ages are printed as absolute clock times, so no interval is
 *     needed to keep a relative "N 分钟前" label from going stale.
 *
 * Honesty rules (spec §6.8): a metric without a data source says
 * 「不可用（无数据源）」, an unreadable track says why (Docker 未启动 / CLI 缺失 /
 * 未读取 / 状态未知), and a genuine "read and found none" is the only case that
 * prints 0 — labeled as such.
 */
export default function RuntimeCompare({
  onRefresh,
  inPlace,
  labelId,
}: {
  /** Delegated refresh, same contract as the source badges (P5). */
  onRefresh: (track: RuntimeTrack) => void;
  /** Tracks whose panel is mounted right now (their read can run in place). */
  inPlace: Record<RuntimeTrack, boolean>;
  /** id of the tab labelling this view (the active track's tab, P6 a11y). */
  labelId?: string;
}) {
  const { t } = useI18n();
  const docker = useAppStore((s) => s.runtimeSources.docker);
  const qemu = useAppStore((s) => s.runtimeSources.qemu);
  // One clock read per render: ages are not tracked live, by design (no timers).
  const now = Date.now();
  const health = {
    docker: dockerHealthView(docker, now, t),
    qemu: qemuHealthView(qemu, now, t),
  };
  const view = buildCompareView({ docker, qemu }, health, t);

  return (
    <div
      className="runtime-compare"
      id={RUNTIME_COMPARE_PANEL_ID}
      role="tabpanel"
      aria-label={labelId ? undefined : t("runtime.compare.title")}
      aria-labelledby={labelId}
      tabIndex={-1}
    >
      <div className="runtime-compare-head row-between">
        <div>
          <div className="runtime-compare-title">{t("runtime.compare.title")}</div>
          <div className="muted runtime-compare-subtitle">{t("runtime.compare.subtitle")}</div>
        </div>
        <span className="badge info">{t("runtime.compare.readOnly")}</span>
      </div>

      <div
        className="runtime-compare-tracks"
        role="group"
        aria-label={t("runtime.compare.tracksLabel")}
      >
        {RUNTIME_TRACKS.map((track) => (
          <TrackSummary
            key={track}
            track={track}
            summary={view.summaries[track]}
            inPlace={inPlace[track]}
            onRefresh={onRefresh}
          />
        ))}
      </div>

      {view.groups.length === 0 ? (
        <div className="empty-state runtime-compare-empty">{t("runtime.compare.empty")}</div>
      ) : (
        view.groups.map((group) => <CompareGroupCard key={group.key} group={group} />)
      )}
    </div>
  );
}

/** Per-track strip: count or reason, scope note, snapshot time, refresh. */
function TrackSummary({
  track,
  summary,
  inPlace,
  onRefresh,
}: {
  track: RuntimeTrack;
  summary: CompareTrackSummary;
  inPlace: boolean;
  onRefresh: (track: RuntimeTrack) => void;
}) {
  const { t } = useI18n();
  const label = t(TRACK_LABEL_KEY[track]);
  return (
    <div className="runtime-compare-track" data-track={track}>
      <div className="row-between">
        <span className="runtime-compare-track-name">{label}</span>
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
      <div className="runtime-compare-track-value">
        {summary.count === null ? (
          <span className="runtime-compare-unavailable" title={summary.detail}>
            {summary.unavailable}
          </span>
        ) : (
          <span>{t("runtime.compare.trackInstances", { count: summary.count })}</span>
        )}
        {summary.at > 0 ? (
          <span className="muted runtime-compare-at" data-snapshot-at={summary.at}>
            {t("runtime.compare.snapshotAt", { time: new Date(summary.at).toLocaleTimeString() })}
          </span>
        ) : null}
      </div>
      {summary.scope ? <div className="muted runtime-compare-scope">{summary.scope}</div> : null}
    </div>
  );
}

/** 两轨对齐 / 单轨独有 / 无法判定, as the group's badge. */
function alignmentView(group: CompareGroupView, t: (key: string, vars?: Record<string, string | number>) => string) {
  if (group.alignment === "single" && group.singleTrack) {
    return {
      className: "badge warn",
      text: t("runtime.compare.group.singleTrack", {
        track: t(TRACK_LABEL_KEY[group.singleTrack]),
      }),
    };
  }
  if (group.alignment === "unresolved") {
    return { className: "badge", text: t("runtime.compare.group.unresolved") };
  }
  return { className: "badge info", text: t("runtime.compare.group.aligned") };
}

function CompareGroupCard({ group }: { group: CompareGroupView }) {
  const { t } = useI18n();
  const alignment = alignmentView(group, t);
  return (
    <Card className="runtime-compare-group">
      <div className="row-between runtime-compare-group-head">
        <div className="row runtime-compare-group-title" data-group={group.key}>
          <span>{group.title}</span>
          {group.rawLabels.length ? (
            <span
              className="muted runtime-compare-group-raw"
              title={t("runtime.compare.group.rawVersions")}
            >
              {group.rawLabels.join(" · ")}
            </span>
          ) : null}
        </div>
        <span className={alignment.className}>{alignment.text}</span>
      </div>
      <div className="table-wrap runtime-compare-table-wrap">
        <table className="table runtime-compare-table">
          <thead>
            <tr>
              <th>{t("runtime.compare.metricHeader")}</th>
              {RUNTIME_TRACKS.map((track) => (
                <th key={track}>{t(TRACK_LABEL_KEY[track])}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE_METRICS.map((metric) => (
              <tr key={metric} data-metric={metric}>
                <th scope="row">{t(COMPARE_METRIC_LABEL_KEY[metric])}</th>
                {RUNTIME_TRACKS.map((track) => (
                  <td key={track} data-track={track}>
                    <MetricCell
                      metric={metric}
                      track={track}
                      cell={group.sides[track].cells[metric]}
                    />
                  </td>
                ))}
              </tr>
            ))}
            <tr data-metric="instancesList">
              <th scope="row">{t("runtime.compare.metric.instancesList")}</th>
              {RUNTIME_TRACKS.map((track) => (
                <td key={track} data-track={track}>
                  <InstanceList side={group.sides[track]} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MetricCell({
  metric,
  track,
  cell,
}: {
  metric: CompareMetricId;
  track: RuntimeTrack;
  cell: CompareCell;
}) {
  const { t } = useI18n();
  if (cell.kind === "noSource") {
    // 不可用（无数据源）: the metric has no source in this build, whatever the
    // track is doing. The hint names the read that would fill it (spec §6.8).
    return (
      <span
        className="runtime-compare-gap"
        data-cell="no-source"
        title={cell.hint}
      >
        {t("runtime.compare.noSource")}
      </span>
    );
  }
  if (cell.kind === "unavailable") {
    return (
      <span className="runtime-compare-unavailable" data-cell="unavailable" title={cell.detail}>
        {cell.reason}
      </span>
    );
  }
  if (cell.kind === "text") {
    return (
      <span className={LEVEL_CLASS[cell.level]} data-cell="text" title={cell.detail}>
        {cell.text}
      </span>
    );
  }
  return (
    <span className="runtime-compare-value" data-cell="count">
      <span className="runtime-compare-number">{cell.text}</span>
      {cell.share !== null ? (
        <span
          className="runtime-compare-meter"
          role="meter"
          aria-label={`${t(COMPARE_METRIC_LABEL_KEY[metric])} · ${t(TRACK_LABEL_KEY[track])}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(cell.share * 100)}
        >
          <span style={{ width: `${Math.round(cell.share * 100)}%` }} />
        </span>
      ) : null}
      {cell.note ? <span className="muted runtime-compare-note">{cell.note}</span> : null}
    </span>
  );
}

/** The instances of one side in this group, as state chips (raw status in the title). */
function InstanceList({ side }: { side: CompareSideView }) {
  const { t } = useI18n();
  if (!side.available) {
    return (
      <span className="runtime-compare-unavailable" data-cell="unavailable" title={side.detail}>
        {side.unavailable}
      </span>
    );
  }
  if (side.instances.length === 0) {
    return <span className="muted" data-cell="empty">{t("runtime.compare.zeroNote")}</span>;
  }
  return (
    <span className="runtime-compare-chips">
      {side.instances.map((instance) => {
        const state =
          instance.running === true ? "up" : instance.running === false ? "down" : "unknown";
        return (
          <span
            key={instance.name}
            className="runtime-compare-chip"
            data-state={state}
            title={
              (instance.host ? `${instance.host} · ` : "") +
              (instance.status || t("runtime.compare.statusUnknown"))
            }
          >
            <span className="runtime-compare-dot" />
            <span className="mono">{instance.name}</span>
          </span>
        );
      })}
    </span>
  );
}
