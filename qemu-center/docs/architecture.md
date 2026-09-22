# qemu-center 架构与 RDC 适配设计

本文档分两部分：

1. **现状（已交付）**——`qemu-center` 作为完全独立 crate 的内部结构，以及它与主仓库 Docker 轨道的对照关系；
2. **RDC 适配（已启动）**——原设计草图中的第 1–3 步已于本轮落地（CLI 子进程桥接 + QEMU 节点页 + 运行时偏好开关）；`Runtime` trait 抽象与 Devices 页双轨混排仍未实现，见文末「接线进展与剩余项」。**本 crate 依旧不依赖 RDC 代码，RDC 通过 CLI 子进程 + `--json` 契约调用本 crate。**

---

## 一、现状：两条轨道并列

```
Android-Device (Tauri 2 + React 19 + Rust)
├── src-tauri/src/services/docker.rs      ← 既有轨道：Windows/WSL2 内核 + Docker Desktop + redroid（3000+ 行，42+ 函数）
├── src/…                                 ← 既有前端
└── qemu-center/                          ← 新轨道：独立 crate，零文件接触
    ├── Cargo.toml   (serde/serde_json/clap/dirs only, publish=false)
    └── src/{lib,main,iso,fat,cloudinit,vm,guest,redroid,doctor,verify,exec}.rs
```

两条轨道的**共性**与**差异**：

| 维度 | Docker 轨道（既有） | QEMU 轨道（新增） |
|---|---|---|
| 内核 | 宿主 WSL2 内核，redroid 容器直接跑 | guest Ubuntu 内核，redroid 跑在 guest 内 Docker |
| 隔离粒度 | 实例级（每个容器独立） | **节点级**（一 VM 多容器共享 guest 内核） |
| 宿主依赖 | Docker Desktop + WSL2 | QEMU + WHPX（Hyper-V 平台） |
| adb 路径 | `-p 127.0.0.1:<port>:5555` 直接暴露 | `docker -p <port>:5555` → slirp hostfwd → 宿主 `<port>` |
| redroid 镜像 | `redroid/redroid:*` | 同镜像（`redroid/redroid:14.0.0-latest` 默认） |
| redroid 参数语义 | privileged + `androidboot.redroid_*` | 相同语义，**独立实现**（见下） |
| 快照/克隆 | `docker commit` + 数据卷 | qcow2 internal snapshot + backing file 克隆 |
| 内核准备 | WSL 内核自带 binder/ashmem | cloud-init 在 guest 内装 `linux-modules-extra` + `modules-load.d` 自加载 binder_linux（binderfs 由 redroid 容器自挂载，fstab 条目已因 emergency mode 事故移除） |

### 为什么 redroid 参数是"独立实现"而不是复用

`qemu-center/src/redroid.rs` 按 redroid 官方文档语义**重写**了 `docker run` 参数（`--privileged`、`--cpus`、`--memory`、`-v <vol>:/data`、`-p <port>:5555`、`androidboot.redroid_width/height/dpi/gpu_mode`），**不 import** `src-tauri/src/services/docker.rs`。原因有三：

1. **零接触铁律**：不修改既有文件，也不让既有文件的任何改动影响本 crate 的编译；
2. **可在任意机器独立编译**：本 crate 不知道 Tauri/Docker Desktop 的存在；
3. **同构而非同一**：两者共享的是"redroid 上游镜像的接口语义"，这是**稳定的契约**；而 RDC 的 `docker.rs` 还承载了伪装/痕迹清理/绑定 DNS 等产品逻辑，不应被新轨道继承。

正因如此，未来的适配层只需要把"语义等价"的参数映射过去（见第二部分）。

### 模块职责与数据流

