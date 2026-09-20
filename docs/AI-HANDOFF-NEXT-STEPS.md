# AI 续接文档 — 下一步任务清单

> **🚨 本文件是项目进度锚点：AI 每次开工前必读（入口见根目录 `AGENTS.md`）。**
> 更新时间：2026-09-20 · 更新者：Codex（运行时优化与授权核心交付轮）
> 分支：`codex/qemu-presets`（已推送 origin）
> **生命周期**：§二 待办清单全部完成后 → 删除本文件（提交信息写明「清单已清空，删除续接文档」）。

---

## 一、当前进度（已完成，含实测证据）

### 1.1 验证基线（改前改后都必须保持）

| 套件 | 现状 |
|---|---|
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run` | **60 文件 / 460 用例全绿** |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 294 通过 / 0 失败 / 2 忽略；Windows PTY 已隔离 Unix `TERM` 环境变量 |
| `cargo test --manifest-path qemu-center/Cargo.toml` | 215 个库测试 + 8 个命令行测试通过 / 0 失败 |
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

### 1.3 运行时内存与服务端授权核心（2026-09-17）

- 已落地只读资源快照：主机可用内存、QEMU Private/Working Set、WSL、guest/container 当前/峰值/OOM；页面缺失值保持 `unknown/n/a`。
- 已落地 `lean / standard / full` 运行档案、后端 FIFO 串行启动队列（重复请求抑制、超时、成功/失败自动提升）、内存压力阻止、显式空闲释放、应用级手动暂停（保留 VM/container）和 ART `verify-only / speed-profile / reset` 实验入口。
- 新建 QEMU 节点默认 **3072 MiB**；已有 `node1` **4096 MiB 不自动改写**，后续必须用复制实例做 3072/4096 MiB 实测。
- 最新只读采样：`qc-r13` 约 **2.88 / 3 GiB（约 96%）**，峰值约 3 GiB，`oom_kill=0`，`boot_completed=true`；QEMU 工作集约 0.58 GiB、专用提交约 4.66 GB，WSL 专用提交约 1.71 GB，主机可用约 3.69 GiB。不要把 full 档案继续盲目压到 1–2 GiB。
- 后续只读抽样显示 `qc-r13` 已到 **约 3.00 / 3 GiB**，`oom_kill=0`、`boot_completed=true`；同一时刻 QEMU 工作集约 **1.19 GiB**、专用提交约 **4.66 GB**、主机可用约 **4.10 GiB**。2026-09-18 再次安全启动 node1 后，`qc-r13` current 为约 **3060 MiB / 3072 MiB（99.6%）**，QEMU 工作集约 **2.955 GiB**、专用内存约 **4.283 GiB**，主机可用约 **0.356 GiB**，证据见 E-033。这是瞬时采样，不替代人工稳定性矩阵，也不授权在线调低现有实例上限。
- 基于 E-033，新的 `full` profile 在节点配置低于 **6144 MiB** 时由 qemu-center 后端拒绝，桌面表单同步禁用并提示选择 `lean/standard` 或更大节点；现有 4 GiB 节点和已有 full 实例不自动改写、不停止，证据见 E-034。
- 隔离的 3072 MiB / 2 vCPU 节点试启动曾把主机可用内存压到约 **0.25 GiB**；桌面端 `qemu_vm_start` 现已在 QEMU 创建前按节点 `mem_mib + 1 GiB` 做主机余量检查，并串行化 VM 启动预检查，证据见 `E-028-vm-start-memory-guard.md`。实验节点已通过 ACPI/QMP 停止并精确 purge，`node1/r13` 未改动。
- 独立 `qemu-center vm start` 现在也执行 QMP 停止态和主机可用内存预检查；Windows 使用 CIM、Linux 使用 `MemAvailable`，已知不足时不会生成 QEMU 进程，证据见 `E-029-cli-vm-start-memory-guard.md`。
- 最新主机归因快照见 `E-024-host-memory-attribution.md`：QEMU 私有提交约 4.34 GiB、
  `vmmemWSL` 私有提交约 1.76 GiB，但 QEMU 工作集约 718 MiB；“6–8GB”主要是
  提交量叠加 Docker/系统后的主机体感，不等于单个 redroid 实例常驻 6–8GB。
- 已落地私有 `authorization-service`：DPAPI 设备身份、Ed25519 短租约、账号 entitlement、nonce 防重放、撤销、版本绑定、签名 manifest 和 256 KiB 加密分块交付；`/v1` 敏感响应统一 `no-store`，控制面请求体上限 64 KiB，临时 transfer 默认上限 128，过期条目先回收；服务启动只接受字面量回环监听，真实注册→审批→租约→加密 artifact 路由链见 E-031，证据见 E-026、E-027、E-030。
- 新增只读进程级证据：`r13` 中小红书有 13 个进程，RSS 合计约 3.80 GiB；GApps/Play/Quick Search/`lspd` 筛选进程约 1.04 GiB。该数据支持先做 lean 与“保留 VM、暂停目标应用”的 A/B，不支持继续盲压 full 上限。
- 2026-09-18 fresh boot 后对现有 full `r13` 做了三次实时采样：未启动 XHS 时 guest 约 2.32 GiB、QEMU working/private 约 3.26/4.25 GiB；前台 XHS 后 guest 约 2.84–3.00 GiB、QEMU working/private 约 3.46/4.26–4.30 GiB、宿主可用约 0.45–0.54 GiB。speed-profile 冷启动 P50 为 2142 ms → 1544 ms；未覆盖登录/连续浏览，证据见 E-036。
- 新增一次“应用暂停 vs 停止实例”实测：启动 XHS 登录页时 `r13` 为 3071.7/3072 MiB；仅 force-stop XHS 后 guest current 降至 2119.0 MiB，但 QEMU working set 仍约 3.78 GiB，说明暂停应用能缓解 guest 压力、不能等比例释放宿主提交量；证据见 E-037。该轮 node1 已通过 QMP/ACPI 正常停止。
- 修复闲置策略边界：设置 `runtimeIdleTimeoutMinutes=0` 时，调度器按 1 分钟而非立即可回收处理，避免误停刚刚空闲的实例；已用 59 秒/60 秒边界回归覆盖。
- QEMU 预装/创建路径已接 Rust 授权闸门；release 不嵌入本地 `qemu_guest.py`，没有有效服务端核心文件不能执行。`scripts/verify-release-core.ps1` 已接入 Windows release workflow 作为阻断门禁；debug 回退仅供本地开发。
- Windows release workflow 现在必须从 GitHub Actions repository variables 注入 `RDC_AUTH_BASE_URL` 与 `RDC_AUTH_PUBLIC_KEYS`，缺任一项会在编译前失败；服务端 signing secret 明确禁止进入桌面构建环境，避免产出“无内置核心但合法用户也无法取核心”的不可用 release。
- 发布配置门禁与专项测试证据见 `work/runtime-core-protection-20260917/evidence/E-038-release-authorization-config-20260918.md`；远程 CI 变量实际配置和生产 TLS/密钥轮换仍待人工确认。
- 新增隔离 3072 MiB / 2 vCPU 节点的 lean 基线：QEMU 工作集约 3.135 GiB，guest
  稳态约 1.207 GiB、峰值约 1.259 GiB，连续约 25 秒无增长且 `oom_kills=0`；实验节点
  已按 ACPI/QMP 停止并 purge，最终列表仅剩 `node1`，证据见 `E-039`。该数据只说明
  QEMU/Android 的内存底座，不替代 XHS 登录、浏览和并发矩阵。
- 授权服务新增 artifact/workflow 双层策略：定向 `qemu-guest-script` 只允许
  `preset_apply`，通用 runner 只允许 `preset_restore`/`preset_details`；未知组合在签发和
  消费执行票据时均拒绝，且拒绝不消费 nonce，证据见 `E-040`。
- 修复 `scripts/verify-release-core.ps1` 在 Windows PowerShell 5.1 下使用无效
  `String.Contains` 重载的问题；当前两个 release 二进制均由无错误的 ordinal scan 返回
  `clean`，证据见 `E-041`。
- 对当前 release 授权服务二进制完成真实进程级冒烟：loopback 服务可启动，未授权请求返回
  `401` 且带 `no-store`，非 loopback bind 在监听前退出；临时数据库、日志和 artifact
  目录已清理，证据见 `E-044`。这不替代生产 TLS、账号审批和密钥轮换现场验收。
- 修复闲置释放在 `keepVmWarm=false` 时可能误停共享 QEMU 节点的安全边界：停止目标容器后，
  只有新鲜只读列表确认没有其它 `Up`/`running` 实例时才调用 `vm_stop`；其它实例运行中、
  状态 unknown/空值或探针失败均 fail-closed 保持节点运行。`keepVmWarm=true` 不增加探针开销，
  证据见 `E-045`。
- 根据 E-047 的实测，补齐内存优先的缺省策略：新安装或缺失 `runtimeKeepVmWarm` 的配置默认
  为 `false`，闲置释放在安全证明后会停止空节点以释放 QEMU 基座内存；用户显式保存的 `true`
  仍保留温热节点和更快重开行为。回归覆盖 Rust 配置/调度器反序列化和设置页缺省显示，
  计划与证据见 `docs/superpowers/plans/2026-09-18-memory-first-default.md`、`E-048`。
- 对已有显式 `runtimeKeepVmWarm=true` 的配置增加 critical 压力保护：normal/caution/unknown 仍
  尊重温热选择，只有主机进入 critical 且新鲜列表证明节点为空时才临时停止 QEMU；证据见 `E-049`。
- 补齐执行票据的设备私钥证明：客户端对服务端签发 grant payload 生成 `device_proof`，guest
  与授权服务均校验；缺失或错误设备证明返回 403 且不消费 JTI，协议层已覆盖 artifact/票据复制
  后的拒绝，证据见 `E-050`。真实跨机器复制仍需人工演练。
- 补齐受保护核心的进程启动残留清理：首次准备核心前仅清理系统临时目录直接子项中匹配的
  `rdc-qemu-guest-*.py` 普通文件，部分下载文件、无关文件和非普通文件不受影响；扫描/删除
  失败时 fail closed，证据见 `E-052`。这不是安全擦除，guest 运行时明文边界仍保留。
- 进一步收紧 guest 侧明文边界：首启与恢复置备都会创建 `/run/rdc-presets`（`rdc:rdc`、
  `0700`），受保护 runner 上传改用 `/run/rdc-presets/<job>`，现有节点上传前也会补建该目录；
  VM 重启后持久化盘不再保留这类 runner，证据见 `E-053`。这仍不是安全擦除，运行中的 guest
  root/管理员/调试器仍可能读取明文。
- 新 Windows 安装的授权客户端优先使用 Microsoft Platform Crypto Provider 的 named
  ECDSA P-256 CNG 私钥；客户端只登记 SEC1 公钥，已有 DPAPI/Ed25519 身份保持兼容且不静默
  换绑。状态接口新增 `hardware_backed` / `cng_software_provider` /
  `dpapi_software_fallback` 三级保护级别，Settings 明确区分 TPM/VBS 与 DPAPI 回退；严格
  策略由 `RDC_REQUIRE_HARDWARE_BACKED_KEYS=1` 启用，证据见 `E-054`。当前 provider 未返回
  implementation type 时按软件 CNG 处理，不能据此宣称 TPM/VBS 已通过。
- 追加反逆向源码审计：Release 不嵌入 `qemu_guest.py`，服务端签名私钥不进入桌面构建，
  debug 本地核心回退仅限 `cfg(debug_assertions)`；核心下发、设备 proof、execution grant、
  JTI 一次性消费和 guest 自身哈希边界逐项人工复核，证据见 `E-055`。运行时 guest 明文、
  管理员/root 观察能力和 TPM/VBS 远程证明仍是残余风险。
- 补齐服务端 entitlement 即时撤销：既有 lease 的能力查询和进行中的 artifact transfer
  在撤销后均返回 403；新增 `rdc-auth-admin entitlement revoke` 运维入口，保留撤销记录，
  证据见 `E-046`。这仍不替代生产撤销监控与人工密钥轮换演练。
- fresh boot 后对现有 4096 MiB/full `r13` 重新采样：小红书前台时 guest 约 `2.96 / 3.00 GiB`、
  OOM=0、QEMU working set 约 `3.52 GiB`、宿主可用约 `0.48 GiB`；force-stop 小红书后
  guest 降至约 `2.14 GiB`，但 QEMU working set 仍约 `3.52 GiB`。该结果强化“应用暂停缓解
  guest 压力但不释放 QEMU 基座”的结论；node1 已经 ACPI/QMP 正常停止，证据见 `E-047`。
- 新增 3072 MiB / 2 vCPU / lean 的真实 XHS 样本：冷启动为 2082/1089/1101ms，guest
  current 约 1.33 GiB、峰值触达 1536 MiB 上限但无 OOM；强停 XHS 后仅降至约 1.27 GiB，
  QEMU 仍约 3.14 GiB。该结果说明 lean 1536 MiB 适合作为低占用基线，不应未经登录/浏览验收
  就作为业务推荐，证据见 `E-042`；下一候选是 standard 2048 MiB。
- 完成同配置 standard/2048 MiB 对照：XHS 冷启动 1839/970/1060ms，guest current 约
  1.75 GiB、峰值约 1.98 GiB、OOM=0，QEMU 工作集约 3.13 GiB；这比 lean 多出约 0.5 GiB
  guest 余量但不改变 QEMU 基座，证据见 `E-043`。登录/浏览/30 分钟稳定性仍待人工。
- 已补齐“下载授权 ≠ 执行授权”边界：服务端 `/v1/execution-grants` 依据已发布核心哈希签发短时工作流票据；Rust 将票据绑定到设备、会话、版本、VM/实例并验签；guest runner 在 Docker 操作前使用发布时嵌入的公钥验签、校验自身文件哈希，并向服务端一次性消费 grant JTI。`rdc-auth-admin artifact publish-runner` 同时渲染公钥和 HTTPS consume URL，证据见 E-035。
- 证据与验收：`docs/2026-09-17-runtime-memory-and-core-delivery-report.md`、`docs/2026-09-17-runtime-memory-authorization-acceptance.md`、`work/runtime-core-protection-20260917/evidence/`。
- 实验矩阵模板与当前 full 基线：`docs/qa/2026-09-17-runtime-memory-optimization-matrix.md`；进程构成证据：`work/runtime-core-protection-20260917/evidence/E-005-app-process-breakdown.md`。
- 自动化门槛记录：`tsc` 通过；Vitest 60 文件/460 用例全绿；qemu-center 215+8 通过；authorization-service 23 库测试+2 管理工具测试+2 启动配置测试+3 集成通过；guest runner 17 个 Python 测试；Release 构建与核心明文扫描通过；`git diff --check` 通过。Tauri 全量现为 294 通过、0 失败、2 忽略；Windows 本机 shell 仅对 local PTY 清除继承的 Unix `TERM` 环境变量，设备 ADB shell 不受影响，证据见 `E-056`。执行票据负向覆盖包含过期、签名篡改、动作/设备/核心绑定、设备私钥证明缺失/错误、服务端 artifact 哈希不匹配、artifact/workflow 错配、nonce 重放、grant JTI 一次性消费、runner 自身篡改、消费服务不可达以及消费失败时不构造 Docker；最终复验见 `E-017`、`E-018`、`E-020`、`E-023`、`E-025`、`E-026`、`E-027`、`E-028`、`E-029`、`E-030`、`E-031`、`E-032`、`E-033`、`E-034`、`E-035`、`E-036`、`E-037`、`E-040`、`E-041`、`E-045`、`E-046`、`E-048`、`E-049`、`E-050`、`E-052`、`E-053`、`E-054`、`E-055`、`E-056`、`E-058`、`E-059`、`E-060`；删除护栏/密钥清理复验见 `E-013`、`E-015`。
- 安全边界：无法承诺绝对反逆向；guest 运行时明文仍可能被管理员/root/调试器提取，最高价值算法必须继续服务端化。
- 安全代码审查已完成第一轮：修复已有客户端注册在设备私钥 proof-of-possession
  前修改版本/撤销会话的拒绝服务缺陷；证据为 E-006。生产 TLS、账号、撤销、
  篡改与密钥轮换演练仍待人工验收。
- 发布版详情读取与恢复动作统一使用 `targetAndroid=any` 的服务端通用核心；
  授权服务不可用时实例列表只返回基础只读字段，不回退到内置核心。
- 客户端签名验签已支持构建期 `RDC_AUTH_PUBLIC_KEYS` 旧/新公钥信任环；
  生产仍需按 [`docs/ops/authorization-key-rotation-runbook.md`](ops/authorization-key-rotation-runbook.md)
  完成一次服务端密钥轮换演练；切换后还必须重新发布内嵌执行公钥的 guest runner。
  公钥信任环的代码级聚焦验证见 `E-057`。
- 授权服务已补充真实 Axum 路由集成测试：撤销客户端后旧 transfer 返回 403，
  重启并切换签名私钥后 session 携带新 `keyId`；证据见 `E-008-protocol-integration.md`。
- 又修复了实例列表增强路径未删除下载临时核心的明文残留；四条受保护入口
  统一由 worker 内清理器回收，证据见 `E-009-core-cleanup.md`。
- 用于内存矩阵的 backing-file 克隆已增加 QMP 停止态护栏；运行中的 `node1`
  现场验证会直接拒绝，不执行 `qemu-img`，证据见 `E-007-clone-safety.md`。
- 资源探针失败时不再把 `unknown` 当成可无限并发启动：无其他启动任务时保留
  单实例显式启动，已有启动/排队任务时阻止新增请求；`critical` 仍始终阻止，
  证据见 `E-010-unknown-pressure-start-guard.md`。
- 临界压力下会先自动尝试回收同一节点内一个已确认闲置且状态明确为运行中的未保护实例，
  成功后重新探测；目标、保护、退出和 unknown 状态实例不会被停止，节点保持温热。
  设置可关闭该行为，纯逻辑证据见最新验收记录。
- lean profile 在 3 GiB 及以上节点的默认容器上限与 XHS 实测起点对齐为 1536 MiB，
  避免生成 1152 MiB 的高风险默认值；更小节点仍保留较低回退。
- 创建实例的资源预算现在优先按 guest 只读 Docker 状态统计唯一的 `Up`/`running`
  容器；退出实例不再继续占用运行预算，guest 不可达或状态不完整时仍回退到注册数，
  证据见 `E-022-running-budget-count.md`。
- 新建节点首启时 SSH 可能早于 cloud-init 的 docker 组刷新；guest Docker 操作
  统一使用 `sudo -n docker`，恢复置备脚本以 root 执行。3072 MiB 独立测试节点已
  实测创建 lean 实例并通过 binderfs/Docker readiness，证据见
  `E-011-guest-bootstrap-permission-window.md`。
- `vm delete` 现在先经 QMP 证明节点已停止，运行中或未知状态拒绝删除；`--purge`
  同时清理节点目录和两份 SSH key，避免留下可误认的孤儿凭据，证据见
  `E-013-delete-safety-and-key-cleanup.md`。
- `guest wait` 现在在 SSH 后继续等待 cloud-init、binder 和 Docker readiness；
  Windows 侧还会记录 QEMU PID，在 QMP 被本地代理隐藏时以“PID 已退出 + 端口可绑定”
  完成停止证明。真实临时节点的 XHS lean/ART 样本与安全清理见 `E-015`、`E-016`。
- 客户端租约首次校验使用本机时间与服务端时间的较大值，接受后转为单调时钟计时，
  旧 `serverTime` 或进程内系统时钟回拨不能延长授权；回归和全套门禁见 `E-018`。
- 受保护核心下载会继承共享运行时中已验证的 session，避免授权成功后因重建下载
  客户端丢失租约上下文；回归见 `E-019`，最终门禁见 `E-020`。
- 发布配置现在通过无副作用解析器 fail-closed：缺服务地址、公钥环、重复/非法 key
  或非回环 HTTP 均在构造 transport 前拒绝；focused 测试已覆盖，回环 HTTP 仅保留
  本地开发例外。生产 TLS、账号、撤销和密钥轮换仍需现场演练。
- QEMU 页面现在独立显示实例 cgroup 饱和度：current/limit 达到 90% 标为接近上限，
  75%–90% 标为紧张，缺失数据保持 unknown；提示优先暂停应用或新建 lean/standard，
  不自动修改运行中实例。纯函数和前端全套复验见 `E-025-instance-saturation-indicator.md`。

---

## 二、待办清单（按优先级；完成后从此节移除）

### ★ P7-1 真机人工走查（最高优先：唯一阻塞「合并完成」的项）

- 逐条清单：`docs/qa/2026-09-16-merge-p7-walkthrough-checklist.md`（当前仓库内，默认状态仍为未执行）
- 前置：`npm run tauri dev` 启动应用；QEMU 节点 node1 运行；Docker Desktop 运行
- 环境状态：node1 曾通过 doctor **8 ok / 0 fail / 0 unknown**，并实测 `qc-r1`(A14) 与 `qc-r13`(A13) 可 boot 且宿主 adb 为 `device`；本轮已通过 QMP/ACPI 正常停止，下一轮走查前需按环境速查重新启动。Docker 引擎状态以走查时现场检查为准。
- 当前限制：桌面自动化 helper 未配置可控制的 Windows 应用（仅返回空的 in-app browser）；因此 C/D/E 仍必须由用户在真实 Tauri 窗口中人工确认，不能仅凭 Vitest 或 CLI 输出勾选通过。
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
| 9 | 运行时优化与授权生产验收 | 应用级暂停、临界压力闲置回收、未知压力并发护栏、共享节点闲置释放护栏、critical 压力温热节点保护、桌面/CLI 双层 VM 内存预检查、full profile 新建内存护栏、内存优先缺省回收、per-operation execution grant 和 entitlement 即时撤销已实现；已补充隔离 3072 MiB lean/standard XHS 样本（E-039、E-042、E-043）、新建 3072 MiB/2 vCPU lean 独立样本（E-051）、4096 MiB/full r13 最新前台与 force-stop 对照（E-047）、默认策略回归（E-048）、critical 覆盖回归（E-049）、真实授权服务进程冒烟（E-044）、共享节点停止安全证据（E-045）、entitlement 撤销证据（E-046）、QMP 超时主机进程安全兜底/隔离克隆证据（E-058）、2048 MiB QEMU 基座与克隆 SSH 身份修复证据（E-059）以及 2048 MiB 真实 Redroid lean 启动证据（E-060）；仍需按 `docs/2026-09-17-runtime-memory-authorization-acceptance.md` 完成人工登录/连续浏览/30 分钟内存矩阵、真实服务 TLS/账号部署、断网/篡改/复制/票据重放演练和生产密钥轮换；完成前不得宣称省下固定 GB 或“绝对反逆向” |

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
