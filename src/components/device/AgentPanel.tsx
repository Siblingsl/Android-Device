import { useState } from "react";
import { Bot, Check, Plus, Send, ShieldAlert, Trash2, X } from "lucide-react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { DeviceService } from "../../services/deviceService";
import type { DeviceInfo } from "../../types";
import { dispatchMcpRequest, getDeviceMcpTools } from "../../lib/mcpProtocol";
import {
  AGENT_CONFIG_KEY,
  AGENT_PROFILES_KEY,
  AGENT_SESSIONS_KEY,
  createAgentSessionId,
  parseAgentProfileState,
  parseAgentSessions,
  serializeAgentProfileState,
  serializeAgentSessions,
  upsertAgentSession,
  type AgentProfile,
  type AgentProfileState,
  type AgentSession,
} from "../../lib/agent";
import { useAppStore } from "../../stores/appStore";

type AgentTool = "screenshot" | "device_control" | "start_app" | "install_apk" | "send_text" | "keyevent" | "open_files" | "open_apps" | "apps_list" | "files_list" | "file_delete" | "batch_control" | "network" | "shell" | "recording";
interface AgentAction { tool: AgentTool; arguments: Record<string, unknown>; reason?: string; sessionId?: string; }
interface Props { device: DeviceInfo; setStatusText: (text: string) => void; }

const AI_REQUEST_TIMEOUT_MS = 30_000;

function loadProfiles() {
  try {
    return parseAgentProfileState(localStorage.getItem(AGENT_PROFILES_KEY), localStorage.getItem(AGENT_CONFIG_KEY));
  } catch {
    return parseAgentProfileState(null);
  }
}

function loadSessions() {
  try { return parseAgentSessions(localStorage.getItem(AGENT_SESSIONS_KEY)); } catch { return []; }
}

function profileName(profile: AgentProfile) {
  return profile.name.trim() || "未命名配置";
}

function sessionStatus(status: AgentSession["status"]) {
  return ({ planned: "待确认", confirmed: "执行中", rejected: "已拒绝", success: "已完成", failed: "失败" } as const)[status];
}

function normalizeTool(value: string): AgentTool {
  const legacy: Record<string, AgentTool> = {
    "launch-app": "start_app", "install-apk": "install_apk", "send-text": "send_text",
    "open-files": "open_files", "open-apps": "open_apps", "recording-start": "recording", "recording-stop": "recording",
  };
  if (value === "home" || value === "back" || value === "recent" || value === "lock" || value === "wake") return "device_control";
  return legacy[value] || value as AgentTool;
}

function normalizeArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (["home", "back", "recent", "lock", "wake"].includes(tool)) return { action: tool };
  if (tool === "recording-start" || tool === "recording-stop") return { action: tool === "recording-start" ? "start" : "stop" };
  return args;
}

function extractAction(content: string): AgentAction {
  const clean = content.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(clean) as Partial<AgentAction>;
  const rawTool = String(parsed.tool || "");
  const allowed = ["screenshot", "device_control", "start_app", "install_apk", "send_text", "keyevent", "open_files", "open_apps", "apps_list", "files_list", "file_delete", "batch_control", "network", "shell", "recording", "home", "back", "recent", "lock", "wake", "launch-app", "install-apk", "send-text", "open-files", "open-apps", "recording-start", "recording-stop"];
  if (!allowed.includes(rawTool)) throw new Error("AI 返回了不支持的工具");
  const rawArgs = parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments as Record<string, unknown> : {};
  return { tool: normalizeTool(rawTool), arguments: normalizeArguments(rawTool, rawArgs), reason: parsed.reason };
}