```
CLI (main.rs)
  │  clap 解析 → 纯函数拼装 argv → exec::run_command/spawn_detached
  │
  ├─ doctor.rs ──► 纯: powershell_feature_command / parse_feature_state /
  │                      qemu_whpx_probe_command / classify_whpx_probe /
  │                      candidate_qemu_dirs / find_qemu_in / fsutil 解析
  │                运行: run_doctor(state_dir) → DoctorReport{ok|fail|unknown} → text/json
  │
  ├─ vm create ──► cloudinit::seed_image_files(cfg) ──► fat::build_fat16_image ──► vms/<name>/seed.img
  │                （自写零依赖 FAT16：卷标 CIDATA + LFN 小写文件名，只读 virtio 盘；
  │                  自建 ISO 的 `seed_files`+`iso::build_iso` 与 QEMU VVFAT 均已被真机证伪退役，见 README）
  │                vm::qemu_img_create_overlay(disk, base_image)  ──► disk.qcow2
  │                vm::allocate_port_block / next_free_port       ──► ssh/qmp/adb 端口
  │                vm::save_registry(atomic temp+rename)          ──► state.json
  ├─ vm start ───► vm::qemu_command(LaunchOptions{detach})  ──► exec::spawn_detached (Win)
  │                   · Accel::Whpx → 追加 `-cpu max,-svm,-vmx`（vm::WHPX_CPU_SPEC：防 WHPX guest 挂死）
  │                   · 两种加速器都追加 `-serial file:vms/<name>/console.log`（guest 串口现场）
  │                                                              exec::run_command (-daemonize, POSIX)
  ├─ vm stop ────► vm::qmp_stop_frames()  ──► TcpStream 到 <qmp_port>
  ├─ vm snap/clone ─► vm::qemu_img_snapshot_create / qemu_img_create_overlay
  ├─ guest * ────► guest::ssh_command(key, known_hosts, ssh_port, remote_cmd)
  │                guest::render_provision_script / render_readiness_script
  ├─ redroid * ──► redroid::redroid_create_args(spec)  ──► guest 内 `docker run …`
  │                vm::VmEntry::next_free_adb_port()   ──► 端口分配 → state.json
  └─ verify ─────► 7 × (命令拼装 + 纯判定)；每项独立 PASS/FAIL/UNTESTED
```

设计原则：**每个对外动作都拆成"纯拼装/纯判定"与"运行时执行"两半**。纯函数被单测覆盖（最终复验见 E-017），运行时半边按 README 的验证层级诚实标注，不把一次性冒烟当成完整业务验收。

### 关键设计取舍

