# 运行时内存与授权链路验收清单

**状态**：自动化门槛已通过；真机、视觉和生产部署由人工确认

## 自动化门槛

- [x] `npx tsc --noEmit`
- [x] `npx vitest run`（60 文件 / 460 用例）
- [x] `cargo test --manifest-path src-tauri/Cargo.toml`（294 通过 / 0 失败 / 2 忽略）
- [x] `cargo test --manifest-path qemu-center/Cargo.toml`（213 库 + 6 CLI 通过）
- [x] `cargo test --manifest-path authorization-service/Cargo.toml`（23 库测试 + 2 管理工具测试 + 2 启动配置测试 + 3 集成通过）
- [x] `git diff --check`

服务端额外覆盖：nonce 重放、执行票据的已发布 artifact 哈希不匹配、execution grant JTI 一次性消费与重放拒绝、旧 session 撤销、客户端版本不匹配、设备绑定、权限撤销、目标 ABI/Android 不匹配、加密分块解密和完整性绑定；控制面超大请求在 JSON 解析前由 `64 KiB` body limit 拒绝，证据见 `E-030-authorization-control-plane-body-limit.md` 与 E-035。

服务启动额外覆盖：`RDC_AUTH_BIND` 只接受字面量回环 socket 地址；通配、局域网、公网和主机名绑定在打开监听器前拒绝。生产反向代理、真实账号和密钥托管仍需人工演练。Windows local PTY 继承的 Unix `TERM` 环境变量已隔离，最终全套门禁与 Release 扫描见 `E-056-final-verification-and-pty-fix-20260920.md`。

桌面端 QEMU 节点启动额外覆盖：读取目标节点的 `mem_mib`，在 QEMU 创建前要求主机可用
内存至少保留节点配置加 1 GiB，并串行化多个 VM 启动预检查；资源探针 unknown 时保留
明确单次启动兼容路径。隔离压力实验与清理记录见 `E-028-vm-start-memory-guard.md`。

独立 CLI 入口额外覆盖：`qemu-center vm start` 在 detached spawn 前检查 QMP stopped
状态与主机可用内存；Windows 使用 CIM，Linux 使用 `/proc/meminfo`，已知余量不足时
拒绝启动，主机内存探针不可用时仅允许带 warning 的明确单节点启动。记录见
`E-029-cli-vm-start-memory-guard.md`。

## 内存矩阵

当前进程级基线见 `work/runtime-core-protection-20260917/evidence/E-005-app-process-breakdown.md`；RSS 合计会重复计算共享页，不能替代 cgroup current。最新 4096 MiB/full `r13` 前台与 force-stop 对照见 E-047。
完整记录表见 `docs/qa/2026-09-17-runtime-memory-optimization-matrix.md`；E-033 已补充一次
安全启动后的真实 full `r13` 快照：约 3060 / 3072 MiB（99.6%）、OOM=0、主机可用约
0.356 GiB；本轮 E-036 又取得 fresh boot 与前台 XHS 的三次采样，但仍不能替代
登录、连续浏览和稳定性人工矩阵。

基于 E-033，新的 full profile 在节点配置低于 6144 MiB 时由 qemu-center 后端拒绝，
桌面创建表单同步禁用该选项并提示选择 lean/standard；现有 4 GiB 节点与已有 full
实例不自动改写、不停止。自动化证据见 `E-034-full-profile-admission-guard.md`。

应用级暂停路径已实现并覆盖自动化映射/包名安全测试：默认手动暂停目标包，
保留 VM 与 container；闲置策略、QEMU 映射或包名校验失败时只返回结构化原因，
不执行 ADB 停止。实际内存释放量、恢复时间、登录和连续浏览仍待人工 A/B。

闲置回收的缺省策略现在是内存优先：新安装或缺失 `runtimeKeepVmWarm` 的配置默认在安全证明
节点为空后停止 QEMU；显式保存 `true` 的配置仍保持温热节点。Rust 配置/调度器和设置页回归见
`E-048`。这只改变缺省值，不会覆盖用户已有的显式偏好。

已有显式温热配置也增加了 critical 压力保护：normal/caution/unknown 仍尊重用户选择，只有
主机进入 critical 且新鲜只读列表确认节点为空时才临时释放 QEMU，见 `E-049`。

