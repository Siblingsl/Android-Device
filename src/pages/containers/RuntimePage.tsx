import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { ArrowLeft, Container, LoaderCircle, Scale, Server } from "lucide-react";
import DockerTrackPanel from "../tracks/DockerTrackPanel";
import QemuTrackPanel from "../tracks/QemuTrackPanel";
import RuntimeCompare from "./RuntimeCompare";
import RuntimeSourceBadges from "./RuntimeSourceBadges";
import { Button } from "../../components/ui/Button";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import {
  RUNTIME_COMPARE_PANEL_ID,
  RUNTIME_TRACKS,
  normalizeRuntimeTrack,
  panelDomId,
  resolveRuntimeTrack,
  resolveRuntimeView,
  tabDomId,
  type RuntimeTrack,
  type TrackTaskInfo,
} from "../../lib/runtimeTrack";

const TRACK_ICON: Record<RuntimeTrack, typeof Container> = { docker: Container, qemu: Server };
const TRACK_LABEL_KEY: Record<RuntimeTrack, string> = {
  docker: "runtime.track.docker",
  qemu: "runtime.track.qemu",
};

/** The other track, used for the "hidden but mounted" bookkeeping. */
function otherTrack(track: RuntimeTrack): RuntimeTrack {
  return track === "docker" ? "qemu" : "docker";
}

/**
 * Merged "containers & nodes" page (`/containers`).
 *
 * Shell only: page header, track switcher, deep-link sync and the mount
 * strategy. It never calls `docker_*` / `qemu_*` itself — the mounted panel
 * keeps owning its state, service calls and i18n namespace, so the two tracks
 * stay functionally separate ("页面合并 / 功能不合并").
 *
 * Mount strategy (merge spec §6.4, P3):
 *   - no long task running      → only the active track's panel is mounted;
 *   - other track has a task    → that panel *stays mounted* (it must not be
 *     remounted or it would lose the task's local state) and is taken out of
 *     layout by CSS only, plus a background-task bar with a "go to that track"
 *     button;
 *   - that task ends            → the panel reports `null`, and it is unmounted
 *     again, back to "active track only".
 * Hiding is done through `data-inactive-track` + a sibling rule in global.css:
 * a wrapper element here would break the `.page-fade > div` scoping the track
 * layouts depend on (see the comment in global.css).
 *
 * P6 adds a second view of the same page: `?view=compare` renders
 * `RuntimeCompare` (read-only aggregation of the panels' published snapshots)
 * in the panel area. It is a sibling of the shell as well, hidden panels are
 * taken out of layout by the same attribute-driven CSS, and the mount strategy
 * above is untouched — the shell still calls no service, the compare view
 * included.
 *
 * The panel is rendered as a *sibling* of the shell block, never inside an
 * extra wrapper: global.css scopes each track's layout through
 * `.page-docker`/`.page-qemu .page-fade > div > …`, which requires the panel
 * root to stay the direct child of `.page-fade`.
 */
