# qemu-center

**独立 QEMU/WHPX 轨道**：一台 VM = 一个"节点"，节点内跑 Docker + redroid（与主仓库 Docker 方案同镜像），一个节点承载 N 个 redroid 容器。宿主 adb/scrcpy 通过 QEMU user-mode 端口转发无感连接。

> **本项目是 `Android-Device` 仓库的纯增量子目录**：不修改任何既有文件，不参与根 workspace，独立 crate。验证命令只有 `cargo test --manifest-path qemu-center/Cargo.toml`（**切勿**在仓库根跑 cargo，也**切勿**在根创建 Cargo.toml/workspace——根 workspace 会影响 `src-tauri` 构建）。

---

## 1. 架构定位

```
Windows 宿主 (WHPX 硬件加速)
│  adb / scrcpy
│  ▲ 127.0.0.1:<port>   ← 端口号在宿主和 guest 内完全相同
│  │
│  └─ QEMU (qemu-system-x86_64, -accel whpx, q35, 无显示)
│      user-mode 网络: hostfwd tcp::22300-:22, tcp::24500-:24500, ...
│      virtio-blk: disk.qcow2 (overlay, backing = Ubuntu cloud image)
│      virtio-blk: seed.img (自写零依赖 FAT16: 卷标 CIDATA + LFN 小写文件名, cloud-init NoCloud)
│      │
│      └─ guest: Ubuntu 22.04/24.04 cloud image
│          ├─ binder_linux（linux-modules-extra 安装 + modules-load.d 开机自加载，cloud-init 自动完成）
│          ├─ Docker (docker.io，daemon 走宿主代理 drop-in)
│          └─ N × redroid 容器 (qc-<name>), 各自 -p 0.0.0.0:<port>:5555
```

**取舍（重要，如实写明）：内核隔离是"节点级"而不是"实例级"。** 同一台 VM 里的 N 个 redroid 容器共享同一个 guest 内核，因此：
- 实例之间**没有**内核级隔离（只有 Docker 的 namespace/cgroup 隔离）；
- 需要真内核隔离的场景，请一个实例一台 VM（`vm create` 成本很低：qcow2 overlay + 克隆都是秒级）；
- 这与主仓库 Docker 方案在同一宿主内核上跑多容器的取舍本质相同，只是把内核边界上移了一层。

adb 连接路径：容器 publish 到 guest 的 `<port>:5555` → QEMU slirp `hostfwd tcp::<port>-:<port>` → 宿主 `adb connect 127.0.0.1:<port>`。宿主侧不需要任何特殊配置。

## 2. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| WHPX | Windows 可选功能 `HypervisorPlatform` = Enabled（用户能跑 WSL2 即有 Hyper-V 平台）。**便携化唯一例外**：这是 Windows 系统功能，只能启用在系统层，无法装进项目目录 | `qemu-center doctor` |
| QEMU | `qemu-system-x86_64` + `qemu-img`。`setup qemu` 默认**便携安装进项目**（`<state-dir>/qemu`），`--machine` 才走 winget/scoop/choco 装到机器 | `qemu-center doctor` |
| OpenSSH 客户端 | `ssh.exe` / `ssh-keygen.exe`（Windows 可选功能） | `qemu-center doctor` |
| adb | platform-tools（验证第 6 项需要） | `qemu-center doctor` |
| 空闲磁盘 | ≥ 40 GiB（一个 40 GiB 虚拟盘 + cloud image） | `qemu-center doctor` |
| Ubuntu cloud image | 自行下载一次，作为所有节点磁盘的只读 backing 文件 | 见下 |

**启用 WHPX（管理员 PowerShell，需重启）——或直接 `qemu-center setup all` 自动完成：**

```powershell
DISM /Online /Enable-Feature /All /FeatureName:HypervisorPlatform
# 或：Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
```

**下载 Ubuntu cloud image（占位地址，取当前 LTS 版本）：**

```text
https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img
```

> 该地址为**占位**：请以上游 `cloud-images.ubuntu.com` 当前页面为准。cloud image 是 qcow2 格式，天然适合做 overlay 的 backing file。

