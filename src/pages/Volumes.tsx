import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Database, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { Card } from "../components/ui/Card";
import { askConfirm } from "../lib/dialogs";
import { createRequestSequence } from "../lib/requestSequence";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { DeviceService } from "../services/deviceService";
import { probeTool } from "../hooks/useToolProbe";
import { ToolStatus } from "../components/ui/ToolStatus";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type { DockerVolume } from "../types";

function readSession(key: string, fallback = "") {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function VolumesPage() {
  const [volumes, setVolumes] = useState<DockerVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [docker, setDocker] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState(() => readSession("rdc.volumes.query"));
  const [statusFilter, setStatusFilter] = useState<"all" | "idle" | "busy">(() => {
    const v = readSession("rdc.volumes.filter", "all");
    return v === "idle" || v === "busy" ? v : "all";
  });
  const setStatusText = useAppStore((s) => s.setStatusText);
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const dockerPath = useAppStore((s) => s.settings?.dockerPath);
  const navigate = useNavigate();
  const { t } = useI18n();
  const loadSequence = useRef(createRequestSequence()).current;

  const load = async () => {
    const token = loadSequence.begin();
    setLoading(true);
    try {
      const probe = await probeTool("docker", dockerPath);
      if (!loadSequence.isCurrent(token)) return;
      setDocker(probe);
      if (probe.ok) {
        const next = await DeviceService.listVolumes();
        if (!loadSequence.isCurrent(token)) return;
        setVolumes(next);
      } else {
        setVolumes([]);
      }
    } catch (e) {
      if (!loadSequence.isCurrent(token)) return;
      const msg = e instanceof Error ? e.message : String(e);
      setStatusText(t("volumes.refreshFailedWith", { msg }));
    } finally {
      if (!loadSequence.isCurrent(token)) return;
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => loadSequence.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem("rdc.volumes.query", query);
      sessionStorage.setItem("rdc.volumes.filter", statusFilter);
    } catch {
      /* ignore */
    }
  }, [query, statusFilter]);

  const q = query.trim().toLowerCase();
  const match = (v: DockerVolume) =>
    !q ||
    v.name.toLowerCase().includes(q) ||
    (v.containerName || "").toLowerCase().includes(q) ||
    (v.adbSerial || "").toLowerCase().includes(q);
  const rdcAll = volumes.filter((v) => v.isRdc);
  const rdc = rdcAll.filter((v) => {
    if (!match(v)) return false;
    if (statusFilter === "idle") return !v.inUse;
    if (statusFilter === "busy") return v.inUse;
    return true;
  });
  const others = volumes.filter((v) => !v.isRdc && match(v));
  const idle = rdc.filter((v) => !v.inUse);

  const pruneIdle = async () => {
    if (docker?.ok === false) {
      void alert(t("volumes.dockerUnavailable", { text: docker.text }));
      return;
    }
    if (idle.length === 0) {
      setStatusText(q ? t("volumes.noIdleScoped") : t("volumes.noIdle"));
      return;
    }
    if (
      !(await askConfirm(
        t("volumes.pruneConfirm", {
          n: idle.length,
          scope: q ? t("volumes.pruneScope") : "",
          list: idle.map((v) => v.name).join("\n"),
        }),
      ))
    ) {
      return;
    }
    setBusy("prune");
    setStatusText(t("volumes.pruning"));
    const results: { name: string; ok: boolean; detail: string }[] = [];
    try {
      for (const v of idle) {
        const r = await DeviceService.removeVolume(v.name, false);
        results.push({
          name: v.name,
          ok: r.success,
          detail: r.success ? t("volumes.pruned") : r.stderr || r.stdout || t("volumes.failed"),
        });
      }
      await load();
      const ok = results.filter((r) => r.ok).length;
      setStatusText(t("volumes.pruneDone", { ok, total: idle.length }));
      void alert(results.map((r) => `${r.name}: ${r.detail}`).join("\n"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (v: DockerVolume) => {
    if (v.inUse) {
      void alert(t("volumes.inUseAlert", { name: v.name }));
      return;
    }
    if (!(await askConfirm(t("volumes.removeConfirm", { name: v.name })))) return;
    setBusy(v.name);
    setStatusText(t("volumes.removing", { name: v.name }));
    try {
      const r = await DeviceService.removeVolume(v.name, false);
      if (!r.success) {
        void alert(r.stderr || r.stdout || t("volumes.removeFailed"));
      }
      await load();
      setStatusText(r.success ? t("volumes.removed") : t("volumes.removeFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{t("volumes.page.title")}</div>
          <div className="page-subtitle">{t("volumes.page.subtitle")}</div>
        </div>
        <div className="row">
          <Button
            variant="danger"
            icon={<Trash2 size={15} />}
            disabled={docker?.ok === false || idle.length === 0 || busy === "prune"}
            loading={busy === "prune"}
            onClick={() => void pruneIdle()}
          >
            {t("volumes.prune")}
            {idle.length ? ` (${idle.length})` : ""}
          </Button>
          <Button icon={<RefreshCw size={15} />} onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <ToolStatus kind="docker" hit={docker ?? undefined} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("volumes.search.placeholder")}
          style={{ height: 30, minWidth: 220, padding: "0 10px", borderRadius: 8 }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | "idle" | "busy")}
          style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
        >
          <option value="all">{t("volumes.filter.all", { n: rdcAll.filter(match).length })}</option>
          <option value="idle">{t("volumes.filter.idle", { n: rdcAll.filter((v) => match(v) && !v.inUse).length })}</option>
          <option value="busy">{t("volumes.filter.busy", { n: rdcAll.filter((v) => match(v) && v.inUse).length })}</option>
        </select>
      </div>

      <Card title={t("volumes.card.mine", { n: rdc.length })} action={<Database size={16} className="muted" />}>
        {loading ? (
          <Skeleton count={4} height={32} />
        ) : rdc.length === 0 ? (
          <div className="empty-state">
            {rdcAll.length === 0 ? (
              <>
                {t("volumes.empty.none")}
                <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => navigate("/docker")}>
                  {t("common.panel.goCreate")}
                </Button>
              </>
            ) : (
              <>
                {t("volumes.empty.noMatch")}
                <Button
                  size="sm"
                  variant="ghost"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                  }}
                >
                  {t("volumes.empty.clearFilter")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("volumes.table.name")}</th>
                <th>{t("volumes.table.instance")}</th>
                <th>{t("volumes.table.size")}</th>
                <th>{t("volumes.table.status")}</th>
                <th>{t("volumes.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rdc.map((v) => (
                <tr key={v.name}>
                  <td className="mono">
                    <button
                      type="button"
                      title={t("volumes.copyName")}
                      style={{
                        textDecoration: "underline",
                        background: "none",
                        border: 0,
                        padding: 0,
                        color: "inherit",
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        void copyText(v.name).then(
                          () => setStatusText(t("common.panel.copied", { value: v.name })),
                          () => setStatusText(t("common.panel.copyFailed")),
                        );
                      }}
                    >
                      {v.name}
                    </button>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {v.containerName || v.adbSerial || "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }} title={v.mountpoint || undefined}>
                    {v.size || "—"}
                  </td>
                  <td>{v.inUse ? t("volumes.status.inUse") : t("volumes.status.idle")}</td>
                  <td>
                    <div className="row">
                      <Button
                        size="sm"
                        icon={<Smartphone size={13} />}
                        disabled={!v.adbSerial}
                        onClick={() => {
                          if (!v.adbSerial) return;
                          setSelected(v.adbSerial);
                          navigate(`/devices/${encodeURIComponent(v.adbSerial)}`);
                        }}
                      >
                        {t("volumes.openDevice")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!v.mountpoint}
                        onClick={() => {
                          if (!v.mountpoint) return;
                          void DeviceService.revealInFolder(v.mountpoint).then(
                            () => setStatusText(t("volumes.mountpointOpened")),
                            (e) => setStatusText(String(e)),
                          );
                        }}
                      >
                        {t("volumes.openDir")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={!v.containerName}
                        onClick={() => {
                          const name = (v.containerName || "").replace(/^\/?rdc-/, "");
                          try {
                            sessionStorage.setItem("rdc.docker.instQuery", name);
                          } catch {
                            /* ignore */
                          }
                          navigate("/docker");
                        }}
                      >
                        {t("volumes.openInstance")}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon={<Trash2 size={13} />}
                        disabled={v.inUse || busy === v.name || docker?.ok === false}
                        title={
                          docker?.ok === false
                            ? t("volumes.dockerUnavailable", { text: docker.text })
                            : v.inUse
                              ? t("volumes.title.inUse")
                              : undefined
                        }
                        loading={busy === v.name}
                        onClick={() => void remove(v)}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {others.length > 0 && (
        <Card title={t("volumes.card.others", { n: others.length })}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {t("volumes.card.othersHint")}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t("volumes.table.name")}</th>
                <th>{t("volumes.table.driver")}</th>
              </tr>
            </thead>
            <tbody>
              {others.slice(0, 30).map((v) => (
                <tr key={v.name}>
                  <td className="mono">{v.name}</td>
                  <td>{v.driver || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
