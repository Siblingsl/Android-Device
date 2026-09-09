import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useI18n } from "../i18n";
import { useAppStore } from "../stores/appStore";

type UpdateState = "idle" | "unavailable";

export function UpdateCenterPage() {
  const { t } = useI18n();
  const setStatusText = useAppStore((state) => state.setStatusText);
  const [state, setState] = useState<UpdateState>("idle");

  const checkForUpdates = () => {
    setState("unavailable");
    setStatusText(t("updates.unavailableShort"));
  };

  return (
    <div className="update-workbench">
      <div className="page-header update-header-rail">
        <div>
          <h1 className="page-title">{t("updates.title")}</h1>
          <div className="page-subtitle">{t("updates.subtitle")}</div>
        </div>
        <div className="row update-header-actions">
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={checkForUpdates}>
            {t("updates.check")}
          </Button>
          <a
            className="btn secondary"
            href="https://github.com/Siblingsl/Android-Device"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} />
            {t("updates.docs")}
          </a>
        </div>
      </div>

      <div className="update-grid">
        <Card className="update-status-card" title={t("updates.statusTitle")}>
          <div className="update-status-symbol" aria-hidden="true"><ShieldCheck size={20} /></div>
          <div>
            <strong>{state === "unavailable" ? t("updates.unavailable") : t("updates.sourceMissing")}</strong>
            <p>{state === "unavailable" ? t("updates.unavailableDetail") : t("updates.sourceMissingDetail")}</p>
          </div>
          <div className="update-meta-row">
            <span>{t("updates.currentVersion")}</span>
            <span className="mono">0.1.0</span>
          </div>
        </Card>
        <Card title={t("updates.downloadTitle")}>
          <div className="empty-state">{t("updates.downloadUnavailable")}</div>
        </Card>
      </div>
    </div>
  );
}
