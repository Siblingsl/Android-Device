// i18n dictionary for the merged containers page shell (`src/pages/containers/RuntimePage.tsx`).
// Only the shell (title, subtitle, track switcher, source badges) lives here: the
// two track panels keep their own `docker.*` / `qemu.*` namespaces untouched.
export const runtimeZh: Record<string, string> = {
  "runtime.title": "容器与节点",
  "runtime.subtitle": "本机 Docker 与 QEMU 节点：同一页内切换轨道，两条轨道的能力与语义各自独立",
  "runtime.track.label": "运行轨道",
  "runtime.track.docker": "本机 Docker",
  "runtime.track.qemu": "QEMU 节点",
  "runtime.backgroundTask.label": "后台任务",
  "runtime.backgroundTask.running": "{track} 仍在执行：{task}",
  "runtime.backgroundTask.goto": "回到该轨道",

  // ---- Source badges (merge spec §6.8: 数量 + 健康度) ----
  // Read-only summary of what each track's own reads already know. Unavailable
  // sources state a reason instead of `0`, and the check result is the *cached*
  // one with its age — entering the page never runs a probe.
  "runtime.source.label": "来源状态",
  "runtime.source.containers": "{count} 容器",
  "runtime.source.nodes": "{count} 节点",
  "runtime.source.nodesInstances": "{nodes} 节点 / {instances} 实例",
  "runtime.source.instancesScope": "实例数来自当前所选节点 {scope}",
  "runtime.source.ok": "正常",
  "runtime.source.kernelNotReady": "内核未就绪",
  "runtime.source.dockerStopped": "Docker 未启动",
  "runtime.source.cliMissing": "CLI 缺失",
  "runtime.source.notChecked": "未检查",
  "runtime.source.notRead": "未读取",
  "runtime.source.doctorJustNow": "体检 {ok}/{total}（刚刚）",
  "runtime.source.doctorAgo": "体检 {ok}/{total}（{minutes} 分钟前）",
  "runtime.source.doctorTitle": "上次体检：{ok}/{total} 项就绪，{fail} 项缺失，{other} 项未知 · {minutes} 分钟前",
  "runtime.source.readTitle": "上次读取：{minutes} 分钟前",
  "runtime.source.refresh": "刷新来源：{track}",
  "runtime.source.refreshSwitch": "刷新来源：{track}（将切换到该轨道）",
};

export const runtimeEn: Record<string, string> = {
  "runtime.title": "Containers & Nodes",
  "runtime.subtitle":
    "Local Docker and QEMU nodes: switch tracks in one page; each track keeps its own capabilities and semantics",
  "runtime.track.label": "Runtime track",
  "runtime.track.docker": "Local Docker",
  "runtime.track.qemu": "QEMU Nodes",
  "runtime.backgroundTask.label": "Background task",
  "runtime.backgroundTask.running": "{track} is still running: {task}",
  "runtime.backgroundTask.goto": "Go to that track",

  // ---- Source badges (merge spec §6.8) ----
  "runtime.source.label": "Source status",
  "runtime.source.containers": "{count} containers",
  "runtime.source.nodes": "{count} nodes",
  "runtime.source.nodesInstances": "{nodes} nodes / {instances} instances",
  "runtime.source.instancesScope": "Instance count comes from the selected node {scope}",
  "runtime.source.ok": "OK",
  "runtime.source.kernelNotReady": "Kernel not ready",
  "runtime.source.dockerStopped": "Docker not running",
  "runtime.source.cliMissing": "CLI missing",
  "runtime.source.notChecked": "Not checked",
  "runtime.source.notRead": "Not read",
  "runtime.source.doctorJustNow": "Checks {ok}/{total} (just now)",
  "runtime.source.doctorAgo": "Checks {ok}/{total} ({minutes} min ago)",
  "runtime.source.doctorTitle": "Last check: {ok}/{total} ready, {fail} missing, {other} unknown · {minutes} min ago",
  "runtime.source.readTitle": "Last read: {minutes} min ago",
  "runtime.source.refresh": "Refresh source: {track}",
  "runtime.source.refreshSwitch": "Refresh source: {track} (switches to that track)",
};
