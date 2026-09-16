// i18n dictionary for the merged containers page shell (`src/pages/containers/RuntimePage.tsx`).
// Only the shell (title, subtitle, track switcher) lives here: the two track
// panels keep their own `docker.*` / `qemu.*` namespaces untouched.
export const runtimeZh: Record<string, string> = {
  "runtime.title": "容器与节点",
  "runtime.subtitle": "本机 Docker 与 QEMU 节点：同一页内切换轨道，两条轨道的能力与语义各自独立",
  "runtime.track.label": "运行轨道",
  "runtime.track.docker": "本机 Docker",
  "runtime.track.qemu": "QEMU 节点",
  "runtime.backgroundTask.label": "后台任务",
  "runtime.backgroundTask.running": "{track} 仍在执行：{task}",
  "runtime.backgroundTask.goto": "回到该轨道",
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
};
