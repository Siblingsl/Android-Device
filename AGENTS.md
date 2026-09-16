# AGENTS.md — 本项目 AI 协作必读

> **🚨 动任何代码之前，先读本页 + `docs/AI-HANDOFF-NEXT-STEPS.md`。**
> 后者是本项目的**续接文档**：已完成到哪、下一步做什么、环境怎么起、有哪些坑。
> 漏读它的后果很具体：GApps 版本会被硬拒、硬杀 QEMU 会弄坏磁盘、verify 的快照路径改错会写坏活盘。

## 三条常驻指令

1. **先读文档再动手**：`AGENTS.md`（本页）+ `docs/AI-HANDOFF-NEXT-STEPS.md`。
2. **每轮开工前询问用户**：「要不要优先开发续接文档 §二 待办清单的下一项？」——不要自行决定优先级。
3. **待办清单全部完成后**：删除 `docs/AI-HANDOFF-NEXT-STEPS.md`（提交信息写明「清单已清空」）。本页保留。

## 项目一句话

Redroid 设备中心（Tauri + React + Rust），**两条轨道**：① 本机 Docker Desktop 轨；② QEMU/WHPX 节点轨（`qemu-center` CLI 在节点内建镜像、跑 redroid 容器）。

## 目录

| 路径 | 作用 |
|---|---|
| `src/` | React 前端（页面 / i18n / stores / services 桥） |
| `src-tauri/` | Rust 后端 + Tauri 命令 |
| `qemu-center/` | 独立 CLI crate：节点(VM) / 实例 / 预装 / 验收（零依赖红线） |
| `vendor/` | 本地资产（GApps / Magisk / LSPosed / Shamiko），**不进 Git** |
| `docs/superpowers/{specs,plans}/` | 方案文档与实施计划（本仓约定：先文档后代码） |

## 改动前后都必须过的验证

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
```

## 工作方式（用户偏好）

- **先方案文档、再改代码**；分阶段实施，每阶段测试全绿再提交，提交信息写清阶段与内容。
- **优先复用本地既有资产**，不要重复下载；速度优先。
- **视觉 / 真机类结论不要替用户宣称通过**，一律标注为待人工确认。
- 后端（`src-tauri` / `qemu-center`）改动需要用户**显式授权**。