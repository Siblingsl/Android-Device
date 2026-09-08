import { useEffect, useRef, useState } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { DeviceService } from "../../services/deviceService";
import { formatShellOutput, runDeviceAction, type ShellResultLike } from "../../lib/deviceActions";
import { useI18n } from "../../i18n";

interface DeviceShellProps {
  serial: string;
  disabled?: boolean;
  diagnostic?: { id: number; message: string } | null;
  onStatus: (message: string) => void;
}

export function DeviceShell({ serial, disabled = false, diagnostic, onStatus }: DeviceShellProps) {
  const { t } = useI18n();
  const [shellCmd, setShellCmd] = useState("");
  const [shellOut, setShellOut] = useState("");
  const [copiedOut, setCopiedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem("rdc.shell.history");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
    } catch {
      return [];
    }
  });
  const [favorites, setFavorites] = useState<string[]>(() => {
    const fallback = [
      "getprop ro.build.version.release",
      "wm size",
      "pm list packages -3",
      "dumpsys activity activities | head -30",
    ];
    try {
      const raw = localStorage.getItem("rdc.shell.favorites");
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") && parsed.length
        ? parsed
        : fallback;
    } catch {
      return fallback;
    }
  });
  const lastDiagnosticId = useRef<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("rdc.shell.favorites", JSON.stringify(favorites));
    } catch {
      /* ignore */
    }
  }, [favorites]);

  useEffect(() => {
    try {
      sessionStorage.setItem("rdc.shell.history", JSON.stringify(history));
    } catch {
      /* ignore */
    }
  }, [history]);

  useEffect(() => {
    if (!diagnostic || diagnostic.id === lastDiagnosticId.current) return;
    lastDiagnosticId.current = diagnostic.id;
    setShellOut((previous) => `${previous}\n${diagnostic.message}`.trim());
  }, [diagnostic]);

  const runShell = async (command?: string) => {
    const current = (command ?? shellCmd).trim();
    if (!current || disabled || busy) return;
    setBusy(true);
    onStatus(t("detail.control.runningShell"));
    let received: ShellResultLike | null = null;
    try {
      await runDeviceAction(
        async () => {
          const result = await DeviceService.shell(serial, current);
          received = result;
          return result;
        },
        {
          fallback: t("detail.control.shellFailed"),
          onSuccess: (result) => {
            setShellOut(formatShellOutput(result.stdout || "", result.stderr || "", result.exitCode) || "(empty)");
            setHistory((items) => [current, ...items.filter((item) => item !== current)].slice(0, 30));
            onStatus(t("detail.status.ready"));
          },
          onError: (error) => {
            setShellOut(
              formatShellOutput(
                received?.stdout || "",
                received?.stderr || error.message,
                received?.exitCode,
              ) || error.message,
            );
            onStatus(error.message || t("detail.control.shellFailed"));
          },
        },
      );
    } catch {
      // Error feedback is handled by the lifecycle callbacks.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="ADB Shell">
      <div className="field">
        <label>{t("detail.control.command")}</label>
        <div className="row">
          <input
            style={{ flex: 1 }}
            className="mono"
            value={shellCmd}
            onChange={(event) => setShellCmd(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runShell();
            }}
            placeholder="shell command..."
            disabled={disabled || busy}
          />
          <Button variant="primary" loading={busy} disabled={disabled || !shellCmd.trim()} onClick={() => void runShell()}>
            {t("detail.control.run")}
          </Button>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          {t("detail.control.favorites")}
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {favorites.map((favorite) => (
            <span key={favorite} className="row" style={{ gap: 0 }}>
              <Button
                size="sm"
                variant="ghost"
                title={favorite}
                disabled={disabled || busy}
                onClick={() => {
                  setShellCmd(favorite);
                  void runShell(favorite);
                }}
              >
                {favorite.length > 28 ? `${favorite.slice(0, 28)}…` : favorite}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title={t("detail.control.removeFavorite")}
                disabled={busy}
                onClick={() => setFavorites((items) => items.filter((item) => item !== favorite))}
              >
                ×
              </Button>
            </span>
          ))}
          <Button
            size="sm"
            variant="secondary"
            disabled={!shellCmd.trim() || busy}
            onClick={() => {
              const command = shellCmd.trim();
              setFavorites((items) =>
                items.includes(command) ? items.filter((item) => item !== command) : [command, ...items].slice(0, 12),
              );
            }}
          >
            {favorites.includes(shellCmd.trim()) ? t("detail.control.unfavorite") : t("detail.control.favorite")}
          </Button>
        </div>
      </div>
      {history.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="row-between" style={{ marginBottom: 6 }}>
            <div className="muted" style={{ fontSize: 12 }}>{t("detail.control.history")}</div>
            <Button size="sm" variant="ghost" onClick={() => setHistory([])}>
              {t("detail.control.clearHistory")}
            </Button>
          </div>
          <div className="stack">
            {history.slice(0, 5).map((item) => (
              <button key={item} className="mono muted" style={{ textAlign: "left" }} onClick={() => setShellCmd(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="shell-output" style={{ marginTop: 12 }}>
        {shellOut || t("detail.control.outputPlaceholder")}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button
          size="sm"
          disabled={!shellOut}
          onClick={() => {
            void navigator.clipboard.writeText(shellOut).then(
              () => {
                setCopiedOut(true);
                window.setTimeout(() => setCopiedOut(false), 1500);
              },
              () => onStatus(t("common.panel.copyFailed")),
            );
          }}
        >
          {copiedOut ? t("detail.control.copiedOutput") : t("detail.control.copyOutput")}
        </Button>
        <Button size="sm" variant="ghost" disabled={!shellOut} onClick={() => setShellOut("")}>
          {t("detail.control.clearOutput")}
        </Button>
      </div>
    </Card>
  );
}
