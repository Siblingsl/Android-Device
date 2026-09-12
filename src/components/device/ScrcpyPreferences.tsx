import { useEffect, useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { buildScrcpyArgs, defaultScrcpyPreferences, normalizeScrcpyPreferences, parseScrcpyArgs, scrcpyScopeStorageKey, type ScrcpyPreferences } from "../../lib/scrcpyPreferences";
import { DeviceService } from "../../services/deviceService";
import { Button } from "../ui/Button";

interface Props {
  serial: string;
  initialArgs: string;
  disabled?: boolean;
  onChange: (args: string) => void;
  setStatusText: (text: string) => void;
}

type Scope = "device" | "global" | "group";

function storageKey(scope: Scope, serial: string, group: string) {
  return scrcpyScopeStorageKey(scope, serial, group);
}

export function ScrcpyPreferences({ serial, initialArgs, disabled = false, onChange, setStatusText }: Props) {
  const [scope, setScope] = useState<Scope>("device");
  const [group, setGroup] = useState("");
  const [prefs, setPrefs] = useState<ScrcpyPreferences>(() => parseScrcpyArgs(initialArgs));
  const [showAdvanced, setShowAdvanced] = useState(false);

  const args = useMemo(() => buildScrcpyArgs(prefs), [prefs]);

  useEffect(() => {
    onChange(args);
  }, [args, onChange]);

  const update = <K extends keyof ScrcpyPreferences>(key: K, value: ScrcpyPreferences[K]) => {
    setPrefs((current) => normalizeScrcpyPreferences({ ...current, [key]: value }));
  };

  const loadScope = (nextScope: Scope, nextGroup = group) => {
    setScope(nextScope);
    try {
      const raw = localStorage.getItem(storageKey(nextScope, serial, nextGroup));
      setPrefs(raw ? normalizeScrcpyPreferences(JSON.parse(raw) as Partial<ScrcpyPreferences>) : parseScrcpyArgs(initialArgs));
    } catch {
      setPrefs(parseScrcpyArgs(initialArgs));
    }
  };

  const save = () => {
    if (scope === "group" && !group.trim()) {
      setStatusText("请先填写设备组名称");
      return;
    }
    try {
      localStorage.setItem(storageKey(scope, serial, group), JSON.stringify(prefs));
      setStatusText(`${scope === "global" ? "全局" : scope === "group" ? `设备组 ${group}` : "当前设备"} Scrcpy 配置已保存`);
    } catch {
      setStatusText("Scrcpy 配置保存失败");
    }
  };

  const apply = async () => {
    setStatusText("正在按当前配置启动 Scrcpy…");
    const result = await DeviceService.scrcpyStart(serial, prefs.maxSize, prefs.bitRate, args);
    setStatusText(result.success ? "Scrcpy 已按当前配置启动" : result.stderr || result.stdout || "Scrcpy 启动失败");
  };

  return (
    <section className="scrcpy-preferences" aria-label="高级 Scrcpy 配置">
      <div className="row-between scrcpy-preferences-title">
        <div className="row"><SlidersHorizontal size={14} /><strong>高级 Scrcpy 配置</strong></div>
        <label className="row scrcpy-scope">作用域
          <select value={scope} onChange={(event) => loadScope(event.target.value as Scope)}>
            <option value="device">当前设备</option>
            <option value="global">全局默认</option>
            <option value="group">设备组</option>
          </select>
        </label>
      </div>
      {scope === "group" && <input className="scrcpy-group-input" value={group} onChange={(event) => setGroup(event.target.value)} placeholder="设备组名称" />}
      <div className="form-grid scrcpy-basic-grid">
        <label className="field">最大分辨率<input type="number" min={240} max={8192} value={prefs.maxSize} disabled={disabled} onChange={(event) => update("maxSize", Number(event.target.value))} /></label>
        <label className="field">视频码率（Mbps）<input type="number" min={1} max={200} value={prefs.bitRate} disabled={disabled} onChange={(event) => update("bitRate", Number(event.target.value))} /></label>
        <label className="field">最大 FPS<input type="number" min={0} max={240} value={prefs.maxFps} disabled={disabled} onChange={(event) => update("maxFps", Number(event.target.value))} /></label>
        <label className="field">视频编码<select value={prefs.videoCodec} disabled={disabled} onChange={(event) => update("videoCodec", event.target.value as ScrcpyPreferences["videoCodec"])}><option value="">自动</option><option value="h264">H.264</option><option value="h265">H.265</option><option value="av1">AV1</option></select></label>
        <label className="field">视频来源<select value={prefs.videoSource} disabled={disabled} onChange={(event) => update("videoSource", event.target.value as ScrcpyPreferences["videoSource"])}><option value="">默认屏幕</option><option value="display">屏幕</option><option value="camera">摄像头</option></select></label>
        <label className="field">摄像头分辨率<input value={prefs.cameraSize} disabled={disabled} onChange={(event) => update("cameraSize", event.target.value)} placeholder="例如 1920x1080" /></label>
        <label className="field">摄像头 FPS<input type="number" min={0} max={240} value={prefs.cameraFps} disabled={disabled} onChange={(event) => update("cameraFps", Number(event.target.value))} /></label>
        <label className="field">方向<select value={prefs.orientation} disabled={disabled} onChange={(event) => update("orientation", event.target.value as ScrcpyPreferences["orientation"])}><option value="">自动</option><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option><option value="flip0">水平翻转 0°</option><option value="flip90">水平翻转 90°</option><option value="flip180">水平翻转 180°</option><option value="flip270">水平翻转 270°</option></select></label>
        <label className="field">Display ID<input value={prefs.displayId} disabled={disabled} onChange={(event) => update("displayId", event.target.value)} placeholder="默认 Display" /></label>
          <label className="field">虚拟 Display<input value={prefs.newDisplay} disabled={disabled} onChange={(event) => update("newDisplay", event.target.value)} placeholder="例如 1080x1920" /></label>
      </div>
      <details open={showAdvanced} onToggle={(event) => setShowAdvanced((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>更多参数</summary>
        <div className="form-grid scrcpy-advanced-grid">
          <label className="field">裁剪<input value={prefs.crop} disabled={disabled} onChange={(event) => update("crop", event.target.value)} placeholder="宽:高:x:y" /></label>
          <label className="field">视频编码器<input value={prefs.videoEncoder} disabled={disabled} onChange={(event) => update("videoEncoder", event.target.value)} placeholder="设备编码器名称" /></label>
          <label className="field">音频来源<select value={prefs.audioSource} disabled={disabled} onChange={(event) => update("audioSource", event.target.value as ScrcpyPreferences["audioSource"])}><option value="">默认</option><option value="output">系统输出</option><option value="playback">播放</option><option value="mic">麦克风</option><option value="mic-unprocessed">未处理麦克风</option><option value="mic-camcorder">摄像机麦克风</option><option value="mic-voice-recognition">语音识别麦克风</option><option value="mic-voice-communication">通话麦克风</option><option value="voice-call">通话</option><option value="voice-call-uplink">通话上行</option><option value="voice-call-downlink">通话下行</option><option value="voice-performance">演出</option></select></label>
          <label className="field">音频编码<select value={prefs.audioCodec} disabled={disabled} onChange={(event) => update("audioCodec", event.target.value as ScrcpyPreferences["audioCodec"])}><option value="">默认</option><option value="opus">Opus</option><option value="aac">AAC</option><option value="flac">FLAC</option><option value="raw">Raw</option></select></label>
          <label className="field">音频编码器<input value={prefs.audioEncoder} disabled={disabled} onChange={(event) => update("audioEncoder", event.target.value)} placeholder="设备编码器名称" /></label>
          <label className="field">音频码率（Mbps）<input type="number" min={1} max={200} value={prefs.audioBitRate} disabled={disabled} onChange={(event) => update("audioBitRate", Number(event.target.value))} /></label>
          <label className="field">音频缓冲（ms）<input type="number" min={0} max={5000} value={prefs.audioBuffer} disabled={disabled} onChange={(event) => update("audioBuffer", Number(event.target.value))} /></label>
          <label className="field">视频缓冲（ms）<input type="number" min={0} max={10000} value={prefs.videoBuffer} disabled={disabled} onChange={(event) => update("videoBuffer", Number(event.target.value))} /></label>
          <label className="field">v4l2 缓冲（ms）<input type="number" min={0} max={10000} value={prefs.v4l2Buffer} disabled={disabled} onChange={(event) => update("v4l2Buffer", Number(event.target.value))} /></label>
          <label className="field">画面角度（°）<input type="number" min={-360} max={360} value={prefs.angle} disabled={disabled} onChange={(event) => update("angle", Number(event.target.value))} /></label>
          <label className="field">音频输出缓冲（ms）<input type="number" min={0} max={10000} value={prefs.audioOutputBuffer} disabled={disabled} onChange={(event) => update("audioOutputBuffer", Number(event.target.value))} /></label>
          <label className="field">摄像头方向<select value={prefs.cameraFacing} disabled={disabled || Boolean(prefs.cameraId.trim())} onChange={(event) => update("cameraFacing", event.target.value as ScrcpyPreferences["cameraFacing"])}><option value="">自动</option><option value="back">后置</option><option value="front">前置</option><option value="external">外接</option></select></label>
          <label className="field">摄像头 ID<input value={prefs.cameraId} disabled={disabled} onChange={(event) => update("cameraId", event.target.value)} placeholder="默认摄像头" /></label>
          <label className="field">摄像头比例<input value={prefs.cameraAspectRatio} disabled={disabled} onChange={(event) => update("cameraAspectRatio", event.target.value)} placeholder="sensor / 4:3" /></label>
          <label className="field">摄像头变焦<input type="number" min={0} max={100} step={0.1} value={prefs.cameraZoom ?? ""} disabled={disabled} onChange={(event) => update("cameraZoom", event.target.value === "" ? null : Number(event.target.value))} placeholder="设备支持时可用" /></label>
          <label className="field">熄屏超时（秒）<input type="number" min={0} max={86400} value={prefs.screenOffTimeout} disabled={disabled} onChange={(event) => update("screenOffTimeout", Number(event.target.value))} placeholder="0 为默认" /></label>
          <label className="field">键盘模式<select value={prefs.keyboard} disabled={disabled} onChange={(event) => update("keyboard", event.target.value as ScrcpyPreferences["keyboard"])}><option value="">默认</option><option value="disabled">禁用</option><option value="sdk">SDK</option><option value="uhid">UHID</option><option value="aoa">AOA</option></select></label>
          <label className="field">鼠标模式<select value={prefs.mouse} disabled={disabled} onChange={(event) => update("mouse", event.target.value as ScrcpyPreferences["mouse"])}><option value="">默认</option><option value="disabled">禁用</option><option value="sdk">SDK</option><option value="uhid">UHID</option><option value="aoa">AOA</option></select></label>
          <label className="field">手柄模式<select value={prefs.gamepad} disabled={disabled} onChange={(event) => update("gamepad", event.target.value as ScrcpyPreferences["gamepad"])}><option value="">默认</option><option value="disabled">禁用</option><option value="sdk">SDK</option><option value="uhid">UHID</option><option value="aoa">AOA</option></select></label>
          <label className="field">鼠标绑定<input value={prefs.mouseBind} disabled={disabled} onChange={(event) => update("mouseBind", event.target.value)} placeholder="bhsn:++++" /></label>
          <label className="field">键盘注入<select value={prefs.keyboardInject} disabled={disabled} onChange={(event) => update("keyboardInject", event.target.value as ScrcpyPreferences["keyboardInject"])}><option value="">默认</option><option value="prefer-text">优先文本</option><option value="raw-key-events">始终原始按键</option></select></label>
          <label className="field">画面翻转<select value={prefs.flip} disabled={disabled} onChange={(event) => update("flip", event.target.value as ScrcpyPreferences["flip"])}><option value="">不翻转</option><option value="0">水平</option><option value="1">垂直</option></select></label>
          <label className="field">Display 输入法<select value={prefs.displayImePolicy} disabled={disabled} onChange={(event) => update("displayImePolicy", event.target.value as ScrcpyPreferences["displayImePolicy"])}><option value="">默认</option><option value="local">本机输入法</option></select></label>
          <label className="field">窗口宽<input type="number" min={0} value={prefs.windowWidth} disabled={disabled} onChange={(event) => update("windowWidth", Number(event.target.value))} /></label>
          <label className="field">窗口高<input type="number" min={0} value={prefs.windowHeight} disabled={disabled} onChange={(event) => update("windowHeight", Number(event.target.value))} /></label>
          <label className="field">窗口 X<input type="number" value={prefs.windowX ?? ""} disabled={disabled} onChange={(event) => update("windowX", event.target.value === "" ? null : Number(event.target.value))} /></label>
          <label className="field">窗口 Y<input type="number" value={prefs.windowY ?? ""} disabled={disabled} onChange={(event) => update("windowY", event.target.value === "" ? null : Number(event.target.value))} /></label>
          <label className="field">窗口标题<input value={prefs.windowTitle} disabled={disabled} onChange={(event) => update("windowTitle", event.target.value)} placeholder="设备名称" /></label>
          <label className="field">窗口背景色<input value={prefs.backgroundColor} disabled={disabled} onChange={(event) => update("backgroundColor", event.target.value)} placeholder="#112233" /></label>
        </div>
        <div className="row scrcpy-checks">
          {(["noVideo", "noAudio", "audioDuplicate", "noPlayback", "noVideoPlayback", "noAudioPlayback", "cameraHighSpeed", "cameraTorch", "stayAwake", "keepActive", "turnScreenOff", "powerOffOnClose", "noPowerOn", "disableScreensaver", "showTouches", "noControl", "flexDisplay", "noVdDestroyContent", "alwaysOnTop", "borderless", "fullscreen"] as const).map((key) => {
            const labels: Record<typeof key, string> = { noVideo: "禁用视频", noAudio: "禁用音频", audioDuplicate: "设备保留音频", noPlayback: "禁用回放", noVideoPlayback: "禁用视频回放", noAudioPlayback: "禁用音频回放", cameraHighSpeed: "摄像头高速", cameraTorch: "摄像头闪光灯", stayAwake: "保持唤醒", keepActive: "保持活动", turnScreenOff: "控制时熄屏", powerOffOnClose: "关闭时断电", noPowerOn: "不自动亮屏", disableScreensaver: "禁用屏保", showTouches: "显示触摸点", noControl: "禁用控制", flexDisplay: "弹性 Display", noVdDestroyContent: "保留虚拟 Display 内容", alwaysOnTop: "窗口置顶", borderless: "无边框", fullscreen: "启动全屏" };
            return <label key={key} className="row"><input type="checkbox" checked={prefs[key]} disabled={disabled} onChange={(event) => update(key, event.target.checked)} />{labels[key]}</label>;
          })}
        </div>
      </details>
      <div className="row scrcpy-preferences-actions">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setPrefs(defaultScrcpyPreferences)}>恢复默认</Button>
        <Button size="sm" disabled={disabled} onClick={save}>保存配置</Button>
        <Button size="sm" variant="primary" disabled={disabled} onClick={() => void apply()}>按此配置启动</Button>
        <code className="scrcpy-args-preview">{args}</code>
      </div>
    </section>
  );
}