| 决策 | 选择 | 理由 / 代价 |
|---|---|---|
| cloud-init 种子载体 | **自写零依赖 FAT16 镜像**（`fat.rs`：64 MiB 裸 FAT16 卷、卷标 `CIDATA`、VFAT LFN 存小写文件名，`-drive file=<seed.img>,if=virtio,format=raw,read-only=on` 挂普通 virtio 盘） | 载体三步演进，前两步均真机证伪：①自写 ISO9660 目录记录强制大写（`USER-DATA.;1`），guest 的 cloud-init NoCloud 找不到小写 `user-data`，种子被整体忽略；②QEMU VVFAT（`file=fat:<dir>`）保留小写名但**卷标固定 `QEMU VVFAT` 不可配置**，`ds-identify` 的 `LABEL=cidata` blkid 扫描不命中 → cloud-init 完全不激活（真机 console：零 cloud-init 日志 + networkd-wait-online 卡死）。③自写 FAT16 在用户真机全链路验证通过（cloud-init done / Docker 29.1.3 active / SSH 公钥 OK）。`iso.rs`/`seed_files` 保留为库 API 与测试资产 |
| WHPX 探测 | 两段式：CIM `Win32_OptionalFeature`（非管理员可查）+ 真实 `-accel whpx -machine q35 -S` 探测（8 秒超时） | 功能开关为 Enabled 不代表可用（可能与其他 hypervisor 冲突）；实际探测才是硬证据。`-S` 保证不真跑 CPU；q35 探针成功时 QEMU 不退出，超时被杀即 Available |
| **WHPX 下的 CPU 模型** | **钉死 `-cpu max,-svm,-vmx`**（`vm::WHPX_CPU_SPEC`，仅 `Accel::Whpx`；TCG 保持 QEMU 默认模型） | 真机实证（i5-11400H / Win11 / QEMU 11.1 / WHPX）：无 `-cpu` 时默认模型暴露宿主背不了的嵌套虚拟化位（`CPUID[eax=80000001h].ECX.svm`），guest 被 `WHPX: Unexpected VP exit code 4` 刷屏并挂死（node1 一天卡死 3 次）。加显式掩码（唯一变量）后异常计数归零、`boot_completed=1`、数据卷完好。redroid 不需要嵌套虚拟化 → `-svm,-vmx` 无功能损失；TCG 纯软件模拟不触发该故障，加掩码只会白丢特性 |
| **guest 串口现场** | 两种加速器都加 `-serial file:<vm_dir>/console.log`（`vm::console_log_path` 由磁盘路径派生，`qemu_path_arg` 统一 `/` 分隔） | `qemu.log` 只有 QEMU 自己的 stdout/stderr（VP exit 那类），guest 内核/Android 控制台另走 chardev；卡死在网络起来之前时没有它就没有事后现场。`-serial` 与 `-display none`/QMP 互不干扰；`vm start` 打印该路径 |
| Windows 后台运行 | argv **不含** `-daemonize`，改由 `exec::spawn_detached`（`DETACHED_PROCESS \| CREATE_NEW_PROCESS_GROUP \| CREATE_NO_WINDOW`） | QEMU 的 `-daemonize` 是 POSIX-only（fork）；`Detach::Daemonize` 保留给 Linux/macOS 宿主 |
| 停止 VM | 每 VM 一个 QMP TCP 端点，`qmp_capabilities` → `system_powerdown` | 零依赖可用 std `TcpStream` 实现优雅关机；代价：guest 若不响应 ACPI 需手动杀进程（CLI 明示） |
| 端口分配 | 每 VM 一段**连续** adb 端口块 + 独立 ssh/qmp 端口；全局扫描注册表去重；禁用 5555–6000 | 连续块让 `hostfwd` 列表可读；启动时一次性声明（slirp 不能热加规则）；与 Docker 轨道端口零冲突 |
| 磁盘 | cloud image 只读 backing + 每 VM 一个 overlay；克隆 = 新 overlay 指向前一个 overlay | 零拷贝、秒级创建；代价：backing 链不能随意移动（state.json 记录路径） |
| 注册表持久化 | `state.json`，temp 文件 + rename 原子替换 | 崩溃不留半截文件；**无跨进程锁**（已知局限，单操作者 CLI） |
| crate 结构 | `[lib] qemu_center` + 薄 bin | 纯函数 API 成为真实公共接口（不触发 dead-code 警告），且便于未来被 RDC 以库方式依赖 |
| 依赖 | 仅 serde / serde_json / clap / dirs | 红线；`parking_lot` 等一律不用 |
| 便携化（本轮） | 所有产物收进 `<repo>/qemu-center/state`：桥接层每次调用显式追加 `--state-dir`；`setup qemu` 默认 NSIS `/S /D=` 便携安装到 `state\qemu`；winget/scoop/choco 降级为 `--machine` | 用户需求"装进项目不装进电脑"；卸载 = 删目录。代价见下节 |

## 二、RDC 适配：设计草图 + 接线进展

> **状态更新（本轮）：集成方式 1（子进程 + JSON）已按"先做"落地。** 下面的 trait 草图仍是**未实现的远期设计**，本轮采用的是更轻的"独立 QEMU 节点页"方案（见文末「本轮接线进展与剩余项」），二者不冲突：trait 抽象留待 Devices 页双轨混排时再引入。

### 目标