## 3. 快速开始

### 3.0 一键安装（推荐）

```bash
# 全自动：下载 cloud image（免提权）→ 便携安装 QEMU 到项目内 → 启用 WHPX（UAC 一次）
# 唯一需要人工的：WHPX 的 UAC 弹窗点「是」×1、WHPX 启用后重启一次（Windows 强制，无法代劳）
cargo run --manifest-path qemu-center/Cargo.toml -- setup all

# 也可以分步：
# qemu-center setup image [--distro jammy|noble]   # 免提权，SHA256 校验，落 <state-dir>/images
# qemu-center setup qemu                            # 默认便携安装到 <state-dir>/qemu（不碰系统目录）
# qemu-center setup qemu --machine                  # 机器级安装（winget → scoop → choco → NSIS，UAC 一次）
# qemu-center setup whpx                            # 自我提权跑 DISM，绝不自动重启
```

`setup` 全部幂等：已就绪的步骤自动跳过，重复执行无害。`vm create` 在缺前置时默认打印缺项与对应 setup 命令后退出（exit 3），加 `--auto-setup` 则自动修复后再继续。

### 3.1 建轨验收

```bash
# 0) 环境体检（现在就能跑，不需要 VM）
cargo run --manifest-path qemu-center/Cargo.toml -- doctor
cargo run --manifest-path qemu-center/Cargo.toml -- doctor --json

# 1) 创建节点（默认 4 vCPU / 4 GiB / 40 GiB 盘 / 32 个 adb 端口块）
cargo run --manifest-path qemu-center/Cargo.toml -- vm create node1 \
  --image <state-dir>/images/noble-server-cloudimg-amd64.img

# 2) 启动（Windows 下 detached spawn，无控制台窗口）+ 等 SSH
cargo run --manifest-path qemu-center/Cargo.toml -- vm start node1
cargo run --manifest-path qemu-center/Cargo.toml -- guest wait node1 --timeout-secs 600

# 3) 节点内建一个 redroid 实例（自动从端口块里分配端口）
cargo run --manifest-path qemu-center/Cargo.toml -- redroid create node1 r1

# 4) adb 映射 + 验收
cargo run --manifest-path qemu-center/Cargo.toml -- adb map node1
cargo run --manifest-path qemu-center/Cargo.toml -- verify --vm node1
```

首次启动会由 cloud-init 自动完成：建 `rdc` 用户并注入节点专属公钥、关闭密码登录、安装 docker.io、redroid 内核准备（装 `linux-modules-extra` + binder_linux 开机自加载等，详见第 5 节「guest 置备四点真机修复」）、docker daemon 走宿主代理。**首启需要几分钟**（cloud image 首启 + apt 安装，modules-extra 下载约 100 MB）。

常用命令：

```bash
qemu-center vm list [--json]
qemu-center vm stop node1                 # QMP ACPI 优雅关机
qemu-center vm snapshot node1 clean-1     # qcow2 内部快照（建议先停 VM）
qemu-center vm clone node1 node2          # backing file 秒级克隆（新端口块）
qemu-center vm delete node1 [--purge]
qemu-center guest provision node1         # 首启失败时的补救（补 modules-extra/binder 自加载/补 docker 与代理，与 runcmd 同一套步骤）
qemu-center redroid list node1            # 含 guest 内实时容器状态
qemu-center redroid start|stop node1 r1
qemu-center adb list [--json]
```

### 3.2 RDC 应用内使用（已接入）

主仓库 RDC 桌面应用已把本 CLI 接入应用内（实验性）：**左侧导航「QEMU 节点」（`#/qemu`）**，用户点击即可完成建轨全流程，不再需要敲命令行。接线方式是子进程调用本 CLI（RDC 侧桥接见 `src-tauri/src/services/qemu.rs`），本 crate 的代码与测试不受影响。

**UI 按钮 → CLI 命令映射：**

