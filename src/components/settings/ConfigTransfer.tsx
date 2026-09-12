import { useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { DeviceService } from "../../services/deviceService";
import { applyClientConfig, buildConfigBackup, parseConfigBackup, type AppConfigBackup } from "../../lib/configTransfer";
import type { AppSettings } from "../../types";

interface Props {
  settings: AppSettings;
  onImported: (settings: AppSettings) => Promise<void>;
  setStatusText: (text: string) => void;
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

export function ConfigTransfer({ settings, onImported, setStatusText }: Props) {
  const [pending, setPending] = useState<AppConfigBackup | null>(null);

  const exportConfig = async () => {
    try {
      const content = JSON.stringify(buildConfigBackup(settings), null, 2);
      if (!isTauri()) {
        const blob = new Blob([content], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "redroid-device-center-config.json";
        anchor.click();
        URL.revokeObjectURL(url);
        setStatusText("配置已下载");
        return;
      }
      const path = await save({
        defaultPath: "redroid-device-center-config.json",
        filters: [{ name: "Redroid 配置", extensions: ["json"] }],
      });
      if (!path) return;
      await DeviceService.writeConfigFile(path, content);
      setStatusText(`配置已导出：${path}`);
    } catch (error) {
      setStatusText(`配置导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const importConfig = async () => {
    try {
      let raw: string | null = null;
      if (isTauri()) {
        const path = await open({ multiple: false, directory: false, filters: [{ name: "Redroid 配置", extensions: ["json"] }] });
        if (typeof path === "string" && path) raw = await DeviceService.readConfigFile(path);
      } else {
        raw = await new Promise<string | null>((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".json,application/json";
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            void file.text().then(resolve).catch(() => resolve(null));
          };
          input.click();
        });
      }
      if (!raw) return;
      const config = parseConfigBackup(raw, settings);
      setPending(config);
    } catch (error) {
      setStatusText(`配置导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyPending = async () => {
    if (!pending) return;
    try {
      await onImported(pending.settings);
      applyClientConfig(pending);
      setPending(null);
      setStatusText("配置已导入并生效");
    } catch (error) {
      setStatusText(`配置导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <Card className="config-transfer" title="配置导入 / 导出">
      <div className="config-transfer-row">
        <div>
          <div className="config-transfer-title">迁移设置、设备备注、布局和快捷键</div>
          <div className="muted">导出的 JSON 不包含设备密码或运行中的临时会话，但会包含 AI 配置中的 API Key；请妥善保存导出文件。导入前会先校验版本和内容。</div>
        </div>
        <div className="row">
          <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void importConfig()}>导入配置</Button>
          <Button size="sm" icon={<Download size={13} />} onClick={() => void exportConfig()}>导出配置</Button>
        </div>
      </div>
      {pending && (
        <div className="config-import-preview" role="dialog" aria-label="配置导入预览">
          <div className="config-import-preview-head">
            <strong>导入预览</strong>
            <span className="muted">版本 {pending.schemaVersion} · {new Date(pending.exportedAt).toLocaleString()}</span>
          </div>
          <div className="config-import-preview-grid">
            <span>应用设置</span><strong>将覆盖</strong>
            <span>设备信息</span><strong>{Object.keys(pending.deviceMetadata).length} 条</strong>
            <span>窗口布局</span><strong>{pending.arrangement.length} 项</strong>
            <span>快捷键</span><strong>{pending.shortcuts.length} 条</strong>
            <span>键盘映射</span><strong>{pending.keyboardMappings.length} 条</strong>
            <span>自动化脚本</span><strong>{pending.automationScripts.length} 个</strong>
            <span>定时任务</span><strong>{pending.scheduledTasks.length} 个</strong>
            <span>AI 配置</span><strong>{pending.agentProfiles.length} 个</strong>
            <span>未知字段</span><strong>{Object.keys(pending.extensions).length} 项将保留</strong>
          </div>
          <div className="row config-import-preview-actions">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>取消</Button>
            <Button size="sm" variant="primary" onClick={() => void applyPending()}>确认导入</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