新建 3072 MiB 测试节点的首启链路已现场验证：`guest wait` 现在会在 SSH 后继续等待
cloud-init 完成、binder 和 Docker readiness；CLI 的 Docker 操作统一通过
`sudo -n docker`，`guest provision` 恢复脚本也以 root 执行并返回
`binderfs=Ok docker=Ok`。
这项证据只覆盖节点置备与精简实例启动，不等于小红书登录/连续浏览矩阵完成。

已完成一个 3072 MiB / 4 vCPU / lean / 1536 MiB 的 XHS 冷启动三次对照；完整组合仍需在不触碰现有业务数据的复制实例上执行，每个组合至少重复 3 次，记录 P50/P95：

另完成一个 3072 MiB / 2 vCPU / lean / 1536 MiB 的真实 XHS 冷启动样本：
`2082/1089/1101 ms`，guest current 约 `1.33 GiB`、峰值触达 `1536 MiB`、OOM=0；
强停 XHS 后 guest current 约 `1.27 GiB`，QEMU 工作集仍约 `3.14 GiB`（E-042）。
该组合仍未通过登录/连续浏览验收，下一候选应为 standard/2048 MiB，而不是继续压低
lean 上限。

随后完成同一隔离配置的 standard/2048 MiB 对照：冷启动
`1839/970/1060 ms`，guest current 约 `1.75 GiB`、峰值约 `1.98 GiB`、OOM=0；
QEMU 工作集约 `3.13 GiB`，强停 XHS 后 guest current 约 `1.68 GiB`（E-043）。
这只证明内存余量改善，不等于登录、连续浏览或 30 分钟稳定性通过。E-047 进一步显示，
force-stop 小红书可降低 guest current，但 QEMU working set 基本不变。

另完成一个全新 `2 vCPU / 2048 MiB` Ubuntu/Docker 基座样本：cloud-init/Docker readiness
完成后，QEMU working set 约 `1.89 GiB`、guest available 约 `1.54 GiB`、宿主可用约
`2.8 GiB`。该节点没有安装小红书或执行登录/浏览，因此 2048 MiB 目前只作为低内存
候选，不替代 3072 MiB standard 的业务验收；证据见 `E-059`。

| 节点内存 | 档案 | 场景 | 记录 |
|---:|---|---|---|
| 3072 MiB | lean | 冷启动、登录、浏览 10 分钟 | host available、QEMU private/working-set、WSL、container current/peak/OOM、首屏耗时 |
| 3072 MiB | standard | 冷启动、登录、浏览 10 分钟 | 同上 |
| 3072 MiB | full | 冷启动、登录、浏览 10 分钟 | 同上；重点观察 GApps/Magisk |
| 4096 MiB | lean/standard/full | 同上 | 作为对照，不改写生产 node1 |
| 3072/4096 MiB | 任一 | 两实例错峰启动、切换、停止空闲实例 | 队列行为、宿主可用内存、OOM、恢复时间 |

通过条件：小红书可登录并连续浏览；无新增 OOM；切换已有进程明显快于 force-stop 后重启；压力状态没有把未知数据误判为正常。若 full 档案失败，保留 standard/lean 的证据，不把容器上限盲目继续压低。

后端启动语义：`critical` 始终阻止；`unknown` 允许一次明确的单实例启动，
但在已有启动/排队任务时阻止新增请求，避免指标不可用时形成并发启动洪峰。
自动化证据见 `work/runtime-core-protection-20260917/evidence/E-010-unknown-pressure-start-guard.md`。

临界压力下现在会先尝试自动释放同一节点内一个已确认闲置、状态为运行中且未保护的实例，
随后重新读取压力；目标实例、保护实例、退出实例和 unknown 状态均不会被停止，节点保持运行。
该功能默认开启，可在高级设置中关闭；当前只完成了纯逻辑和状态分类测试，实际停止/恢复
仍需在隔离节点人工演练。

## ART A/B

已完成的 lean/XHS 样本见 `E-016-xhs-lean-art-matrix.md`：speed-profile 前后 P50 为
914 ms → 932 ms；本轮现有 full 实例见 E-036，P50 为 2142 ms → 1544 ms。
两者都未覆盖登录/连续浏览，因此 speed-profile 仍保持显式实验入口，不设为全局默认。
Android 13 的 verify-only 命令为 `cmd package compile -m verify --check-prof true <package>`；
`--reset` 对普通 ADB shell 会被系统拒绝，必须由有权限的操作者显式执行。

## 授权链路

