import { Download, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useI18n } from "../i18n";
import { useAppStore } from "../stores/appStore";
import { DeviceService, type UpdateAsset, type UpdateCheckResult } from "../services/deviceService";

type UpdateState = "idle" | "checking" | "ready" | "error" | "downloaded";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateCenterPage() {
  const { t } = useI18n();
  const setStatusText = useAppStore((state) => state.setStatusText);
  const [state, setState] = useState<UpdateState>("idle");
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState("");
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [downloadPath, setDownloadPath] = useState("");

  const checkForUpdates = async () => {
    if (state === "checking") return;
    setState("checking");
    setError("");
    setDownloadPath("");
    setStatusText(t("updates.checkingShort"));
    try {
      const next = await DeviceService.checkForUpdates();
      setResult(next);
      setState("ready");
      setStatusText(next.updateAvailable ? t("updates.availableShort", { version: next.latest?.tagName || "" }) : t("updates.checkedShort"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setState("error");
      setStatusText(t("updates.checkFailedShort"));
    }
  };

  const downloadAsset = async (asset: UpdateAsset) => {
    if (downloadBusy) return;
    setDownloadBusy(asset.name);
    setError("");
    try {
      const path = await DeviceService.downloadUpdate({ name: asset.name, downloadUrl: asset.downloadUrl });
      setDownloadPath(path);
      setState("downloaded");
      setStatusText(t("updates.downloadedShort"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setState("error");
      setStatusText(t("updates.downloadFailedShort"));
    } finally {
      setDownloadBusy(null);
    }
  };

  const latest = result?.latest;
  const title = state === "checking"
    ? t("updates.checking")
    : state === "error"
      ? t("updates.checkFailed")
      : latest && result?.updateAvailable
        ? t("updates.available", { version: latest.tagName })
        : result?.latest
          ? t("updates.upToDate")
          : result
            ? t("updates.noRelease")
            : t("updates.sourceConfigured");
  const detail = state === "checking"
    ? t("updates.checkingDetail")
    : error || (state === "error" ? t("updates.checkFailedDetail") : result?.latest?.body || t("updates.sourceConfiguredDetail"));

  return (
    <div className="update-workbench">
      <div className="page-header update-header-rail">
        <div>
          <h1 className="page-title">{t("updates.title")}</h1>
          <div className="page-subtitle">{t("updates.subtitle")}</div>
        </div>
        <div className="row update-header-actions">
          <Button variant="secondary" icon={<RefreshCw size={14} />} loading={state === "checking"} onClick={() => void checkForUpdates()}>
            {t("updates.check")}
          </Button>
          <a className="btn secondary" href="https://github.com/Siblingsl/Android-Device" target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            {t("updates.docs")}
          </a>
        </div>
      </div>

      <div className="update-grid">
        <Card className="update-status-card" title={t("updates.statusTitle")}>
          <div className="update-status-symbol" aria-hidden="true"><ShieldCheck size={20} /></div>
          <div>
            <strong>{title}</strong>
            <p>{detail}</p>
          </div>
          <div className="update-meta-row">
            <span>{t("updates.currentVersion")}</span>
            <span className="mono">{result?.currentVersion || "0.1.0"}</span>
          </div>
          {latest && (
            <div className="update-release-meta">
              <span>{t("updates.latestRelease")}: <span className="mono">{latest.tagName}</span></span>
              {latest.htmlUrl && <a href={latest.htmlUrl} target="_blank" rel="noreferrer">{t("updates.releasePage")}</a>}
            </div>
          )}
          {downloadPath && <div className="update-download-path">{t("updates.downloadedTo")}: <span className="mono">{downloadPath}</span></div>}
        </Card>
        <Card title={t("updates.downloadTitle")}>
          {latest?.assets.length ? (
            <div className="update-asset-list">
              {latest.assets.map((asset) => (
                <div className="update-asset-row" key={`${asset.name}-${asset.downloadUrl}`}>
                  <div>
                    <strong>{asset.name}</strong>
                    <span>{formatBytes(asset.size)}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Download size={13} />}
                    loading={downloadBusy === asset.name}
                    disabled={Boolean(downloadBusy)}
                    aria-label={t("updates.downloadAsset", { name: asset.name })}
                    onClick={() => void downloadAsset(asset)}
                  >
                    {t("updates.download")}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">{result ? t("updates.noAsset") : t("updates.downloadUnavailable")}</div>
          )}
        </Card>
      </div>
    </div>
  );
}