RDC 目前把"设备运行时"硬编码为 Docker（`src-tauri/src/services/docker.rs` 的 42+ 函数）。目标是抽象出一个 trait，使：

- `DockerRuntime` = 现有 docker.rs 的**薄包装**（行为不变）；
- `QemuRuntime` = 调用 `qemu-center` CLI 的子进程适配器；
- 前端 Settings 里一个开关（`runtime: "docker" | "qemu"`）决定注入哪个实现。

### trait 草图（RDC 侧新增文件，不在本 crate）

```rust
// src-tauri/src/services/runtime/mod.rs  ——  将来新增，不改现有函数签名
pub trait DeviceRuntime: Send + Sync {
    /// 后端标识，用于 UI 展示与持久化选择。
    fn kind(&self) -> RuntimeKind;                       // Docker | Qemu

    /// 运行时就绪探测（Docker: engine ping；QEMU: doctor 汇总）。
    fn probe(&self) -> Result<RuntimeStatus, RuntimeError>;

    /// 列出全部实例。
    fn list(&self) -> Result<Vec<InstanceSummary>, RuntimeError>;

    /// 创建一个实例（Docker: docker run；QEMU: ssh → guest 内 docker run）。
    fn create(&self, req: CreateRequest) -> Result<InstanceHandle, RuntimeError>;

    fn start(&self, id: &InstanceId) -> Result<(), RuntimeError>;
    fn stop(&self, id: &InstanceId) -> Result<(), RuntimeError>;
    fn destroy(&self, id: &InstanceId) -> Result<(), RuntimeError>;

    /// 快照/克隆（Docker: commit+volume；QEMU: qcow2 snapshot/backing clone）。
    fn snapshot(&self, id: &InstanceId, tag: &str) -> Result<SnapshotInfo, RuntimeError>;
    fn clone(&self, id: &InstanceId, new_name: &str) -> Result<InstanceHandle, RuntimeError>;

    /// 该实例的 adb 串口（"127.0.0.1:PORT"），RDC 现有 adb/scrcpy 代码直接用。
    fn adb_serial(&self, id: &InstanceId) -> Result<String, RuntimeError>;

    /// 实例内 shell（RDC 现有 root/terminal 功能需要）。
    fn shell(&self, id: &InstanceId, cmd: &str) -> Result<ShellResult, RuntimeError>;

    /// 能力声明：QEMU 轨道缺哪些能力（如宿主级 GPU passthrough、部分伪装挂载），
    /// UI 据此灰掉对应按钮而不是报错。
    fn capabilities(&self) -> RuntimeCapabilities;
}
```

### QemuRuntime 的映射（全部通过 CLI 子进程，无 Rust 依赖耦合）

| trait 方法 | qemu-center 命令 | 备注 |
|---|---|---|
| `probe` | `doctor --json` | 解析 `DoctorReport`；有 fail 则 UI 显示修复指引 |
| `list` | `vm list --json` + `redroid list --vm X --json` | 节点 → 实例两级 |
| `create` | `redroid create <vm> <name> …` | **节点必须已存在**；RDC UI 需要新增"节点管理"入口（或首次使用时引导 `vm create`） |
| `start/stop` | `redroid start/stop <vm> <name>` | `vm start/stop` 是节点级，UI 需区分两级操作 |
| `snapshot/clone` | `vm snapshot/clone`（节点级）或将来加实例级 | 语义差异：QEMU 快照是**整节点**，RDC 现有 "克隆实例" 语义需映射到节点级并提示 |
| `adb_serial` | `adb map <vm>` | 直接得到 `127.0.0.1:PORT`，**现有 adb/scrcpy 代码零改动** |
| `shell` | `ssh -p <port> -i <key> rdc@127.0.0.1 'docker exec qc-<name> …'` | 现有 terminal 功能需要接受"两跳"命令模板 |
| `capabilities` | 静态 | QEMU 轨道：`gpu_passthrough=false`（无 /dev/dri）、`node_level_isolation=true`、`per_instance_kernel=false` |