| 界面操作 | 对应 CLI 命令 |
|---|---|
| 进入页面自动「环境体检」 | `doctor --json`（逐项 ok/fail/unknown 徽标 + fix 提示） |
| [一键安装环境] | `setup all --distro noble`，结束后自动重跑 doctor |
| [启用 WHPX] / [安装 QEMU] / [下载镜像] | `setup whpx` / `setup qemu`（默认便携进项目）/ `setup image --distro noble` |
| [创建节点] 表单 | `vm create <name> --image <默认镜像> … [--auto-setup]`（imagePath 留空时 RDC 自动解析 `<repo>/qemu-center/state/images/` 下的 noble 镜像） |
| 创建成功后自动等待 | `guest wait <name>`（RDC 侧按 15s 分片轮询，可随时取消等待；VM 继续在后台启动） |
| 行内 [启动] [停止] | `vm start/stop <name>`（停止 = QMP ACPI 优雅关机） |
| 行内 [删除] | `vm delete <name> --purge`（确认对话框后执行，磁盘/密钥一并删除） |
| 行内 [验收] / 验收卡 [运行验收] | `verify --json --vm <name>`（七项 PASS/FAIL/UNTESTED 徽标；UNTESTED 如实显示"本机无法判定"，不是失败） |
| [创建实例] 表单 | `redroid create <vm> <name> --cpus --memory --width --height --dpi`，成功后展示 `127.0.0.1:<port>` serial 并可一键复制 |
| 节点卡选中节点 | `redroid list <vm> --json`（实例表：容器/端口/serial/guest 内实时状态） |

页面底部的可折叠「命令日志」面板会把每次按钮触发的 CLI 输出按行追加，等价于在终端里看到的内容。

**UAC / 重启预期（与命令行完全一致，由 Windows 决定，应用无法代劳）：**
- `setup qemu`（默认便携）：文件只写入项目内目录；NSIS 安装器清单可能仍请求一次 UAC（点是即可），但产物不落 `C:\Program Files`；
- `setup whpx`（或 `setup all` 内含的 WHPX 步骤）：DISM 自我提权，**一次 UAC**，启用成功后 **必须重启 Windows** 才生效——重启后回到 QEMU 节点页点「重新体检」应全绿；
- `setup image`：免提权，下载约 600 MiB 的 cloud image 并做 SHA256 校验，期间按钮显示加载态；
- 其余命令（vm/redroid/guest/verify）不弹任何系统对话框。

**二进制发现顺序**（RDC 侧 `resolve_qemu_center_bin`）：环境变量 `QEMU_CENTER_BIN` → 仓库内 `qemu-center/target/{debug,release}/qemu-center.exe` → PATH（`where qemu-center`）。开发期先 `cargo build --manifest-path qemu-center/Cargo.toml` 即可被应用找到。

Settings 页「默认运行轨道」下拉可记录 docker|qemu 偏好（`default_track` 字段）；在 QEMU verify 七项全绿之前，QEMU 页面顶部会保持「实验性」提示，所有功能默认仍走 Docker 轨道。

## 4. 阶段 0 通过标准（`qemu-center verify`）

`verify` 是**设计给用户在真机运行**的验收报告。逐项 PASS/FAIL/UNTESTED，`UNTESTED` 表示本机跑不了（VM 未启动/工具缺失），**不等于失败**。

| # | 判据 | 检测方式 | 判定 |
|---|---|---|---|
| 1 | WHPX 可用 | `qemu-system-x86_64 -accel whpx -machine q35 -display none -S`（8 秒超时） | 超时被杀（进程一直活着）或退出码 0 ⇒ PASS；stderr 含 `whpx` 报错 ⇒ FAIL |
| 2 | guest SSH 可达 | `ssh -p <port> -i <key> rdc@127.0.0.1 "echo __QC_SSH_OK__"` | 回显 marker ⇒ PASS |
| 3 | binderfs 挂载 | `ssh … cat /proc/filesystems` | 存在 `binder`/`binderfs` 词元 ⇒ PASS |
| 4 | guest 内 docker 可用 | `ssh … docker version --format '{{.Server.Version}}'` | 非空且非 "Cannot connect" ⇒ PASS |
| 5 | redroid 容器已启动完成 | `ssh … docker exec qc-<r1> getprop sys.boot_completed` | 输出恰为 `1` ⇒ PASS；`0`/空 ⇒ UNTESTED（仍在启动）；exec 失败 ⇒ FAIL |
| 6 | 宿主 adb 可连 | `adb connect 127.0.0.1:<port>` + `adb -s … shell getprop ro.build.version.release` | 输出含 `connected to` 且 getprop 非空 ⇒ PASS |
| 7 | 快照/克隆耗时 | `qemu-img snapshot -c` + `qemu-img create -b` | 两条命令均成功 ⇒ PASS，耗时记入明细（**信息项**） |

