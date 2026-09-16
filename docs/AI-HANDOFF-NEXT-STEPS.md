# AI 续接文档 — 下一步任务清单

> **🚨 本文件是项目进度锚点：AI 每次开工前必读（入口见根目录 `AGENTS.md`）。**
> 更新时间：2026-09-16 14:00 · 更新者：Codex（本轮会话）
> 分支：`codex/qemu-presets`（已推送 origin）
> **生命周期**：§二 待办清单全部完成后 → 删除本文件（提交信息写明「清单已清空，删除续接文档」）。

---

## 一、当前进度（已完成，含实测证据）

### 1.1 验证基线（改前改后都必须保持）

| 套件 | 现状 |
|---|---|
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run` | **57 文件 / 422 用例全绿** |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 212 通过 / 0 失败 |
| `cargo test --manifest-path qemu-center/Cargo.toml` | 188 + 3 通过 / 0 失败 |
| `npm run build` | 成功（仅一条既有 chunk 体积警告，非错误） |

### 1.2 已完成的功能块

- **QEMU 轨道全链路**（真机跑通 7/7 验收）：节点 VM 管理、环境体检八项、实例创建、**预装**（GApps / Magisk+Zygisk / LSPosed / Shamiko / DeviceCloak / native cloak / 设备档案 / ABI / 痕迹清理）、**升级预装**与**恢复升级前**、验收七项。
  - 关键实现：seed 载体 = **零依赖自写 FAT16 镜像**（卷标 CIDATA + LFN 小写文件名）；此前的自写 ISO 与 QEMU VVFAT 两代方案均被真机证伪，勿回退。
  - 真机数据：升级 239.6s、恢复 33.1s；数据卷与旧容器保留，可回滚（哨兵文件跨升级/恢复/重启逐字节一致）。
- **WHPX guest 卡死缓解**：`-cpu max,-svm,-vmx` + guest 串口日志。相应文件：`state/vms/<name>/qemu.log`（QEMU stderr）与 `state/vms/<name>/console.log`（guest 串口）。
- **容器与节点页合并 P1–P7（自动化部分）**：轨道面板抽取 → 合并页外壳与路由 → 生命周期治理 → 侧边栏单一入口 → 来源徽标 / 去重页头 / a11y → 跨轨对比视图 → 依赖方向守卫测试。
  - 方案文档：`docs/superpowers/specs/2026-09-16-docker-qemu-page-merge.md`
- **首次启动体检增强**：readiness 现在返回四态 status、轨道归属、详细原因；覆盖 Android 镜像引用、目标 ABI、GApps 路径及 Android/ABI 兼容性；Dashboard 支持显式重新检查，仍不进入 20 秒统计刷新。
- **P6b 跨轨运行指标**：Docker 与 QEMU 既有只读详情读取携带 CPU 配额、内存配额、磁盘 SizeRw、StartedAt/FinishedAt；对比视图聚合真实值，区分不限、部分可用、无指标，不用 0 兜底。
- 提交序列：`28626e4` → `d5f130c` → `077af77` → `564f0b1` → `a182695` → `15d614e` → `d1aaf24` → `f7b0192`

---

## 二、待办清单（按优先级；完成后从此节移除）

### ★ P7-1 真机人工走查（最高优先：唯一阻塞「合并完成」的项）

- 逐条清单：`2026-09-16-merge-p7-walkthrough-checklist.md`（生成于 AutoCoder 控制工作区 `DELIVERY/`，**不在本仓**；如需入仓请放 `docs/`）
- 前置：`npm run tauri dev` 启动应用；QEMU 节点 node1 运行；Docker Desktop 运行
- 本轮已铺好的环境：node1 已启动（doctor **8 ok / 0 fail / 0 unknown**；实例 `qc-r1`(A14) 与 `qc-r13`(A13) 均 boot=1 且宿主 adb 均为 `device`）；Docker 引擎已启动
- 验收：清单 C / D / E 三节逐条勾选；发现的问题记入本节或新开条目

### 其它已识别待办（低优先）

| # | 事项 | 说明 |
|---|---|---|
| 1 | Shamiko 自报 `[(64)❌ Unsupported environment]` | 已安装且 zygisk 模块在位，但 redroid 环境可能不支持其完整功能，需单独排查 |
| 2 | WHPX 残留 `Unexpected VP exit code 4` | 缓解后启动阶段仍有 7 次、随后 3 分钟增量为 0；列为观察项 |
| 3 | `resolveRuntimeLink` 前端兜底 | 后端 `readiness.rs` 仍产出 `/docker`、`/qemu`；将来应改为后端直接产出 `/containers?track=…`，然后删掉前端兜底 |
| 4 | 侧边栏图标 `Boxes` 与 APK 的 `Package` 辨识度 | 16px 下偏接近，可换 `Layers` / `LayoutGrid`（两行改动） |
| 5 | chunk 体积警告 | `index-*.js` 913 kB 超过 600 kB 阈值，可做代码分割 |
| 6 | 仓库根残留临时文件 | `.tmp-tauri-dev.log`、`.tmp-tauri-dev2.log`、`_p1.txt`、`_p2.txt`（均已被 gitignore，属历史产物） |
| 7 | `qemu-center/state/` 残留 | `disk.corrupt-backup-20260915.qcow2`（约 4 GB 历史备份）+ `presets/job-*` 空目录，可清理 |
| 8 | 对比视图指标口径 | 健康度是**轨道级**（非实例级）；QEMU 侧快照仅覆盖**当前所选节点**的实例（UI 已用 scope note 声明） |

---

## 三、环境速查（下次直接可用）

### QEMU 节点

```powershell
cd F:\code\project\Android-Device
.\qemu-center\target\debug\qemu-center.exe vm start node1 --state-dir qemu-center\state
.\qemu-center\target\debug\qemu-center.exe doctor    --state-dir qemu-center\state
.\qemu-center\target\debug\qemu-center.exe redroid list node1 --state-dir qemu-center\state
```

- 节点状态目录：`qemu-center/state`（`keys/`、`vms/`、`images/`、`presets/`）；SSH 端口 **22300**；adb 端口块 **24500..=24531**
- 排障现场：`state/vms/node1/qemu.log`（QEMU stderr）、`state/vms/node1/console.log`（guest 串口）
- guest 内实例：`qc-r1`（Android 14）、`qc-r13`（Android 13，含 GApps + Magisk + LSPosed + Shamiko）

### Docker 轨道

- 引擎：Docker Desktop（本轮以 `C:\Program Files\Docker\Docker\Docker Desktop.exe` 启动）
- 既有容器：`rdc-redroid-2`、`rdc-redroid-3`（Exited）；preset 镜像：`rdc-preset:*`、`rdc-gapps:*`
- binder 内核：`C:\wsl-kernel\bzImage`（另有 `config-wsl-binder`、`modules.tar.gz`）

### 本地资产（**不要重复下载**）

| 资产 | 路径 |
|---|---|
| GApps（Android **13**、x86_64） | `vendor\gapps\MindTheGapps-13.0.0-x86_64-20231025_201203.zip` |
| Magisk | `vendor\magisk\`（`magisk.apk` + 二进制 + `apksig.jar` + 签名 keystore） |
| LSPosed / Shamiko | `vendor\magisk\modules\` |
| Magisk overlay | `vendor\magisk-overlay\` |

---

## 四、已知坑（务必先看）

1. **GApps 只有 13.0.0**：Android 14 实例勾 GApps 会被 `validate_gapps` 硬拒（报错文案 `GApps Android 版本 [13] 与目标 Android 14 不兼容。`）。要么用 Android 13，要么把 MindTheGapps 14 的 zip 放进 `vendor\gapps\`。
2. **不要硬杀 QEMU**：`Stop-Process -Force` 可能给 qcow2 留下损坏标志，之后 QEMU 打不开磁盘（`Too much extra metadata in snapshot table entry 0` / `Image is corrupt`）。修复：`qemu-img check -r all <disk>`。优先用 `vm stop` 走 ACPI。
3. **verify 第 7 项勿回退**：现在只在能证明磁盘空闲时才用 `qemu-img snapshot`，运行中改走 QMP 内部快照。早期版本会写坏活盘（见 `qemu-center/README.md` 的诚实边界章节）。
4. **guest 首启依赖 cloud-init 模板**：`linux-modules-extra`（binder 模块）+ `modules-load.d` + docker 代理 drop-in 都已固化。**不要**再往 `/etc/fstab` 写 binderfs 条目——那会导致 guest 进 emergency mode（真机踩过）。
5. **前端偶发 flake**：全量跑偶尔出现 1 个失败文件（本会话见过 1 次），复跑即绿；疑似负载敏感用例，未定位。
6. **PowerShell 传 SSH 命令**：含 `{{.Field}}` 之类花括号会被 PowerShell 吞掉，需用 base64 传输（本会话既有做法）。
7. **ZCode 偶发容量失败**：报 `high demand` 时会明确允许原生兜底，按契约在本仓直接改即可（本轮守卫测试即如此完成）。
8. **前端无浏览器后端**：本环境 `agent.browsers` 为空，视觉结论只能来自 DOM/CSS 断言；真机观感必须人工确认。

---

## 五、工作方式约定（用户偏好，务必遵守）

1. **先方案文档、后改代码**：方案放 `docs/superpowers/specs/`，实施计划放 `docs/superpowers/plans/`。
2. **分阶段实施**：每阶段自验（tsc + vitest + 两套 cargo test）全绿再提交；提交信息写明阶段号与内容。
3. **优先复用本地资产**，不重复下载；速度优先。
4. **不要替用户宣称视觉/真机结论通过**——标注为待人工确认。
5. 后端（`src-tauri` / `qemu-center`）改动需用户**显式授权**（本轮多阶段均冻结后端）。

---

## 六、本文件的维护

- 完成一项 → 从 §二 移除（或标 ✅ 并写明证据），提交信息注明。
- **§二 清空后 → 删除本文件**，提交信息写明「清单已清空，删除续接文档」。
