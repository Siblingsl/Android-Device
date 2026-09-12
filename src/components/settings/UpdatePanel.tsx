import { useEffect, useRef, useState } from "react";
import { Check, Download, RefreshCw } from "lucide-react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import type { AppSettings } from "../../types";
import { isUpdaterConfigured, updateStateAfterCancellation } from "../../lib/updateConfig";

interface Props {
  settings: AppSettings;
  currentVersion: string;
  setStatusText: (text: string) => void;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
}

export function UpdatePanel({ settings, currentVersion, setStatusText, onSettingsChange }: Props) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "available" | "latest" | "error" | "downloading">("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("未检查");
  const updateRef = useRef<Update | null>(null);
  const cancelRequestedRef = useRef(false);
  const updaterConfigured = isUpdaterConfigured(import.meta.env.VITE_RDC_UPDATE_CONFIGURED);

  useEffect(() => () => { void updateRef.current?.close().catch(() => undefined); }, []);

  const checkForUpdate = async () => {
    if (!updaterConfigured) {
      setState("error");
      setMessage("此构建未配置签名更新源，请使用 tauri:build:release 生成正式包");
      return;
    }
    if (!("__TAURI_INTERNALS__" in window)) {
      setState("error");
      setMessage("浏览器预览不可检查更新，请使用桌面版");
      return;
    }
    setState("checking");
    setMessage("正在检查更新…");
    cancelRequestedRef.current = false;
    try {
      await updateRef.current?.close().catch(() => undefined);
      const next = await check({
        proxy: settings.proxy.trim() || undefined,
        timeout: 10_000,
        headers: { "X-Redroid-Update-Channel": settings.updateChannel || "stable" },
      });
      updateRef.current = next;
      setUpdate(next);
      if (!next) {
        setState("latest");
        setMessage("当前已是最新版本");
      } else if (next.version === settings.skippedUpdateVersion) {
        setState("latest");
        setMessage(`已跳过版本 ${next.version}`);
      } else {
        setState("available");
        setMessage(`发现新版本 ${next.version}`);
      }
    } catch (error) {
      setState("error");
      setMessage(`检查失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const skip = () => {
    if (!update) return;
    onSettingsChange({ skippedUpdateVersion: update.version });
    setState("latest");
    setMessage(`已跳过版本 ${update.version}`);
  };

  const restoreSkipped = () => {
    onSettingsChange({ skippedUpdateVersion: "" });
    setState("available");
    setMessage(update ? `发现新版本 ${update.version}` : "已恢复版本提醒，请重新检查更新");
  };

  const install = async () => {
    if (!update) return;
    if (!confirm(`确认下载并安装 ${update.version} 吗？安装时应用会退出。`)) return;
    cancelRequestedRef.current = false;
    setState("downloading");
    setProgress(0);
    try {
      let total = 0;
      let received = 0;
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          received += event.data.chunkLength;
          setProgress(total ? Math.min(100, Math.round(received / total * 100)) : 0);
        }
        if (event.event === "Finished") setProgress(100);
      });
      await update.install({ restartAfterInstall: true });
      setStatusText("更新安装程序已启动");
    } catch (error) {
      if (cancelRequestedRef.current) {
        const next = updateStateAfterCancellation();
        setUpdate(null);
        updateRef.current = null;
        setState(next.state);
        setProgress(next.progress);
        setMessage(next.message);
        return;
      }
      setState("error");
      setMessage(`下载或安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const cancelDownload = async () => {
    cancelRequestedRef.current = true;
    try {
      await updateRef.current?.close();
    } catch {
      // Closing is best-effort; the cancellation state still prevents a false failure.
    }
    const next = updateStateAfterCancellation();
    setUpdate(null);
    updateRef.current = null;
    setState(next.state);
    setProgress(next.progress);
    setMessage(next.message);
    setStatusText(next.message);
  };

  return (
    <Card className="update-panel" title="更新">
      <div className="update-panel-row">
        <div>
          <div className="update-panel-title">当前版本 {currentVersion}</div>
          <div className="muted">{message}{state === "downloading" && ` · ${progress}%`}</div>
          {!updaterConfigured && <div className="muted">开发构建不会连接更新服务。</div>}
          {update?.body && <div className="update-notes">更新说明：{update.body}</div>}
        </div>
        <div className="row">
          {state === "downloading" && <Button size="sm" variant="danger" onClick={() => void cancelDownload()}>取消下载</Button>}
          {update && state === "available" && <><Button size="sm" variant="ghost" onClick={skip}>跳过此版本</Button><Button size="sm" variant="primary" icon={<Download size={13} />} onClick={() => void install()}>下载并安装</Button></>}
          {update && state === "latest" && update.version === settings.skippedUpdateVersion && <Button size="sm" variant="ghost" onClick={restoreSkipped}>恢复提醒</Button>}
          <Button size="sm" variant="ghost" disabled={!updaterConfigured} loading={state === "checking" || state === "downloading"} icon={state === "latest" ? <Check size={13} /> : <RefreshCw size={13} />} onClick={() => void checkForUpdate()}>检查更新</Button>
        </div>
      </div>
    </Card>
  );
}