退出码：全 PASS = 0；有 FAIL = 1；仅 UNTESTED = 3（便于脚本区分"没跑"和"失败"）。

## 5. 诚实边界（运行时未验证）

本环境**无法运行 QEMU/WHPX**，因此如实区分三档：

| 档位 | 内容 |
|---|---|
| ✅ **纯函数已测**（162 个单测，`cargo test` 全绿） | ISO9660 生成/回读（含 CD001 标识、扇区数、确定性、回读内容一致；**已退役为库 API/测试资产**，见下方 seed 载体条目）、**FAT16 seed 镜像生成器**（BPB 字段断言、测试内解析器走 BPB→根目录→FAT 链全链路逐字节回读、LFN checksum 独立实现对拍、空文件表仅卷标条目、300 KiB 多簇链、确定性 + FAT2 副本一致、8.3 短名截断/非法字符/冲突回退、LFN 上限与根目录容量守卫、cloud-init 渲染结果过 FAT 载体回读）、cloud-init YAML 渲染与确定性（ISO 版 `seed_files` 与镜像版 `seed_image_files` 内容一致性、文件名小写逐字保留）、QEMU/qemu-img 参数拼装快照（含 seed.img virtio read-only 盘）、hostfwd 串、端口块分配唯一性、state.json 读写回环、redroid docker run 参数同构、各类输出判定（WHPX 探测/features/fsutil/readiness/boot_completed/adb connect）、便携化参数与解析（NSIS `/S /D=` 末位、空格目标拒绝、weilnetz 目录页解析、便携 state dir 派生、doctor 便携候选） |
| ⚠️ **命令拼装已测，运行时未验证** | `vm start`（QEMU 实际拉起）、`vm stop`（QMP 握手）、`guest wait/provision`（SSH 实连）、`redroid create`（guest 内 docker run）、`vm snapshot/clone`（qemu-img 实际执行）、`adb map` 实测连通 |
| 🔬 **需用户真机运行** | `doctor`（本机已实跑一次，见下）、`verify` 七项、整条 `vm create → guest wait → redroid create → adb map` 链路、cloud-init 首启是否与应用内 binderfs 准备完全一致。**seed 载体链路已在真机手工全链路验证**（见下方 seed 载体条目）：用户在 node1 上用手工生成的同规格 seed.img 跑通 `cloud-init status=done` / Docker 29.1.3 active / SSH 公钥认证；用 CLI 重建节点后应按 verify 第 2/4 项复验一致 |

`doctor` 在本开发机上已实际跑过一次（真实输出：WHPX 功能 Disabled、QEMU 未安装、磁盘 90.3 GiB 充足、ssh/adb 已找到）——这同时暴露并修复了一个真实格式差异：新版 Windows 的 `fsutil volume diskfree` 把原始字节数放在括号**外**（`96,967,008,256 ( 90.3 GB)`），旧版放在括号**内**；解析器现已兼容两种格式并对本地化输出做回退。