### 集成方式（两种，择一）

1. **子进程 + JSON（推荐，先做）**：RDC 通过 `std::process::Command` 调用 `qemu-center` 二进制，用 `--json` 输出通信。优点：零编译耦合、crate 独立演进、崩溃隔离；缺点：需要约定 CLI JSON 契约（现已稳定：`doctor`/`verify`/`vm list`/`redroid list`/`adb list` 均支持 `--json`）。
2. **库依赖**：RDC 的 `Cargo.toml` 加 `qemu-center = { path = "../qemu-center" }`。优点：类型安全；缺点：把 clap/dirs 带进 Tauri 构建，且要保证不引入 workspace 冲突（**注意**：`qemu-center` 必须保持独立 crate、无 workspace 成员声明，否则会影响 `src-tauri` 构建）。

### 落地顺序（建议）

1. RDC 侧新增 `services/runtime/`（trait + `DockerRuntime` 包装现有 42 个函数，**行为零变更**）+ 现有 153 测试保持全绿；
2. 新增 `QemuRuntime`（子进程方式），仅在 Settings 里可选、默认关闭；
3. UI：Settings 增加运行时开关 + 节点管理页（`vm create/start/stop`、doctor 报告渲染）；
4. 能力差异通过 `RuntimeCapabilities` 灰化按钮，不做"假装支持"；
5. 端到端验收：docker 轨道回归 153 测试；qemu 轨道跑 `verify` 七项。

### 明确不做的

- 不在 RDC 内复制 `qemu-center` 的任何命令拼装逻辑（单一事实源在 CLI）；
- 不让 `qemu-center` 依赖 RDC 的类型（避免循环依赖，也避免 Tauri 版本抖动污染独立轨道）；
- 不改 `docker.rs` 的既有函数签名（适配层用包装，逐步迁移）。

### 环境安装的自动化映射

`qemu-center setup all` 的每个步骤在 RDC 接入后映射为一个 Tauri 命令 + 设置页进度 UI（whpx→DISM 自提权、qemu→winget 通道、image→IWR 下载 + SHA256 校验），用户在界面上点一个按钮完成宿主准备。

### 本轮接线进展与剩余项（记录）

**已落地（RDC 侧，全部纯增量）：**

| 项 | 位置 |
|---|---|
| CLI 子进程桥接（bin 解析 / argv 拼装 / `--json` 解析 / 60 分钟超时上限的 spawn） | `src-tauri/src/services/qemu.rs`（21 个单测：二进制解析优先级、各参数拼装、doctor/vm list/verify JSON 解析、默认镜像路径派生；**spawn 运行时未验证**，与 qemu-center 的诚实边界同档） |
| 12 个 Tauri 命令（doctor/setup/vm 5 个/guest wait/redroid 2 个/adb list/verify） | `src-tauri/src/commands/mod.rs` 末尾 + `lib.rs` 注册 |
| 「QEMU 节点」页（环境体检卡 / 节点卡 / 实例卡 / 验收卡 / 折叠日志面板） | `src/pages/QemuCenter.tsx`，路由 `#/qemu`，导航项 `common.nav.qemu` |
| QemuService（invoke 包装） | `src/services/deviceService.ts` 末尾 |
| 默认运行轨道偏好（`default_track: Option<String>`，仅记录） | `AppSettings`（Rust + TS）+ Settings 页下拉 |
| i18n 字典 | `src/i18n/pages/qemu.ts`（zh/en） |
| 文档（本文件 + README 3.2 节按钮映射） | — |

**与原映射表的偏差（如实记录）：**