export default function RuntimePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const { t } = useI18n();
  const tabRefs = useRef<Partial<Record<RuntimeTrack, HTMLButtonElement | null>>>({});
  /** Long tasks reported by the panels, keyed by track. */
  const [tasks, setTasks] = useState<Partial<Record<RuntimeTrack, TrackTaskInfo>>>({});

  const track = resolveRuntimeTrack(searchParams.get("track"), settings?.defaultTrack);
  /** `?view=compare` replaces the panel area with the read-only compare view. */
  const view = resolveRuntimeView(searchParams.get("view"));
  const inCompare = view === "compare";

  const reportTask = useCallback((from: RuntimeTrack, task: TrackTaskInfo | null) => {
    setTasks((previous) => {
      if (!task) {
        if (!(from in previous)) return previous;
        const next = { ...previous };
        delete next[from];
        return next;
      }
      if (previous[from]?.label === task.label) return previous;
      return { ...previous, [from]: task };
    });
  }, []);

  // Stable identities: the panels report from an effect, so a new function
  // every render would make them re-report on every shell render.
  const onDockerTask = useCallback(
    (task: TrackTaskInfo | null) => reportTask("docker", task),
    [reportTask],
  );
  const onQemuTask = useCallback(
    (task: TrackTaskInfo | null) => reportTask("qemu", task),
    [reportTask],
  );

  const hidden = otherTrack(track);
  const hiddenTask = tasks[hidden] ?? null;
  const hiddenMounted = Boolean(hiddenTask);
  const backgroundTrack: RuntimeTrack | null = hiddenMounted ? hidden : null;

  /** Mounted = visible right now, or kept alive by a running long task. */
  const isMounted = useCallback(
    (candidate: RuntimeTrack) => candidate === track || Boolean(tasks[candidate]),
    [track, tasks],
  );
  const mountedTracks = useMemo(
    () => ({ docker: isMounted("docker"), qemu: isMounted("qemu") }),
    [isMounted],
  );

  /** Bumped per track to ask a *mounted* panel for a fresh read-only load. */
  const [refreshSignals, setRefreshSignals] = useState<Record<RuntimeTrack, number>>({
    docker: 0,
    qemu: 0,
  });

  const rememberTrack = useCallback(
    (next: RuntimeTrack) => {
      // URL is temporary / shareable, the memory is cross-session. Best effort:
      // the web preview has no backend, and a failed write must never block the
      // switch itself (same contract as the language preference).
      if (!settings || normalizeRuntimeTrack(settings.defaultTrack) === next) return;
      void saveSettings({ ...settings, defaultTrack: next }).catch(() => {
        /* preference persistence is optional */
      });
    },
    [settings, saveSettings],
  );

  /** One history entry per user action: every `?track=`/`?view=` write goes here. */
  const writeParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        mutate(params);
        return params;
      });
    },
    [setSearchParams],
  );

  const selectTrack = useCallback(
    (next: RuntimeTrack, options?: { keepView?: boolean }) => {
      // Write the choice into the URL (shareable / refresh-safe). Skipped when
      // the URL already says so, to avoid a duplicate history entry.
      const trackStale = searchParams.get("track") !== next;
      // Picking a track means "show me that track's panel", so it also leaves
      // the compare view. A refresh delegation passes `keepView` instead: that
      // click is not a navigation, it only has to mount a panel to read it.
      const viewStale = !options?.keepView && searchParams.get("view") !== null;
      if (trackStale || viewStale) {
        writeParams((params) => {
          params.set("track", next);
          if (viewStale) params.delete("view");
        });
      }
      rememberTrack(next);
    },
    [searchParams, writeParams, rememberTrack],
  );

  /** Enter the compare view (`?view=compare`); `?track=` stays untouched. */
  const enterCompare = useCallback(() => {
    writeParams((params) => params.set("view", "compare"));
  }, [writeParams]);

  /** Leave it: the track the URL kept is the panel the user returns to. */
  const leaveCompare = useCallback(() => {
    writeParams((params) => params.delete("view"));
  }, [writeParams]);

  /**
   * Explicit refresh from a source badge (P5) or the compare view (P6). A
   * mounted panel re-runs its own read-only load when its signal is raised; an
   * unmounted one is only revealed by a track switch, because mounting *is* that
   * track's read (its mount load). Either way the shell itself calls no service —
   * it only decides which of the panel's two existing entry points the user's
   * click maps onto.
   */
  const refreshSource = useCallback(
    (target: RuntimeTrack) => {
      if (isMounted(target)) {
        setRefreshSignals((current) => ({ ...current, [target]: current[target] + 1 }));
        return;
      }
      selectTrack(target, { keepView: true });
    },
    [isMounted, selectTrack],
  );

  /**
   * Focus target of a keyboard *activation* (Enter / Space). Arrow-key
   * navigation deliberately leaves focus on the tab — that is the roving
   * tabindex behaviour the P2 tests pin — while activating a tab moves focus
   * into the revealed panel (merge spec §6.7).
   */
  const [focusPanel, setFocusPanel] = useState<RuntimeTrack | null>(null);
  useEffect(() => {
    if (!focusPanel) return;
    setFocusPanel(null);
    // The panel root *is* the tabpanel (it has to stay the direct child of
    // `.page-fade`, so the shell cannot wrap it in a host of its own) and it
    // carries the id, which is why it is looked up instead of held by a ref.
    document.getElementById(panelDomId(focusPanel))?.focus();
  }, [focusPanel, track]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTrack(track);
      setFocusPanel(track);
      return;
    }
    const current = RUNTIME_TRACKS.indexOf(track);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (current + 1) % RUNTIME_TRACKS.length;
    else if (event.key === "ArrowLeft") nextIndex = (current - 1 + RUNTIME_TRACKS.length) % RUNTIME_TRACKS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = RUNTIME_TRACKS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = RUNTIME_TRACKS[nextIndex];
    selectTrack(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <div
        className="runtime-shell"
        data-inactive-track={backgroundTrack ?? undefined}
        data-view={view}
      >
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("runtime.title")}</h1>
            <div className="page-subtitle">{t("runtime.subtitle")}</div>
          </div>
          <RuntimeSourceBadges onRefresh={refreshSource} inPlace={mountedTracks} />
        </div>

        {/* The view toggle sits *outside* the tablist: `role="tablist"` may only
            contain tabs, and the button is not a third track. */}
        <div className="runtime-trackbar">
          <div className="tabs runtime-tabs" role="tablist" aria-label={t("runtime.track.label")}>
            {RUNTIME_TRACKS.map((candidate) => {
              const Icon = TRACK_ICON[candidate];
              const selected = candidate === track;
              return (
                <button
                  key={candidate}
                  ref={(node) => {
                    tabRefs.current[candidate] = node;
                  }}
                  id={tabDomId(candidate)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  // While the compare view owns the panel area, it *is* the
                  // visible tabpanel, so the tabs point at it (P6 a11y).
                  aria-controls={inCompare ? RUNTIME_COMPARE_PANEL_ID : panelDomId(candidate)}
                  tabIndex={selected ? 0 : -1}
                  className={clsx("tab", "runtime-tab", selected && "active")}
                  onClick={() => selectTrack(candidate)}
                  onKeyDown={onTabKeyDown}
                >
                  <Icon size={14} strokeWidth={1.9} />
                  <span>{t(TRACK_LABEL_KEY[candidate])}</span>
                </button>
              );
            })}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="runtime-view-toggle"
            icon={inCompare ? <ArrowLeft size={13} /> : <Scale size={13} />}
            onClick={inCompare ? leaveCompare : enterCompare}
          >
            {inCompare ? t("runtime.compare.exit") : t("runtime.compare.enter")}
          </Button>
        </div>

        {backgroundTrack ? (
          <div
            className="notice runtime-bg-task"
            role="status"
            aria-label={t("runtime.backgroundTask.label")}
          >
            <LoaderCircle size={14} className="create-spinner" />
            <span className="runtime-bg-task-text">
              {t("runtime.backgroundTask.running", {
                track: t(TRACK_LABEL_KEY[backgroundTrack]),
                task: tasks[backgroundTrack]?.label ?? "",
              })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => selectTrack(backgroundTrack)}>
              {t("runtime.backgroundTask.goto")}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Compare view (P6): a sibling of the shell and of the panels, so it
          inherits the `.page-fade > div` full-height treatment and the panels
          stay the direct children global.css scopes its track layouts through.
          It renders the session cache only — no service call, no timer — and the
          panels keep their mount strategy untouched behind it. */}
      {inCompare ? (
        <RuntimeCompare
          onRefresh={refreshSource}
          inPlace={mountedTracks}
          labelId={tabDomId(track)}
        />
      ) : null}

      {/* Two fixed slots, in this order: the hidden-panel rule in global.css is a
          sibling selector keyed on `data-inactive-track`, and keeping both slots
          in the tree (`null` when unmounted) is what stops React from remounting
          a panel that has to stay mounted across a track switch.
          Each panel also gets its a11y wiring here: the panel root is the
          tabpanel (id + `aria-labelledby`, pointed at by its tab's
          `aria-controls`) and `showHeader={false}` because the shell above
          already renders the page title once. */}
      {track === "docker" || tasks.docker ? (
        <DockerTrackPanel
          active={track === "docker"}
          onTaskChange={onDockerTask}
          showHeader={false}
          panelId={panelDomId("docker")}
          panelLabelId={tabDomId("docker")}
          refreshSignal={refreshSignals.docker}
        />
      ) : null}
      {track === "qemu" || tasks.qemu ? (
        <QemuTrackPanel
          active={track === "qemu"}
          onTaskChange={onQemuTask}
          showHeader={false}
          panelId={panelDomId("qemu")}
          panelLabelId={tabDomId("qemu")}
          refreshSignal={refreshSignals.qemu}
        />
      ) : null}
    </>
  );
}