其他已知边界：
- **seed 载体演进：自写 ISO → QEMU VVFAT → 自写 FAT16（前两步均被真机证伪，第三步真机全链路跑通）**：
  1. **自写 ISO9660**（证伪）：按标准把目录记录里的文件名存成大写（`USER-DATA.;1`）。此前赌"Linux 内核 iso9660 默认 `map=normal` 会小写化并去掉 `.;1`"——已在用户真机（node1：Ubuntu noble cloud image + QEMU 11.1 + WHPX）证伪：PVD 卷标 `CIDATA` 正确、SSH 端口也通，但 guest 的 cloud-init NoCloud 找不到小写 `user-data`，种子被整体忽略（表现为公钥认证被拒）。
  2. **QEMU 原生 VVFAT**（`-drive file=fat:<dir>`，证伪）：文件名小写没问题，但 **vvfat 的卷标固定为 `QEMU VVFAT`，不可配置**。cloud-init NoCloud 的 `ds-identify` 在 init-local 阶段用 blkid 扫 `LABEL=cidata` 的块设备（vfat/iso9660），卷标不匹配 → 数据源判定失败 → **cloud-init 完全不激活**（真机 console 实证：零 cloud-init 日志 + `systemd-networkd-wait-online` 卡死）。
  3. **自写零依赖 FAT16**（`src/fat.rs`，现行方案，真机验证通过）：64 MiB 裸 FAT16 卷（无分区表，blkid 直接读 BPB 卷标）、卷标 `CIDATA`、LFN 长文件名目录项存小写 `user-data`/`meta-data`/`network-config`，以普通 virtio 硬盘挂载（`-drive file=<seed.img>,if=virtio,format=raw,read-only=on`）。用户已在真机用手工生成的同规格 seed.img 跑通全链路：**`cloud-init status=done`、Docker 29.1.3 active、SSH 公钥认证通过**。`src/iso.rs` 与 `cloudinit::seed_files` 保留为库 API 与测试资产。
- **guest 置备四点真机修复（node1 验收 7/7 PASS 后回写进 cloud-init 模板，新节点不再重踩）**：
  1. **Ubuntu cloud image 不带 `linux-modules-extra-<kernel>`** → `binder_linux` 模块缺失、modprobe 失败。runcmd 首步 `apt-get install -y linux-modules-extra-$(uname -r) || true`（约 100 MB，apt 可直连；`|| true` 兜底——apt 失败不阻塞置备，binder 真实状态由 verify 第 3 项如实报告）。
  2. **旧模板往 /etc/fstab 追加 binder 挂载项**：模块缺失时重启后 fstab 挂载失败 → **emergency mode 卡死整次 boot**（真机实证）。该行已彻底移除，且断言 `!contains("/etc/fstab")` 防回归；binderfs 由 redroid 容器自挂载，宿主不挂。
  3. **binder_linux 开机自动加载**：`/etc/modules-load.d/binder.conf`（不带参数的默认加载）+ 本次 boot 的 `modprobe binder_linux devices="binder,hwbinder,vndbinder"`。
  4. **guest 内 docker 走宿主代理**（用户网络环境 docker pull 被墙）：systemd drop-in 写 `HTTP_PROXY/HTTPS_PROXY=http://10.0.2.2:10808`、`NO_PROXY=localhost,127.0.0.1`。QEMU user-net 网关固定 `10.0.2.2`（即宿主）；`10808` 是用户 v2rayN mixed 端口——**端口不同就改 `src/cloudinit.rs` 的 `GUEST_DOCKER_PROXY` 常量后重编**（个人工具，刻意不做运行时配置）。drop-in 用逐行 printf 写入（heredoc 转义在 runcmd 里会坏，真机验证过）。
- **已用旧版（坏 ISO / VVFAT）创建的节点不会自动迁移**：无 seed.img 的 VM 在 `vm start` 时照常无 seed 启动（与现状一致）。要获得正确 seed，删除重建即可：`vm delete node1 --purge && vm create node1 …`。
- **快照/克隆与运行中的 VM**：qcow2 内部快照要求 VM 已停止（或在 guest 内 quiesce）。CLI 不强制拦截，README 明示风险。
- **端口块在 VM 启动时固定**：slirp 的 hostfwd 无法在启动后追加（除非走 QMP），所以 `vm create` 时一次性预留 `--adb-port-count`（默认 32）个转发；块耗尽需新建/克隆节点。
- **state.json 无跨进程锁**：写入用 temp+rename 原子替换，但两个并发的 `qemu-center` 进程可能互相覆盖。单操作者 CLI 场景可接受，属已知局限。
- **不碰主仓库**：本 crate 不 import `src-tauri` 任何代码；redroid 参数是按 redroid 官方文档语义**独立重写**的（见 `src/redroid.rs` 模块注释）。

