# E-070 — 前端运行时面板按需拆包

**日期**：2026-09-20  
**状态**：首轮拆包自动化验证通过；主入口仍超过 600 kB 警告阈值，后续仍可继续拆分  
**范围**：合并后的 RuntimePage Docker/QEMU 面板按需加载、路由/任务语义回归、生产构建体积

## 实施内容

- `RuntimePage` 将 Docker 与 QEMU 面板从静态 import 改为 `React.lazy` 动态 import。
- `Suspense` 使用 `null` fallback，不增加面板根节点的 DOM wrapper。
- 保留 `?track=`、compare 视图、后台任务期间隐藏面板继续挂载、tabpanel `id/aria-labelledby` 和现有 panel props。
- 测试等待逻辑覆盖首次动态模块解析及 compare 视图切换，不改变业务定时器语义。

## 构建对照

| 构建 | 主入口 index chunk | 独立面板 chunk | 结果 |
|---|---:|---|---|
| 拆包前基线 | `1,028.64 kB`（gzip `289.56 kB`） | 无 | 超过 600 kB 警告 |
| 本轮构建 | `944.01 kB`（gzip `269.77 kB`） | `DockerTrackPanel` `44.82 kB`（gzip `11.60 kB`）；`QemuTrackPanel` `40.78 kB`（gzip `10.68 kB`） | 主入口减少 `84.63 kB`，仍有 600 kB 警告 |

本轮 `npm run build` 成功；拆包证明成立，但不能宣称已经消除首屏所有大 chunk。

## 自动化门禁

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npx vitest run src/pages/containers/RuntimePage.test.tsx --maxWorkers=1 --minWorkers=1` | 29/29 通过 |
| `npx vitest run src/pages/containers/RuntimeCompare.test.tsx --maxWorkers=1 --minWorkers=1` | 24/24 通过 |
| `npx vitest run --maxWorkers=1 --minWorkers=1` | 61 文件 / 464 用例通过 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 转换提示 |

## 尚未由本证据证明

- 真实 Tauri 窗口的首次加载观感、网络失败后的用户体验和人工视觉回归；当前桌面自动化 helper 无可控 Windows 应用。
- 主入口剩余约 `944.01 kB` 的进一步拆分收益；下一轮可继续按应用壳、设置页和重型服务模块拆分，但应另立方案与基线。