export function AgentPanel({ device, setStatusText }: Props) {
  const devices = useAppStore((state) => state.devices);
  const allDeviceSerials = devices.map((item) => item.serial).filter(Boolean);
  const [profileState, setProfileState] = useState<AgentProfileState>(loadProfiles);
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<AgentAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>(loadSessions);

  const activeProfile = profileState.profiles.find((profile) => profile.id === profileState.selectedId) || profileState.profiles[0];
  const saveProfileState = (next: AgentProfileState) => {
    setProfileState(next);
    try { localStorage.setItem(AGENT_PROFILES_KEY, serializeAgentProfileState(next)); } catch { /* preview */ }
  };
  const updateActiveProfile = (patch: Partial<AgentProfile>) => saveProfileState({
    ...profileState,
    profiles: profileState.profiles.map((profile) => profile.id === activeProfile.id ? { ...profile, ...patch } : profile),
  });
  const updateSession = (session: AgentSession) => {
    setSessions((current) => {
      const next = upsertAgentSession(current, session);
      try { localStorage.setItem(AGENT_SESSIONS_KEY, serializeAgentSessions(next)); } catch { /* preview */ }
      return next;
    });
  };

  const ask = async () => {
    if (!activeProfile.endpoint.trim() || !activeProfile.model.trim() || !prompt.trim()) { setStatusText("请填写 AI 地址、模型和指令"); return; }
    setBusy(true); setProposal(null); setStatusText("正在请求 AI 规划单步操作…");
    const mcpTools = getDeviceMcpTools({ name: device.name, serial: device.serial }).map((item) => item.name).join(" | ");
    const system = `你是 Redroid Device Center 的安全控制规划器。当前设备：${device.name}，Serial：${device.serial}。请按照 MCP tools/call 的工具命名返回一个 JSON 对象，不要 Markdown：{"tool":"${mcpTools}","arguments":{},"reason":"简短原因"}。device_control 的 arguments 必须包含 action（home/back/recent/lock/wake）；start_app 必须包含 package；install_apk 必须包含 path；send_text 必须包含 text；keyevent 必须包含 code；shell 必须包含 command；network 和 recording 必须包含 action。一次只允许一个工具，禁止自行组合后续动作。batch_control 可使用设备列表中的 Serial，执行前会逐条展示并确认。`;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(activeProfile.endpoint.trim(), { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", ...(activeProfile.apiKey.trim() ? { Authorization: `Bearer ${activeProfile.apiKey.trim()}` } : {}) }, body: JSON.stringify({ model: activeProfile.model.trim(), temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: prompt.trim() }] }) });
      if (!response.ok) throw new Error(`AI HTTP ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("AI 没有返回动作");
      const action = extractAction(content);
      const now = new Date().toISOString();
      const session: AgentSession = { id: createAgentSessionId(), deviceId: device.id, deviceName: device.name, prompt: prompt.trim(), tool: action.tool, reason: action.reason, arguments: action.arguments, status: "planned", createdAt: now, updatedAt: now };
      updateSession(session);
      setProposal({ ...action, sessionId: session.id });
      setStatusText("AI 已给出动作，等待确认");
    } catch (error) { setStatusText(`AI 请求失败：${error instanceof DOMException && error.name === "AbortError" ? "请求超时（30 秒）" : error instanceof Error ? error.message : String(error)}`); }
    finally { window.clearTimeout(timeout); setBusy(false); }
  };

  const execute = async () => {
    if (!proposal) return;
    const activeSession = sessions.find((session) => session.id === proposal.sessionId);
    if (activeSession) updateSession({ ...activeSession, status: "confirmed", updatedAt: new Date().toISOString() });
    setBusy(true);
    try {
      const runCommand = async (promise: ReturnType<typeof DeviceService.home>, label: string) => {
        const result = await promise;
        if (!result.success) throw new Error(result.stderr || result.stdout || `${label}失败`);
        return `${label} 已完成`;
      };
      const response = await dispatchMcpRequest(
        { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: proposal.tool, arguments: proposal.arguments } },
        {
          device: { name: device.name, serial: device.serial },
          allowedSerials: [...new Set([device.serial, ...allDeviceSerials])],
          // The proposal card itself is the explicit user confirmation. The
          // dispatcher still fails closed for every non-interactive caller.
          confirm: async () => true,
          execute: async (tool, args) => {
            switch (tool) {
              case "screenshot": { const result = await DeviceService.screenshot(device.serial); if (!result.success) throw new Error(result.error || "截图失败"); return `截图完成：${result.path}`; }
              case "device_control": { const action = String(args.action); const commands = { home: [DeviceService.home(device.serial), "Home"], back: [DeviceService.back(device.serial), "返回"], recent: [DeviceService.recent(device.serial), "最近任务"], lock: [DeviceService.lock(device.serial), "锁屏"], wake: [DeviceService.wake(device.serial), "唤醒"] } as const; const [promise, label] = commands[action as keyof typeof commands] || []; if (!promise) throw new Error("不支持的设备控制动作"); return runCommand(promise, label); }
              case "start_app": { const result = await DeviceService.startApp(device.serial, String(args.package)); if (!result.success) throw new Error(result.stderr || result.stdout || "启动应用失败"); return "应用已启动"; }
              case "install_apk": { const result = await DeviceService.installApk(device.serial, String(args.path), true); if (!result.success) throw new Error(result.stderr || result.stdout || "安装 APK 失败"); return "APK 已安装"; }
              case "send_text": return runCommand(DeviceService.text(device.serial, String(args.text)), "输入文字");
              case "keyevent": return runCommand(DeviceService.keyevent(device.serial, Number(args.code)), "KeyEvent");
              case "shell": { const result = await DeviceService.shell(device.serial, String(args.command)); if (!result.success) throw new Error(result.stderr || result.stdout || "Shell 执行失败"); return result.stdout || "Shell 已完成"; }
              case "open_files": sessionStorage.setItem(`rdc.detail.tab.${device.id}`, "files"); window.location.hash = `/devices/${encodeURIComponent(device.id)}`; return `已打开 ${device.name} 的文件管理`;
              case "open_apps": sessionStorage.setItem(`rdc.detail.tab.${device.id}`, "apps"); window.location.hash = `/devices/${encodeURIComponent(device.id)}`; return `已打开 ${device.name} 的应用管理`;
              case "apps_list": { const entries = await DeviceService.listAppsResult(device.serial, Boolean(args.includeSystem)); return JSON.stringify(entries); }
              case "files_list": { const entries = await DeviceService.listFilesResult(device.serial, String(args.path)); return JSON.stringify(entries); }
              case "file_delete": { const result = await DeviceService.deleteRemotePath(device.serial, String(args.path)); if (!result.success) throw new Error(result.stderr || result.stdout || "删除文件失败"); return "文件已删除"; }
              case "batch_control": { const serials = Array.isArray(args.serials) ? args.serials.map((item) => String(item)) : []; const action = String(args.action); const commands = { home: DeviceService.home, back: DeviceService.back, recent: DeviceService.recent, lock: DeviceService.lock, wake: DeviceService.wake } as const; const command = commands[action as keyof typeof commands]; if (!command) throw new Error("不支持的批量控制动作"); const results = await Promise.all(serials.map(async (serial) => { try { const result = await command(serial); return { serial, success: result.success, output: result.success ? (result.stdout || `${action} 已完成`) : (result.stderr || result.stdout || `${action} 失败`) }; } catch (error) { return { serial, success: false, output: error instanceof Error ? error.message : String(error) }; } })); return JSON.stringify(results); }
              case "network": { const action = String(args.action); if (action === "start") { const result = await DeviceService.gnirehtetStart(device.serial); if (result.status !== "running") throw new Error(result.message || "网络供网启动失败"); return "网络供网已启动"; } const stopped = await DeviceService.gnirehtetStop(device.serial); if (action === "stop") { if (!stopped.success) throw new Error(stopped.stderr || stopped.stdout || "网络供网停止失败"); return "网络供网已停止"; } if (!stopped.success && !/not running|未运行/i.test(stopped.stderr || stopped.stdout || "")) throw new Error(stopped.stderr || stopped.stdout || "网络供网重启失败"); const result = await DeviceService.gnirehtetStart(device.serial); if (result.status !== "running") throw new Error(result.message || "网络供网重启失败"); return "网络供网已重启"; }
              case "recording": { if (args.action === "start") { const result = await DeviceService.recordingStart(device.serial, "video"); if (result.status === "error") throw new Error(result.message); return "录制已开始"; } const result = await DeviceService.recordingStop(device.serial); if (!result.success) throw new Error(result.stderr || result.stdout || "停止录制失败"); return "录制已停止"; }
              default: throw new Error(`未实现的 MCP 工具：${tool}`);
            }
          },
        },
      );
      const result = response?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
      const message = result?.content?.map((item) => item.text || "").join("\n") || "操作完成";
      if (result?.isError) throw new Error(message);
      if (activeSession) updateSession({ ...activeSession, status: "success", output: message, updatedAt: new Date().toISOString() });
      setStatusText(message); setProposal(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeSession) updateSession({ ...activeSession, status: "failed", output: message, updatedAt: new Date().toISOString() });
      setStatusText(`AI 操作失败：${message}`);
    }
    finally { setBusy(false); }
  };

  const reject = () => {
    if (proposal?.sessionId) {
      const session = sessions.find((item) => item.id === proposal.sessionId);
      if (session) updateSession({ ...session, status: "rejected", updatedAt: new Date().toISOString() });
    }
    setProposal(null);
  };

  const addProfile = () => {
    const id = `profile-${Date.now()}`;
    const nextProfile: AgentProfile = { id, name: `配置 ${profileState.profiles.length + 1}`, endpoint: "", model: "", apiKey: "" };
    saveProfileState({ selectedId: id, profiles: [...profileState.profiles, nextProfile] });
  };

  const removeProfile = () => {
    if (profileState.profiles.length <= 1) return;
    const profiles = profileState.profiles.filter((profile) => profile.id !== activeProfile.id);
    saveProfileState({ selectedId: profiles[0].id, profiles });
  };

  return (
    <Card className="agent-panel" title="AI 控制（安全模式）" action={<span className="muted"><ShieldAlert size={13} /> 所有动作逐条确认</span>}>
      <div className="row agent-profile-bar">
        <select value={activeProfile.id} onChange={(event) => saveProfileState({ ...profileState, selectedId: event.target.value })} aria-label="AI 配置">
          {profileState.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profileName(profile)}</option>)}
        </select>
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={addProfile}>新增配置</Button>
        <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={removeProfile} disabled={profileState.profiles.length <= 1}>删除配置</Button>
      </div>
      <div className="agent-config">
        <input value={activeProfile.name} onChange={(e) => updateActiveProfile({ name: e.target.value })} placeholder="配置名称" aria-label="配置名称" />
        <input value={activeProfile.endpoint} onChange={(e) => updateActiveProfile({ endpoint: e.target.value })} placeholder="OpenAI-compatible API 地址" aria-label="AI 地址" />
        <input value={activeProfile.model} onChange={(e) => updateActiveProfile({ model: e.target.value })} placeholder="模型名称" aria-label="模型名称" />
        <input type="password" value={activeProfile.apiKey} onChange={(e) => updateActiveProfile({ apiKey: e.target.value })} placeholder="API Key（仅本机保存）" aria-label="API Key" />
      </div>
      <div className="row agent-prompt"><input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void ask(); }} placeholder="例如：给当前设备截图；Ctrl/⌘ + Enter 请求规划" /><Button size="sm" variant="primary" loading={busy} icon={<Send size={13} />} onClick={() => void ask()}>请求规划</Button></div>
      {proposal && <div className="agent-proposal"><div className="row"><Bot size={14} /><strong>待确认：{proposal.tool}</strong><span className="muted">{proposal.reason || "AI 建议执行此动作"}</span></div><pre>{JSON.stringify(proposal.arguments, null, 2)}</pre><div className="row"><Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => void execute()}>确认执行</Button><Button size="sm" variant="ghost" icon={<X size={13} />} onClick={reject}>拒绝</Button></div></div>}
      {sessions.length > 0 && <details className="agent-history"><summary>任务会话（{sessions.length}）</summary><div className="agent-session-list">{[...sessions].reverse().map((session) => <div className={`agent-session agent-session-${session.status}`} key={session.id}><div className="row"><strong>{sessionStatus(session.status)}</strong><span>{session.tool || "未生成动作"}</span><span className="muted">{new Date(session.createdAt).toLocaleString()}</span></div><div className="muted">{session.deviceName} · {session.prompt}</div>{session.output && <pre>{session.output}</pre>}</div>)}</div></details>}
    </Card>
  );
}