- `probe`/`list`/`create` 等没有走 trait，而是独立的 QemuService + 独立页面——避免一次性抽象两条轨道，Docker 轨道零改动；
- `snapshot/clone` 与 `shell` 两跳命令本轮未接（UI 无入口），保留 CLI 能力；
- `capabilities` 差异以页面顶部常驻「实验性」横幅代替按钮灰化；
- `adb_serial` 通过 `redroid list --json` 的 serial 字段直接下发（`adb map` 的文本输出未被 UI 消费）。

**剩余项（下一阶段候选）：**

1. Devices 页双轨混排：`vm list`/`redroid list` 结果并入设备列表（或提供轨道筛选），对应 `Runtime` trait 抽象落地；
2. 实例迁移：Docker 轨道容器 → QEMU 节点的一键迁移（镜像 + 数据卷导出导入）；
3. 实例级 start/stop 按钮映射到 `redroid start/stop`（CLI 已有，UI 未接）；
4. `guest provision` 的补救入口（CLI 已有，UI 未接）；
5. QEMU verify 全绿前，`default_track=qemu` 仅是偏好，不改变任何默认行为。

## 三、便携化决策（本轮）

**需求**："QEMU 节点中安装的所有东西都安装到项目内，不是安装到本地电脑中"。改造前的两处外部落点：`setup qemu` 走 winget 装到 `C:\Program Files`（机器级）；state/images 在 `%APPDATA%\QemuCenter`（用户级）。

### 目标布局

```
<repo>/qemu-center/state/          # 项目内唯一根（"home"）
  state.json  keys/  vms/<name>/{disk.qcow2,seed.img,known_hosts}
  images/<distro>.img + SHA256SUMS-<distro>
  qemu/qemu-system-x86_64.exe + qemu-img.exe     # 便携 QEMU 本体（本轮新增）
  tmp/                                            # 安装器下载暂存（装完清理）
```

### 决策与代价

| 决策 | 选择 | 理由 / 代价 |
|---|---|---|
| state-dir 谁定 | RDC 桥接层**每次** invoke 都追加 `--state-dir <repo>/qemu-center/state`（纯函数 `default_portable_state_dir`，沿用 `CARGO_MANIFEST_DIR` + exe 上溯定位仓库根）；CLI 侧新增 `QEMU_CENTER_STATE_DIR` 环境变量作为命令行的等价开关 | 单一事实源在 CLI，桥接只负责"钉住"路径；代价：桥接层多一个仓库布局假设，打包分发时需要随包携带 `qemu-center/state`（或设该环境变量） |
| QEMU 装法 | 默认 **NSIS 便携安装**：抓 `https://qemu.weilnetz.de/w64/` 目录页 → 解析最新 `qemu-w64-setup-<日期>.exe` → 下载到 `state/tmp` → `installer /S /D=<state>\qemu` → 校验 `qemu-system-x86_64.exe` → 清 tmp | 不碰系统目录、不写 PATH、卸载即删目录；winget/scoop/choco 需要机器级落点，降级为 `--machine` 显式参数 |
| `/D=` 约束 | argv 严格 `[installer, "/S", "/D=<target>"]`，**`/D=` 必须是最后一个参数**（NSIS 规则，其后的参数被忽略）；目标路径含空格时**直接拒绝**并提示改用无空格路径或 `--machine` | NSIS 对带引号 `/D=` 的兼容性在不同 shell/quoting 层不可靠，"宁可早失败也不中途诡异失败"；代价：项目路径带空格（如 `C:\My Projects\...`）无法便携安装 |
| 发现优先级 | 环境候选（PATH/scoop/winget/choco/Program Files）在前，`<state-dir>/qemu` **追加在最后**（`discover_qemu_bin_with`） | 尊重操作者显式装的机器级 QEMU（若已存在，`setup qemu` 直接判定"已安装"并跳过，不会白下载 1 GB）；干净机器上便携版是唯一候选，自然被选中。代价：同时存在两份时便携版不会自动优先 |
| WHPX | **不便携化**，如实声明为唯一例外 | `HypervisorPlatform` 是 Windows 可选功能，只能系统层 DISM 启用 + 重启生效，没有用户态等价物 |
| state_dir 线程化 | `discover_qemu_bin_with` / `discover_qemu_img_with` / `candidate_qemu_dirs_with` 覆盖全部调用点：`doctor`（qemu-binary、qemu-img 检查）、`setup::precheck`、`vm create`（qemu-img）、`vm start`、`vm snapshot`、`vm clone`、`verify`（第 1、7 项）；旧 `discover_qemu_bin()` 保留为 `with(None)` 的向后兼容别名 | 便携安装后所有命令必须能找到它；`find_qemu_img_in` 在便携布局下同样重要的是 qemu-img 不在 PATH 上 |
| 提权子进程的 state-dir | `setup whpx` 把 `--state-dir` 透传给 `__elevated` 子进程（本轮顺带修复的既有缺陷） | 之前子进程固定用 `%APPDATA%` 写 marker，父进程在自定义 state-dir 下永远读不到 → 误报"UAC declined?"；RDC 桥接改为始终传 `--state-dir` 后该缺陷必然暴露 |