- [x] 客户端首次验证租约时取 `max(localWallClock, serverTime)`；进程内后续过期判断使用单调时钟，旧响应时间或本机时钟回拨不能延长租约。
- [x] 未配置 `RDC_AUTH_*` 的 release 构建不能执行 QEMU 预装/创建（纯配置解析测试 + release 核心体扫描已通过）。
- [x] 授权服务 `/v1` 控制面请求体限制为 `64 KiB`，超限请求在 JSON/业务处理前返回 `413`，不创建 transfer。
- [x] 新设备注册后显示 pending，未审批前不能取得 lease（E-031）。
- [x] 审批并授予 `protected-artifact` 后，能取得短 lease 并完成目标 artifact 下载（E-031）；`protected-preset` 仍由既有服务授权测试覆盖。
- [x] 下载后的执行边界已单独授权：`/v1/execution-grants` 按发布 artifact 哈希签发短时工作流票据，Rust 与 guest runner 均校验设备/会话/版本/VM/实例/动作绑定；渲染公钥的发布工具与自动化覆盖见 E-035。
- [x] 修改 ciphertext、设备 ID、session bearer 或 chunk index 时拒绝；manifest 签名/目标字段由现有客户端与服务端绑定测试覆盖（E-031 及既有授权测试）。
- [x] 撤销客户端、撤销 entitlement、重新注册新版本后，旧 session 和旧 transfer 均拒绝（E-008、E-046；生产现场演练仍待人工）。
- [x] 协议层已证明：临时 artifact、改名后的 artifact 或复制的 grant 没有当前设备私钥的 `device_proof` 不能复用；缺失证明/错误设备证明均返回 403 且不消费 JTI，见 E-050。真实跨机器复制演练仍需人工。
- [x] 创建、升级、恢复和列表增强完成后，客户端临时目录不残留下载的明文核心。
- [ ] 断网、过期和服务端不可达时 fail closed；普通只读诊断仍可使用。
- [x] 当前 release 主程序中不存在可离线工作的本地核心脚本正文或服务端私钥（E-032）；`windows-release.yml` 已将 `scripts/verify-release-core.ps1` 设为阻断步骤。
- [x] guest runner 缺少票据、票据签名不可信、工作流/VM/实例/核心 artifact 不匹配、消费服务拒绝/不可达或自身文件哈希不匹配时，在 Docker 操作前 fail closed；原始 placeholder runner 不能直接作为生产 artifact 发布，必须经过 `artifact publish-runner` 渲染（E-035）。
- [ ] 按 [`docs/ops/authorization-key-rotation-runbook.md`](ops/authorization-key-rotation-runbook.md)
  完成一次服务端签名密钥轮换：双公钥客户端 → 暂停受保护操作 → 服务端切换并重新发布
  runner → 旧客户端退出后移除旧公钥。

执行票据现在由 guest 在 Docker 前向服务端做一次性消费，并额外要求当前设备私钥对 grant payload 的证明；真实部署仍需完成 HTTPS 可达性、跨机器复制、篡改核心、篡改动作/目标、票据重放以及服务不可达的人工演练。管理员/root/调试器在合法执行期间取得 runner 明文或修改 runner 仍属于明确的不可消除边界。

## 上线配置

服务端私钥只通过 secret manager 注入：

```text
RDC_AUTH_SIGNING_KEY=<secret-manager value>
RDC_AUTH_SIGNING_KEY_ID=<key id>
RDC_AUTH_DATABASE_URL=<private database path or URL>
RDC_AUTH_ARTIFACT_ROOT=<private artifact root>
RDC_AUTH_BIND=127.0.0.1:8787
```

桌面 release 构建只注入公钥和服务地址；生产入口应由托管边缘终止 TLS 1.3：

```text
RDC_AUTH_BASE_URL=https://<private-service-domain>
RDC_AUTH_PUBLIC_KEYS=<key-id>=<base64url Ed25519 public key>,<next-key-id>=<base64url Ed25519 public key>
```

Windows release workflow 使用同名的 GitHub Actions repository variables；缺少任一
变量会在 Tauri 编译前失败。服务端 `RDC_AUTH_SIGNING_KEY` 不得作为桌面 job 的环境变量
或构建参数出现。

单公钥部署仍可使用 `RDC_AUTH_PUBLIC_KEY_ID` 与 `RDC_AUTH_PUBLIC_KEY`；轮换窗口
应使用 `RDC_AUTH_PUBLIC_KEYS`。

不要把真实值写入仓库、日志、命令行历史或 issue。
