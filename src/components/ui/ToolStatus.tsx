import { useI18n } from "../../i18n";
import type { ProbeHit, ToolKind } from "../../hooks/useToolProbe";

const LABELS: Record<ToolKind, string> = {
  docker: "Docker",
  adb: "ADB",
  scrcpy: "Scrcpy",
  gnirehtet: "Gnirehtet",
};

export function ToolStatus({
  kind,
  hit,
}: {
  kind: ToolKind;
  hit?: ProbeHit;
}) {
  const { t } = useI18n();
  return (
    <span className={`tool-status ${hit?.ok ? "ok" : "bad"}`}>
      {LABELS[kind]} {hit ? (hit.ok ? t("common.tool.available") : t("common.tool.unavailable")) : t("common.tool.probing")}
      {hit?.text ? ` · ${hit.text}` : ""}
    </span>
  );
}