## 6. 目录与端口约定

### 6.1 便携化：所有产物收进项目内一个根

`--state-dir` 解析顺序：CLI 显式参数 > 环境变量 `QEMU_CENTER_STATE_DIR` > `%APPDATA%\QemuCenter`（Linux/macOS: `~/.config/QemuCenter`）。**RDC 应用内的每次调用都由桥接层显式传 `--state-dir <repo>/qemu-center/state`**（见 `src-tauri/src/services/qemu.rs` 的 `default_portable_state_dir`），命令行上也可以用环境变量达到同样效果：

```powershell
$env:QEMU_CENTER_STATE_DIR = "F:\code\project\Android-Device\qemu-center\state"
```

`setup qemu` 默认把 QEMU 本体也装进同一个根（`state\qemu`），因此状态、镜像、磁盘、QEMU 全部在项目内，卸载 = 删目录；不写注册表 PATH、不占 `C:\Program Files`（`--machine` 显式参数才走机器级 winget/scoop/choco/NSIS 通道）：

```
<state-dir>/                      # RDC 桥接固定指向 <repo>/qemu-center/state
  state.json                      # 注册表（serde，原子写）
  keys/node1_ed25519[.pub]        # 节点专属登录密钥
  vms/node1/
    disk.qcow2                    # overlay，backing = cloud image
    seed.img                      # 自写 FAT16 seed 镜像（卷标 CIDATA + LFN 小写文件名，只读 virtio 盘）
    known_hosts                   # 每节点独立的 ssh known_hosts
  images/
    noble-server-cloudimg-amd64.img
    SHA256SUMS-noble
  qemu/                           # 便携 QEMU 本体（setup qemu 默认落点）
    qemu-system-x86_64.exe
    qemu-img.exe
  tmp/                            # 安装器/下载临时目录（装完自动清理）
```

**WHPX 例外（如实声明）**：`HypervisorPlatform` 是 Windows 系统功能，只能通过 DISM/「启用或关闭 Windows 功能」装在系统层并重启一次生效，无法便携化——这是整条轨道里唯一一件必须落在项目外的东西。`setup whpx` 依然负责自动化它。

**QEMU 二进制发现优先级**（`doctor::discover_qemu_bin_with`）：PATH 等环境候选在前，`<state-dir>/qemu` 作为**最后一个**候选追加。含义：已经装过机器级 QEMU 的机器上，doctor/vm start 会继续用机器级那份（操作者显式安装优先）；干净机器上则自动发现项目内便携版。若想让便携版绝对优先，卸载机器级 QEMU 即可。

### 6.2 端口约定

端口约定（**刻意避开主仓库 Docker 轨道的 5555–6000**）：

| 用途 | 默认基址 | 说明 |
|---|---|---|
| SSH hostfwd | 22300+ | guest :22 |
| QMP | 23300+ | `vm stop` 用 |
| ADB 块 | 24500+ | 连续 N 个；宿主端口 == guest 端口 == adb serial 端口 |
| 保留（禁用） | 5555–6000 | 主仓库 `suggest_free_adb_port` 的范围 |

## 7. 开发

```bash
cargo test --manifest-path qemu-center/Cargo.toml      # 162 个用例
cargo run  --manifest-path qemu-center/Cargo.toml -- doctor
cargo run  --manifest-path qemu-center/Cargo.toml -- setup all
```

依赖红线：仅 `serde` / `serde_json` / `clap` / `dirs`。ISO 生成器、FAT16 seed 镜像生成器、cloud-init 渲染、参数拼装、输出解析全部自写、零额外依赖。

RDC 应用内接入已启动（见上文 3.2 节）；适配设计沿革见 [`docs/architecture.md`](docs/architecture.md)。本 crate 仍不依赖 RDC 代码，反向走 CLI 子进程 + `--json` 契约。
