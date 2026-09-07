import { useI18n } from "../../i18n";
import type { ProbeHit, ToolKind } from "../../hooks/useToolProbe";

const LABELS: Record<ToolKind, string> = {
  docker: "Docker",
  adb: "ADB",
  scrcpy: "Scrcpy",
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
    <span className={hit?.ok ? "ok" : "bad"} style={{ fontSize: 13, fontWeight: 600 }}>
      {LABELS[kind]} {hit ? (hit.ok ? t("common.tool.available") : t("common.tool.unavailable")) : t("common.tool.probing")}
      {hit?.text ? ` · ${hit.text}` : ""}
    </span>
  );
}
