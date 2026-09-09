import { useEffect, useRef, useState } from "react";
import { Copy, Download, RefreshCw, Trash2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { copyText } from "../lib/clipboard";
import { askConfirm } from "../lib/dialogs";
import { createRequestSequence } from "../lib/requestSequence";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { DeviceService } from "../services/deviceService";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type { LogEntry } from "../types";

function readSession(key: string, fallback: string) {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeSession(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function LogsPage() {
  const { t } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState(() => readSession("rdc.logs.source", "all"));
  const [level, setLevel] = useState(() => readSession("rdc.logs.level", "all"));
  const [keyword, setKeyword] = useState(() => readSession("rdc.logs.keyword", ""));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedList, setCopiedList] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const pausedRef = useRef(false);
  const resumeTimer = useRef(0);
  const logsRef = useRef<LogEntry[]>([]);
  const loadRef = useRef<(soft?: boolean) => Promise<void>>(async () => {});
  const loadSequence = useRef(createRequestSequence()).current;
  const loadingRequest = useRef<number | null>(null);
  const logPath = useAppStore((s) => s.settings?.logPath);
  const setStatusText = useAppStore((s) => s.setStatusText);

  const setPausedNow = (next: boolean) => {
    pausedRef.current = next;
    setPaused(next);
  };

  const bumpPause = () => {
    setPausedNow(true);
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => {
      setPausedNow(false);
      void loadRef.current(true);
    }, 15000);
  };

  const load = async (soft = false) => {
    const token = loadSequence.begin();
    if (!soft) {
      loadingRequest.current = token;
      setLoading(true);
    }
    try {
      const next = await DeviceService.getLogs({
        source: source === "all" ? undefined : source,
        level: level === "all" ? undefined : level,
        keyword: keyword || undefined,
        limit: 300,
      });
      if (!loadSequence.isCurrent(token)) return;
      if (soft && pausedRef.current) {
        const seen = new Set(logsRef.current.map((l) => l.id));
        const n = next.filter((l) => !seen.has(l.id)).length;
        if (n > 0) setPendingCount(n);
        return;
      }
      logsRef.current = next;
      setPendingCount(0);
      setLogs(next);
    } catch (e) {
      if (loadSequence.isCurrent(token) && !soft) {
        const err = e instanceof Error ? e.message : String(e);
        setStatusText(t("logs.refreshFailed", { err }));
      }
    } finally {
      if (!loadSequence.isCurrent(token)) return;
      if (loadingRequest.current !== null) {
        loadingRequest.current = null;
        setLoading(false);
      }
    }
  };
  loadRef.current = load;

  useEffect(() => {
    writeSession("rdc.logs.source", source);
    writeSession("rdc.logs.level", level);
    writeSession("rdc.logs.keyword", keyword);
  }, [source, level, keyword]);

  useEffect(() => {
    const delay = keyword ? 300 : 0;
    const t = setTimeout(() => void load(false), delay);
    return () => {
      clearTimeout(t);
      loadSequence.invalidate();
    };
  }, [source, level, keyword]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void load(true);
    };
    const t = setInterval(tick, 8000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [source, level, keyword]);

  useEffect(() => () => window.clearTimeout(resumeTimer.current), []);

  return (
    <div className="log-workbench">
      <div className="page-header log-header-rail">
        <div className="log-heading-rail">
          <div className="page-title">{t("logs.title")}</div>
          <div className="page-subtitle">{t("logs.subtitle")}</div>
          <div className="row log-level-rail">
            {(
              [
                ["INFO", "INFO"],
                ["WARN", "WARN"],
                ["ERROR", "ERROR"],
                ["DEBUG", "DEBUG"],
              ] as const
            ).map(([lv, label]) => (
              <button
                key={lv}
                type="button"
                className={`log-line ${lv}`}
                style={{
                  padding: 0,
                  borderBottom: "none",
                  opacity: level === "all" || level === lv ? 1 : 0.4,
                }}
                title={t("logs.filterLevel", { level: label })}
                onClick={() => setLevel(level === lv ? "all" : lv)}
              >
                ● {label}
              </button>
            ))}
          </div>
        </div>
        <div className="row log-action-rail">
          <Button
            variant={level === "ERROR" ? "danger" : "secondary"}
            onClick={() => setLevel(level === "ERROR" ? "all" : "ERROR")}
          >
            {level === "ERROR" ? t("logs.errorOnlyOn") : t("logs.errorOnly")}
          </Button>
          <Button
            variant={paused ? "primary" : "secondary"}
            onClick={() => {
              if (paused) {
                window.clearTimeout(resumeTimer.current);
                setPausedNow(false);
                void load(true);
              } else {
                window.clearTimeout(resumeTimer.current);
                setPausedNow(true);
              }
            }}
          >
            {paused
              ? pendingCount > 0
                ? t("logs.resumeWithCount", { n: pendingCount })
                : t("logs.resume")
              : t("logs.pause")}
          </Button>
          <Button icon={<RefreshCw size={15} />} onClick={() => void load(false)}>
            {t("common.refresh")}
          </Button>
          <Button
            icon={<Trash2 size={15} />}
            variant="danger"
            onClick={async () => {
              if (!(await askConfirm(t("logs.confirmClear")))) return;
              const alsoFile = Boolean(logPath && (await askConfirm(t("logs.confirmClearFile"))));
              try {
                await DeviceService.clearLogs(alsoFile);
                setStatusText(alsoFile ? t("logs.clearedWithFile") : t("logs.cleared"));
                await load();
              } catch (e) {
                const err = e instanceof Error ? e.message : String(e);
                setStatusText(t("logs.clearFailed", { err }));
                void alert(err);
              }
            }}
          >
            {t("logs.clear")}
          </Button>
          {logPath && (
            <Button
              onClick={() =>
                void DeviceService.revealInFolder(logPath).catch((e) => void alert(String(e)))
              }
            >
              {t("logs.openLogDir")}
            </Button>
          )}
          <Button
            icon={<Download size={15} />}
            disabled={logs.length === 0}
            onClick={async () => {
              try {
                const parts = ["redroid-logs"];
                if (source !== "all") parts.push(source);
                if (level !== "all") parts.push(level);
                if (keyword.trim()) parts.push(keyword.trim().replace(/[\\/:*?"<>|]+/g, "_").slice(0, 24));
                const path = await save({
                  defaultPath: `${parts.join("-")}.txt`,
                  filters: [{ name: "Text", extensions: ["txt", "log"] }],
                });
                if (!path) return;
                const content = logs
                  .map((l) => `[${l.timestamp}] [${l.level}] [${l.source}] ${l.message}`)
                  .join("\n");
                const saved = await DeviceService.exportLogs(path, content);
                if (await askConfirm(t("logs.exportConfirm", { path: saved }))) {
                  await DeviceService.revealInFolder(saved);
                }
              } catch (e) {
                if (e) void alert(String(e));
              }
            }}
          >
            {t("logs.export")}
          </Button>
        </div>
      </div>

      <Card className="log-card">
        <div className="log-filter-rail">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">{t("logs.source.all")}</option>
            <option value="System">{t("logs.source.system")}</option>
            <option value="ADB">ADB</option>
            <option value="Docker">Docker</option>
            <option value="Scrcpy">Scrcpy</option>
            <option value="Device">Device</option>
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="all">{t("logs.level.all")}</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
            <option value="DEBUG">DEBUG</option>
          </select>
          <input
            placeholder={t("logs.searchPlaceholder")}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword && (
            <Button size="sm" variant="ghost" onClick={() => setKeyword("")}>
              {t("logs.clearKeyword")}
            </Button>
          )}
        </div>

        <div className="log-status-rail">
          <span className="muted" style={{ fontSize: 12 }}>
            {loading && logs.length === 0
              ? t("common.loading")
              : keyword || source !== "all" || level !== "all"
                ? t("logs.match", { n: logs.length })
                : logs.length >= 300
                  ? t("logs.capped")
                  : t("logs.count", { n: logs.length })}
            {paused ? t("logs.pausedSuffix") : ""}
          </span>
          {paused && (
            <Button
              size="sm"
              variant={pendingCount > 0 ? "primary" : "ghost"}
              onClick={() => {
                window.clearTimeout(resumeTimer.current);
                setPausedNow(false);
                void load(true);
              }}
            >
              {pendingCount > 0 ? t("logs.pending", { n: pendingCount }) : t("logs.resume")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy size={13} />}
            disabled={logs.length === 0}
            onClick={() => {
              const text = logs
                .map((l) => `[${l.timestamp}] [${l.level}] [${l.source}] ${l.message}`)
                .join("\n");
              void copyText(text).then(
                () => {
                  setCopiedList(true);
                  window.setTimeout(() => setCopiedList(false), 1500);
                },
                () => void alert(t("common.panel.copyFailed")),
              );
            }}
          >
            {copiedList ? t("logs.copiedList") : t("logs.copyList")}
          </Button>
        </div>

        <div className="log-surface">
          {loading && logs.length === 0 ? (
            <Skeleton count={10} height={20} />
          ) : logs.length === 0 ? (
            <div className="empty-state">
              {keyword || source !== "all" || level !== "all" ? (
                <>
                  {t("logs.noMatch")}
                  <Button
                    size="sm"
                    variant="ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      setKeyword("");
                      setSource("all");
                      setLevel("all");
                    }}
                  >
                    {t("logs.clearFilters")}
                  </Button>
                </>
              ) : (
                t("logs.empty")
              )}
            </div>
          ) : (
            <div
              className="shell-output"
              style={{ maxHeight: 560, background: "var(--bg)" , color: "var(--text)" }}
              onScroll={bumpPause}
            >
              {logs.map((l) => {
                const text = `[${l.timestamp}] [${l.level}] [${l.source}] ${l.message}`;
                return (
                  <button
                    key={l.id}
                    type="button"
                    className={`log-line ${l.level}`}
                    style={{ display: "block", width: "100%", textAlign: "left" }}
                    title={t("logs.clickToCopy")}
                    onClick={() => {
                      bumpPause();
                      void copyText(text).then(
                        () => {
                          setCopiedId(l.id);
                          window.setTimeout(() => setCopiedId((cur) => (cur === l.id ? null : cur)), 1500);
                        },
                        () => void alert(t("common.panel.copyFailed")),
                      );
                    }}
                  >
                    {copiedId === l.id ? t("logs.copiedSuffix", { text }) : text}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
