import { useMemo, useState } from "react";
import { CalendarClock, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { createScheduledTask, nextRunAfter, prepareScheduledTask, SCHEDULER_STORAGE_KEY, type ScheduledAction, type ScheduledTask, type ScheduleKind } from "../../lib/scheduler";
import type { DeviceInfo } from "../../types";
import { open } from "@tauri-apps/plugin-dialog";
import { AUTOMATION_STORAGE_KEY, normalizeAutomationScript, type AutomationScript } from "../../lib/automation";

interface Props { devices: DeviceInfo[]; setStatusText: (text: string) => void; }

function load(): ScheduledTask[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SCHEDULER_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(raw) ? raw.map((item) => prepareScheduledTask(createScheduledTask(item as Partial<ScheduledTask>))) : [];
  } catch { return []; }
}

function loadScripts(): AutomationScript[] {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTOMATION_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((item) => Boolean(item) && typeof item === "object").map((item) => normalizeAutomationScript(item as Record<string, unknown>)) : [];
  } catch { return []; }
}

function localDateTimeValue(date = new Date(Date.now() + 60_000)) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const WEEKDAYS = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
];

export function SchedulerPanel({ devices, setStatusText }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>(load);
  const [draft, setDraft] = useState(() => createScheduledTask({ name: "每日截图", action: "screenshot", kind: "daily" }));
  const online = useMemo(() => devices.filter((device) => device.online && device.adbStatus === "device"), [devices]);
  const scripts = useMemo(loadScripts, [tasks]);
  const save = (next: ScheduledTask[]) => { setTasks(next); localStorage.setItem(SCHEDULER_STORAGE_KEY, JSON.stringify(next)); };
  const add = () => {
    const next = { ...draft, nextRun: nextRunAfter(draft)?.toISOString() || draft.nextRun };
    if (!next.targetDeviceId) { setStatusText("定时任务请选择目标设备"); return; }
    if (["launch-app", "install-apk", "run-script", "shell"].includes(next.action) && !next.payload.trim()) {
      setStatusText("请填写定时任务所需的动作参数");
      return;
    }
    if (!next.nextRun) { setStatusText(next.kind === "cron" ? "请输入有效的 Cron 表达式" : "请设置有效的执行时间"); return; }
    save([...tasks, next]);
    setDraft(createScheduledTask({ name: `任务 ${tasks.length + 2}` }));
    setStatusText("定时任务已添加");
  };
  const toggle = (id: string) => save(tasks.map((task) => task.id === id ? { ...task, enabled: !task.enabled } : task));
  return (
    <Card className="scheduler-panel" title="定时任务" action={<span className="muted"><CalendarClock size={13} /> 应用运行期间自动执行</span>}>
      <div className="scheduler-create">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="任务名称" />
        <select value={draft.targetDeviceId} onChange={(e) => setDraft({ ...draft, targetDeviceId: e.target.value })}><option value="">选择设备</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select>
        <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as ScheduledAction })}><option value="start-device">启动设备</option><option value="stop-device">停止设备</option><option value="launch-app">启动应用</option><option value="install-apk">安装 APK</option><option value="run-script">执行脚本</option><option value="screenshot">截图</option><option value="recording-start">开始录制</option><option value="recording-stop">停止录制</option><option value="shell">Shell</option></select>
        <select value={draft.kind} onChange={(e) => {
          const kind = e.target.value as ScheduleKind;
          setDraft((current) => kind === "once"
            ? { ...current, kind, time: current.time.includes("T") ? current.time : localDateTimeValue(), nextRun: "" }
            : { ...current, kind, time: current.time.includes("T") ? "09:00" : current.time });
        }}><option value="once">一次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">间隔</option><option value="cron">Cron</option></select>
        {draft.kind === "once" ? <input type="datetime-local" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value, nextRun: e.target.value ? new Date(e.target.value).toISOString() : "" })} /> : draft.kind === "interval" ? <input type="number" min={1} value={draft.intervalMinutes} onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })} placeholder="分钟" /> : draft.kind === "cron" ? <input value={draft.cronExpression} onChange={(e) => setDraft({ ...draft, cronExpression: e.target.value, nextRun: "" })} placeholder="分 时 日 月 周，例如 */15 * * * *" /> : <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />}
        {draft.kind === "weekly" && <div className="row scheduler-weekdays" aria-label="每周执行日">{WEEKDAYS.map((day) => <label key={day.value} className="row"><input type="checkbox" checked={draft.weekdays.includes(day.value)} onChange={(e) => setDraft((current) => ({ ...current, weekdays: e.target.checked ? [...new Set([...current.weekdays, day.value])] : current.weekdays.filter((value) => value !== day.value) }))} />周{day.label}</label>)}</div>}
        {draft.action === "launch-app" && <input value={draft.payload} onChange={(e) => setDraft({ ...draft, payload: e.target.value })} placeholder="应用包名" />}
        {draft.action === "shell" && <input value={draft.payload} onChange={(e) => setDraft({ ...draft, payload: e.target.value })} placeholder="Shell 命令" />}
        {draft.action === "install-apk" && <div className="row"><input value={draft.payload} readOnly placeholder="APK 路径" /><Button size="sm" variant="ghost" onClick={async () => { const path = await open({ multiple: false, directory: false, filters: [{ name: "APK", extensions: ["apk"] }] }); if (typeof path === "string") setDraft({ ...draft, payload: path }); }}>选择 APK</Button></div>}
        {draft.action === "run-script" && <select value={draft.payload} onChange={(e) => setDraft({ ...draft, payload: e.target.value })}><option value="">选择自动化脚本</option>{scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}</select>}
        <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={add}>添加</Button>
      </div>
      <div className="scheduler-list">
        {tasks.map((task) => <div className={`scheduler-row${task.enabled ? "" : " is-disabled"}`} key={task.id}><span className="scheduler-state">{task.enabled ? "启用" : "暂停"}</span><strong title={task.name}>{task.name}</strong><span title={task.action}>{devices.find((device) => device.id === task.targetDeviceId)?.name || task.targetDeviceId}</span><span title={task.kind === "cron" ? task.cronExpression : undefined}>{task.kind === "interval" ? `每 ${task.intervalMinutes} 分钟` : task.kind === "cron" ? task.cronExpression : task.time}</span><span className={`muted ${task.history[0] && !task.history[0].success ? "bad" : ""}`} title={task.history[0]?.message}>{task.history[0] ? `${task.history[0].success ? "成功" : "失败"} · ${task.history[0].message}` : task.nextRun ? new Date(task.nextRun).toLocaleString() : "待计算"}</span><Button size="sm" variant="ghost" icon={task.enabled ? <Pause size={13} /> : <Play size={13} />} onClick={() => toggle(task.id)} aria-label={task.enabled ? "暂停任务" : "启用任务"} /><Button size="sm" variant="ghost" disabled={!task.history[0] || task.history[0].success} icon={<RefreshCw size={13} />} onClick={() => save(tasks.map((entry) => entry.id === task.id ? { ...entry, enabled: true, nextRun: new Date().toISOString() } : entry))} aria-label="重试任务" /><Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => save(tasks.filter((entry) => entry.id !== task.id))} aria-label="删除任务" /></div>)}
      </div>
      <div className="muted scheduler-hint">当前在线设备 {online.length} 台；设备离线时任务会记录失败原因，不会把命令发送给其他设备。</div>
    </Card>
  );
}
