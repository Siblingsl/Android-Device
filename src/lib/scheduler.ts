export type ScheduleKind = "once" | "daily" | "weekly" | "interval" | "cron";
export type ScheduledAction = "start-device" | "stop-device" | "launch-app" | "install-apk" | "run-script" | "screenshot" | "recording-start" | "recording-stop" | "shell";

export interface ScheduledRun {
  at: string;
  success: boolean;
  message: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  kind: ScheduleKind;
  time: string;
  weekdays: number[];
  intervalMinutes: number;
  cronExpression: string;
  nextRun: string;
  lastRun: string;
  history: ScheduledRun[];
  targetDeviceId: string;
  action: ScheduledAction;
  payload: string;
}

export const SCHEDULER_STORAGE_KEY = "rdc.scheduled-tasks.v1";

function atTime(base: Date, time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const next = new Date(base);
  next.setHours(Number.isFinite(hours) ? hours : 0, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  return next;
}

function cronValues(raw: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangeText, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    const range = rangeText === "*" || rangeText === "" ? [min, max] : rangeText.split("-").map(Number);
    if (range.length === 1 && Number.isInteger(range[0])) range.push(range[0]);
    if (range.length !== 2 || !range.every(Number.isInteger) || range[0] < min || range[1] > max || range[0] > range[1]) return null;
    for (let value = range[0]; value <= range[1]; value += step) values.add(value);
  }
  return values;
}

function cronMatches(date: Date, expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const minutes = cronValues(fields[0], 0, 59);
  const hours = cronValues(fields[1], 0, 23);
  const days = cronValues(fields[2], 1, 31);
  const months = cronValues(fields[3], 1, 12);
  const weekdays = cronValues(fields[4], 0, 6);
  if (!minutes || !hours || !days || !months || !weekdays) return false;
  const dayOfMonthWildcard = fields[2] === "*";
  const dayOfWeekWildcard = fields[4] === "*";
  const dayMatches = dayOfMonthWildcard || dayOfWeekWildcard
    ? days.has(date.getDate()) && weekdays.has(date.getDay())
    : days.has(date.getDate()) || weekdays.has(date.getDay());
  return minutes.has(date.getMinutes()) && hours.has(date.getHours()) && months.has(date.getMonth() + 1) && dayMatches;
}

export function nextRunAfter(task: ScheduledTask, from = new Date()): Date | null {
  if (task.kind === "once") {
    const date = new Date(task.nextRun || task.time);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (task.kind === "interval") {
    const last = new Date(task.lastRun || task.nextRun || from);
    const next = new Date(last.getTime() + Math.max(1, task.intervalMinutes) * 60_000);
    return next > from ? next : new Date(from.getTime() + Math.max(1, task.intervalMinutes) * 60_000);
  }
  if (task.kind === "cron") {
    const cursor = new Date(from);
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);
    const limit = cursor.getTime() + 366 * 86_400_000;
    while (cursor.getTime() <= limit) {
      if (cronMatches(cursor, task.cronExpression)) return new Date(cursor);
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return null;
  }
  const days = task.kind === "weekly" && task.weekdays.length ? task.weekdays : [0, 1, 2, 3, 4, 5, 6];
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = atTime(new Date(from.getTime() + offset * 86_400_000), task.time);
    if (days.includes(candidate.getDay()) && candidate > from) return candidate;
  }
  return null;
}

export function dueTasks(tasks: ScheduledTask[], now = new Date(), runningIds: ReadonlySet<string> = new Set()) {
  return tasks.filter((task) =>
    task.enabled
    && !runningIds.has(task.id)
    && task.nextRun
    && new Date(task.nextRun).getTime() <= now.getTime(),
  );
}

export function markTaskRun(task: ScheduledTask, now = new Date()): ScheduledTask {
  const once = task.kind === "once";
  const next = once ? null : nextRunAfter({ ...task, lastRun: now.toISOString() }, now);
  return { ...task, lastRun: now.toISOString(), nextRun: next?.toISOString() || "", enabled: once ? false : task.enabled };
}

export function createScheduledTask(partial: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: partial.id || `schedule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: partial.name || "新任务",
    enabled: partial.enabled !== false,
    kind: partial.kind || "daily",
    time: partial.time || "09:00",
    weekdays: partial.weekdays || [1, 2, 3, 4, 5],
    intervalMinutes: Math.max(1, partial.intervalMinutes || 60),
    cronExpression: partial.cronExpression || "* * * * *",
    nextRun: partial.nextRun || "",
    lastRun: partial.lastRun || "",
    history: Array.isArray(partial.history) ? partial.history.slice(0, 20) : [],
    targetDeviceId: partial.targetDeviceId || "",
    action: partial.action || "screenshot",
    payload: partial.payload || "",
  };
}

/** Fill a missing schedule cursor when the app starts or imports an old task. */
export function prepareScheduledTask(task: ScheduledTask, from = new Date()): ScheduledTask {
  if (!task.enabled || task.nextRun) return task;
  return { ...task, nextRun: nextRunAfter(task, from)?.toISOString() || "" };
}

export function recordScheduledResult(tasks: ScheduledTask[], id: string, success: boolean, message: string, at = new Date()): ScheduledTask[] {
  return tasks.map((task) => task.id === id
    ? { ...task, history: [{ at: at.toISOString(), success, message }, ...task.history].slice(0, 20) }
    : task);
}
