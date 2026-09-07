import { useI18n } from "../../i18n";
import clsx from "clsx";

export function StatusDot({ online, label }: { online: boolean; label?: string }) {
  const { t } = useI18n();
  return (
    <span className={clsx("badge", online ? "online" : "offline")}>
      <span className="dot" />
      {label ?? (online ? t("common.online") : t("common.offline"))}
    </span>
  );
}