### 诚实边界（本轮新增）

- ✅ 纯函数已测：`nsis_portable_command`（`/D=` 末位）、`validate_portable_target`（空格拒绝）、`parse_weilnetz_listing`（目录页解析）、`portable_qemu_plan`、`candidate_qemu_dirs_with`（追加顺序/去重）、`default_portable_state_dir` / `args_with_portable_state_dir`（桥接钉路径）。
- ⚠️ 运行时未验证：目录页实际 HTML 结构（解析器按"名字模式任意位置 + 数字日期最大者"设计，对 href/链接文本/引号风格不敏感，但没有真实的本次抓取做端到端验证）；NSIS `/S /D=` 在真实机器上的静默安装行为；安装器清单是否要求 UAC（可能弹一次，产物仍只落项目内）。
- ⚠️ 若上游把安装器改名（非 `qemu-w64-setup-<8+位数字>.exe`），解析返回 `None` 并以清晰错误提示改用 `--machine` 或手工安装 —— 不猜测、不静默降级。

### 诚实边界（WHPX 卡死修复 + 串口日志）

- ✅ 纯函数已测（新增 6 例，见 `vm::tests`）：WHPX 变体 `-cpu` 存在且恰为 `max,-svm,-vmx`；**TCG 变体必须没有 `-cpu`、也不含 `svm`/`vmx` 字样**（防掩码误伤）；两种加速器都带 `-serial file:C:/qc/vms/node1/console.log` 且 `-display none` / `-qmp` 保持不变；无 seed.img 时串口仍在；`console_log_path` / `vm_console_log_path` 的派生（含裸文件名不 panic）；Windows 反斜杠盘路径渲染成 `/` 分隔。
- ⚠️ 运行时未验证（但**有真机旁证**）：本 CLI 自己拉起的 `vm start` 尚未在真机复跑。修复的真机证据来自 AutoCoder 手工拉起的、参数与本 CLI 现在的 argv 等价的 QEMU（`-cpu max,-svm,-vmx` 唯一变量：`Unexpected VP exit code 4` 计数满屏 → 0，guest 正常启动到 `boot_completed=1`）。掩码本身**不改变 guest 可见 CPU 的其余特性集**这一点只在 `max` 语义上成立，未逐位对比过 `-cpu max` 与默认模型。
- ⚠️ `-serial file:` 的实际写盘行为（QEMU 打开 chardev 时是覆盖还是追加、文件何时 flush）未在本环境验证；按"保留最近一次启动的日志"使用，跨启动历史不保证累积。
- ⚠️ 路径分隔符：`-serial` 的值走 `qemu_path_arg` 统一成 `/`（Windows 文件 API 与 QEMU 选项解析都接受）；`-drive file=` 的盘路径保持原样渲染（那是在真机上已验证可用的形态，本轮刻意不改）。
