import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { Container, LoaderCircle, Server } from "lucide-react";
import DockerTrackPanel from "../tracks/DockerTrackPanel";
import QemuTrackPanel from "../tracks/QemuTrackPanel";
import { Button } from "../../components/ui/Button";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import {
  RUNTIME_TRACKS,
  normalizeRuntimeTrack,
  resolveRuntimeTrack,
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

  const selectTrack = useCallback(
    (next: RuntimeTrack) => {
      // Write the choice into the URL (shareable / refresh-safe). Skipped when
      // the URL already says so, to avoid a duplicate history entry.
      if (searchParams.get("track") !== next) {
        setSearchParams((prev) => {
          const params = new URLSearchParams(prev);
          params.set("track", next);
          return params;
        });
      }
      rememberTrack(next);
    },
    [searchParams, setSearchParams, rememberTrack],
  );

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
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
      <div className="runtime-shell" data-inactive-track={backgroundTrack ?? undefined}>
        <div className="page-header">
          <div>
            <div className="page-title">{t("runtime.title")}</div>
            <div className="page-subtitle">{t("runtime.subtitle")}</div>
          </div>
        </div>

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
                type="button"
                role="tab"
                aria-selected={selected}
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

      {/* Two fixed slots, in this order: the hidden-panel rule in global.css is a
          sibling selector keyed on `data-inactive-track`, and keeping both slots
          in the tree (`null` when unmounted) is what stops React from remounting
          a panel that has to stay mounted across a track switch. */}
      {track === "docker" || tasks.docker ? (
        <DockerTrackPanel active={track === "docker"} onTaskChange={onDockerTask} />
      ) : null}
      {track === "qemu" || tasks.qemu ? (
        <QemuTrackPanel active={track === "qemu"} onTaskChange={onQemuTask} />
      ) : null}
    </>
  );
}
