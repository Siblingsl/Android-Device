# Redroid 红队对抗环境方案：Magisk / LSPosed / Shamiko / 设备伪装

> **状态：已实现，并已在真机（本机 Docker + WSL2 binder 内核）端到端验证通过（2026-09-04）。**
> 实测链路：fetch 资产 → `rdc-preset` 镜像构建 → 容器首启（magiskd 30.6 启动、Zygisk=1、
> LSPosed 1.9.2 + Shamiko 1.2.5 经 util_functions 路径完整安装）→ 激活重启 → 模块 bind-mount
> 挂载、`zygiskd64` 启动、LSPosedService 运行 → resetprop 伪装生效（model/device/fingerprint/
> qemu 全部覆盖）。**关键前提：容器必须挂载数据卷（`-v rdc-*-data:/data`）**——`check_data()`
> 要求 /data 是非 tmpfs 挂载，否则 post-fs-data 整个被静默跳过（应用创建流程本来就挂卷）。
>
> 踩过的坑（均已修复并留档）：
> 1. Magisk v30 fork 是单一 `magisk` 二进制（无 magisk64/32）；`--setup-sbin` 必须带双参数
>    `--setup-sbin <system目录> /sbin`，缺参会死循环卡死 init（表现为 adb offline、boot 永不完成）。
> 2. Android 的 sh 是 mksh：参数展开模式里裸 `|` 是"空交替"，`${line%%|*}` 会把整行删空——
>    spoof 解析必须写 `${line%%"|"*}`。
> 3. 模块安装走 Magisk App 同款路径（busybox + util_functions install_module），
>    `--install-module` 在该 fork 上会假成功（只写 module.prop 壳）；需先填充
>    `/data/adb/magisk/{magisk,magiskpolicy,busybox,util_functions.sh}` 并由 collect_modules
>    在下次 post-fs-data 把 `modules_update` 搬运并挂载（应用的"激活重启"正是这一步）。
> 4. SELinux 在 redroid 容器里是 Disabled：magiskpolicy `--live` 会因读不到
>    /sys/fs/selinux/policy 而崩，无害；adbd 每次重启回退 shell 用户，root 检测前需 `adb root`。
> 5. 该 fork 会主动卸载 Magisk App（pm_uninstall com.topjohnwu.magisk）——红队场景反而是
>    优点（管理器不可见）；需要管理界面时手动 `pm install /system/etc/init/magisk/magisk.apk`。
> 6. LSPosed 的 "Unable to open daemon.dm" 警告在容器内无害，服务端正常启动。

> 适用范围：Redroid Device Center 对**授权内部 App** 进行红蓝对抗测试（检测绕过评估）。
> 所有预装物均放 `vendor/`（已 gitignore），不进 Git、不进发布包。

---

## 一、项目现状与可行性结论

本项目是 Tauri 2 + React 桌面端，底层通过 Docker 运行 Redroid（Android-in-Docker），ADB/scrcpy 控制。

对 Root 接入有利的三个既有事实：

| 现状 | 位置 | 对本方案的意义 |
|---|---|---|
| 定制镜像管线：`FROM base + COPY overlay/ /system/` | `src-tauri/src/services/docker.rs` `ensure_gapps_image()` | Magisk 预装直接复用同一条管线，扩展为通用 Preset 镜像 |
| 容器以 `--privileged` 创建、容器内默认 root | `docker.rs` `create_container()` | 无需解锁/刷机，Magisk 二进制可直接落盘运行 |
| 自定义 binder 内核编译脚本已具备 | `scripts/setup-wsl-binder-oneclick.ps1` 等 | 内核级方案（KernelSU）可作为备选，但见 1.1 的取舍 |

### 1.1 容器内 Magisk vs 内核级 KernelSU（取舍）

| | 容器内 Magisk（推荐） | KernelSU（内核层） |
|---|---|---|
| 安装方式 | 改 Redroid 镜像（复用现有管线） | 编进 WSL2 binder 内核 |
| Zygisk / LSPosed | ✅ 官方支持路径 | ❌ 需另接 Zygisk Next |
| 每容器独立开关/隐藏策略 | ✅（`/data/adb` 按容器隔离） | ❌ 内核是宿主共享的，所有容器同时生效 |
| 与现有 UI 集成成本 | 低（只是多几种 overlay） | 高（碰内核脚本链） |

结论：**容器内 Magisk**。KernelSU 不采用（多容器隔离是本产品核心场景）。

---

## 二、总体架构

```
创建实例（Docker 页新增勾选项）
  ├─ 预装 GApps（现有）
  ├─ 预装 Magisk + Zygisk           ← 新增
  ├─ 预装 LSPosed (Zygisk 模块)      ← 新增
  ├─ 预装 Shamiko                    ← 新增
  └─ 应用设备伪装配置 (ro.product.* 等) ← 新增，spoof.conf 驱动
        │
        ▼
ensure_preset_image()                 ← docker.rs，GApps 管线泛化
  FROM redroid/redroid:13.0.0
  COPY gapps_overlay/  /system/       （可选）
  COPY magisk_overlay/ /system/       （Magisk 二进制 + init rc + boot 脚本）
        │
        ▼
docker run --privileged -v rdc-*-data:/data ...   （现有，不变）
        │
        ▼
容器内首启（overlay 脚本驱动，ADB 可用后自动完成）
  1. magiskd 启动、SELinux 策略注入
  2. 开启 Zygisk，--install-module 安装 LSPosed / Shamiko
  3. 写入 /data/adb/spoof.conf 并 resetprop 生效
```

关键设计：**一切伪装数据放在数据卷 `/data/adb/` 下**。删容器不删卷（项目现有约定），同一设备重开容器伪装与模块状态不丢；换"身份"只需改 spoof.conf 重启，不动镜像。

---

## 三、镜像层：Magisk 预装

### 3.1 需要的产物（`vendor/magisk/`，gitignore，脚本下载）

新增 `scripts/fetch-magisk.ps1`（对齐 `fetch-mindthegapps.ps1` 的风格）：

- 从 Magisk GitHub Releases 下载 stable 版 apk（zip 格式），解出：
  - `lib/x86_64/libmagisk64.so` → `magisk64`
  - `lib/x86_64/libmagisk32.so` → `magisk32`（13 镜像 64-only 时可省）
  - `lib/x86_64/libmagiskboot.so`、`lib/x86_64/libmagiskpolicy.so`
  - `assets/util_functions.sh`、`assets/stub.xz`
- LSPosed（Zygisk 版）zip、Shamiko zip → `vendor/magisk/modules/`
- 版本锁定写入 `scripts/platform-assets.json`，保证镜像可复现。

### 3.2 overlay 结构（打进镜像 `/system/`）

```
magisk_overlay/
├── etc/init/magiskd.rc                    # init service 声明
├── bin/magisk*                            # 上述二进制
└── bin/magisk_preset.sh                   # 首启引导脚本
```

`magiskd.rc` 要点：

```rc
on post-fs-data
    exec u:r:magisk:s0 root root -- /system/bin/magisk_preset.sh
service magiskd /system/bin/magisk64 --daemon
    user root
    seclabel u:r:magisk:s0
    oneshot
```

`magisk_preset.sh` 要点（首启一次，之后由 magiskd 自管理）：

1. 布局 `/data/adb/magisk/`（bin、`magisk.db`）、`/data/adb/modules/`
2. `magiskpolicy --live --magisk "* *"`（Redroid 的 SELinux 为简化态，策略注入保证 magisk domain 可用）
3. Zygisk 开关写入 `magisk.db`：`magisk --sqlite "REPLACE INTO settings (key,value) VALUES('zygisk',1)"`
4. 首次启动安装模块：
   `magisk --install-module /data/local/tmp/lsposed.zip`、`shamiko.zip`
   （模块 zip 由客户端通过 ADB push 进 `/data/local/tmp`，装完删除）
5. 执行伪装：见第四节。
6. 打 `magisk.apk`（stub）为系统包，供 Magisk App 图标/管理。

> 版本兼容注意：LSPosed（Zygisk）官方维护已停更（最后支持 Android 13），与本项目默认镜像 `redroid/redroid:13.0.0-latest` 匹配；Shamiko 用与 Magisk 版本匹配的 release。版本矩阵记录在本文件第五节。

---

## 四、运行时层：ro.product.* 伪装与模拟器隐藏

### 4.1 伪装驱动：`/data/adb/spoof.conf`

`magisk_preset.sh`（或独立模块 service.sh）逐行解析执行 resetprop：

```ini
# ro.product 系列（Android 11+ 需同时覆盖分区级前缀）
ro.product.brand=Xiaomi
ro.product.manufacturer=Xiaomi
ro.product.model=2210132C
ro.product.device=alioth
ro.product.name=alioth_cn
ro.product.marketname=Redmi K40
ro.product.brand_+=...        # 程序生成：对 brand/device/model/name/manufacturer
                               # 同时写 ro.product.{vendor,system,product,systemext,odm}.*
# 指纹与描述
ro.build.fingerprint=Xiaomi/alioth/alioth:13/TKQ1.220829.002/V14.0.6.0.TKHCNXM:user/release-keys
ro.build.description=...       # 与 fingerprint 一致
ro.build.display.id=...
ro.build.version.incremental=...
ro.build.tags=release-keys
ro.build.type=user
# 反模拟器关键 props
ro.kernel.qemu=0               # 或 --delete
ro.boot.qemu=0
ro.bootmode=unknown
ro.hardware=qcom
ro.boot.hardware=qcom
ro.hardware.audio.primary=qcom
ro.boot.bootdevice=7c4000.ufshc
ro.boot.bootreason=reboot
gsm.sim.state=READY
gsm.version.baseband=1.0.c6-00323-...
```

实现原则：

- 用 Magisk `resetprop`（运行时覆盖，`getprop`/`SystemProperties.get` 全部读到假值）而不是改 build.prop 文件——因为 Android 11+ 的 `ro.product.*` 拆分在 system/vendor/product 等多个分区文件里，overlay 覆盖易漏、易被增量签名校验卡住。
- 每次容器冷启动由脚本重放（resetprop 值不持久，重启即失，正好保证幂等）。
- 支持多套 profile（`spoof.conf` 可按实例生成），客户端后续可在 UI 里做"机型档案库"。

### 4.2 Redroid 特有的检测面与对策清单

Redroid 不是 QEMU 模拟器（x86_64 镜像原生跑），检测面与传统模拟器不同：

| 检测点 | Redroid 现状 | 对策 |
|---|---|---|
| `ro.product.*` / fingerprint | redroid 通用指纹（aosp_*） | 4.1 resetprop |
| `ro.kernel.qemu` 等 qemu props | 部分存在 | resetprop --delete / 置 0 |
| CPU 架构 `ro.product.cpu.abi` | x86_64 | 若目标 App 校验 arm：改用 arm64 镜像 + libndk/houdini（注意翻译层本身就是可检测点）；否则 x86_64 直接伪装成"x86 平板/模拟器白名单外"机型需要 App 侧确认 |
| Telephony / IMEI | 无基带，IMEI 为空 | LSPosed 模块 hook `TelephonyManager`（如"模拟器伪装"类模块），或接受此面不达标并记录 |
| 传感器（加速度计等） | 红米/虚拟传感器缺失或缺帧 | LSPosed 模块伪造 SensorManager |
| `pm list packages` 可见 Magisk 包 | 存在 | Shamiko denylist + Hide My Applist 隐藏 |
| su / magisk 二进制路径 | 存在（root 环境） | Shamiko 白名单模式卸载暴露面 |
| /proc、/sys、tty drivers goldfish 痕迹 | 基本无（非 goldfish） | 一般无需处理，列入验收项 |
| Docker 网络/主机痕迹（/proc/net、DNS） | 存在 | 评估项，通常 App 不检测 |

### 4.3 Shamiko + Denylist 配置（安装后自动执行）

```
magisk --sqlite "REPLACE INTO settings (key,value) VALUES('denylist',1)"
magisk --denylist add <target.app.package>        # 逐包添加目标 App
magisk --denylist enable
```

Shamiko 装上后在 Magisk App 内开启"白名单模式"（也可写 `shamiko_whitelist` 文件到 `/data/adb/shamiko/`），测试时以白名单模式运行：只有显式放行的包暴露 root，其余全部隐藏——红队场景默认把目标 App 设为隐藏对象。

---

## 五、版本矩阵（锁定）

| 组件 | 版本基线 | 备注 |
|---|---|---|
| Redroid 镜像 | `redroid/redroid:13.0.0-latest`（项目默认） | x86_64；ARM64 需另编内核并单测 |
| Magisk | stable 最新（v27+） | fetch 脚本锁定 commit/tag |
| Zygisk | Magisk 内置 | 首启启用 |
| LSPosed | Zygisk 版（维护截止支持 Android 13） | 与镜像版本匹配 |
| Shamiko | 与 Magisk 匹配的最新 release | 白名单模式 |
| Hide My Applist | 可选 | 需要 LSPosed 生效后启用 |

> 每次升级组件版本 → stamp 变化 → `ensure_preset_image` 自动重建派生镜像（复用 GApps 管线的 stamp 机制）。

---

## 六、代码改动清单（本仓库）

### 后端 Rust

| 文件 | 改动 |
|---|---|
| `src-tauri/src/models/mod.rs` | `CreateOptions` 增加 `install_magisk: bool`、`install_lsposed: bool`、`install_shamiko: bool`、`spoof_profile: Option<String>`（对齐现有 `install_gapps`） |
| `src-tauri/src/services/docker.rs` | `ensure_gapps_image()` 泛化为 `ensure_preset_image(base, gapps, magisk_cfg)`；`create_container()` 串联新参数；新增 `resolve_magisk_dir()`（对齐 `resolve_gapps_zip` 的搜索逻辑，含 `vendor/magisk`） |
| `src-tauri/src/services/device.rs`（或新 `root.rs`） | 设备详情新增：Root 状态检测（`adb shell magisk -v`）、模块列表（`ls /data/adb/modules`）、denylist 管理、`getprop` 抽样对比伪装结果 |
| `src-tauri/src/services/settings.rs` | magisk 路径、版本锁定设置 |

### 首启编排（二选一，建议 A）

- A（推荐）：镜像内 `magisk_preset.sh` 自完成——创建后无需客户端参与，适合连续建机/自动启动流程。
- B：客户端 ADB 驱动（等 ADB ready 后 push 模块 zip + 执行）——可控但拖慢建机。

### 前端 React

| 文件 | 改动 |
|---|---|
| `src/pages/Docker.tsx` | 创建表单：Magisk/LSPosed/Shamiko 勾选（沿用 GApps 勾选的禁用联动：vendor 缺文件禁建）、伪装 profile 选择 |
| `src/pages/DeviceDetail.tsx` | Settings/Overview 增加 Root 与伪装状态卡（Magisk 版本、Zygisk 开关、模块列表、getprop 抽样） |
| `src/pages/Settings.tsx` | Magisk 资产路径配置 + 检测按钮 |

### 脚本

| 文件 | 改动 |
|---|---|
| `scripts/fetch-magisk.ps1` | 新增：下载 Magisk/LSPosed/Shamiko release 到 `vendor/magisk/`（不进 Git） |
| `.gitignore` | 增加 `vendor/magisk/` |

---

## 七、验收清单（红队口径）

1. `adb shell getprop ro.product.model` 返回伪装值；`ro.build.fingerprint` 与所选 profile 一致。
2. `adb shell magisk -v` 正常；Magisk App 可打开，Zygisk=ON，LSPosed/Shamiko 模块生效。
3. 目标内部 App 运行：
   - 检测不到 Magisk/su/denylist 以外暴露面（Shamiko 白名单模式）；
   - `pm list packages` 不可见 Magisk 相关包；
   - App 自身环境检测结果记录归档（形成对抗矩阵：检测项 × 通过/失败）。
4. 删容器重建（同一数据卷）：伪装与模块状态保留。
5. 连续建机 3 台，各容器 denylist 独立、互不影响。
6. GApps + Magisk 同装时，Play Integrity 基础 attestation 结果记录（预期失败项如实记录，不作为验收门槛）。

---

## 八、已知限制与风险

- **架构匹配**：x86_64 伪装成 ARM 机型时 `ro.product.cpu.supported_abis` 与真实 CPU 指令集不一致，检测能力较强的 App 可通过 `/proc/cpuinfo` 识别；需要 ARM 时走 arm64 镜像 + 翻译层，另评估。
- **硬件指纹无法伪造的项**（IMEI、传感器、安全芯片）依赖 LSPosed hook，覆盖度以 App 实际检测代码为准——这正是对抗测试要量化的部分。
- Magisk 容器内运行依赖 Redroid init 对 `/system/etc/init/*.rc` 的加载行为，Redroid 版本升级后需回归（脚本中加自检：`magisk -v` 不通则打警告日志）。
- 测试产物（spoof.conf、模块配置）在数据卷中，属用户数据，删除数据卷即彻底清除。

---

## 九、自动化测试记录（2026-09-04 第二轮 GUI 回归）

在真实环境（Docker Desktop 28.3.2 + WSL2 binder 内核 + 在线 redroid-1 实例）完成 GUI 自动化走查，发现并修复：

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 新建实例端口建议永远是 5555（用户实测反馈） | Docker 25+ 的 `docker ps -a` 对**已停止**容器 Ports 列输出为空，`docker port` 同样不显示，端口占用检查对退出容器失明 | `list_containers` 对 Ports 为空的容器追加一次批量 `docker inspect`（HostConfig.PortBindings）补全；新增 4 个单测 |
| 2 | 无端口映射的容器（手工 docker run 未加 -p）显示假 serial `127.0.0.1:5555` | `extract_host_port` 兜底 5555 | 如实上报 port 0 / serial 空；设备卡与详情面板显示「未映射 ADB 端口」警告徽章，ADB 连接按钮禁用 |
| 3 | 点「ADB 连接」对端口未监听的容器空转 180s（90 次 connect 重试），且日志显示双循环 | `wait_ready` 无预检；StrictMode 双触发叠加 | 127.0.0.1 serial 先做 TCP 预探测（8s 内端口未开即失败，给出准确原因）；`wait_ready` 增加同 serial 防重入锁 |
| 4 | 自动启动每次刷「找不到设备 127.0.0.1:5555」 | 设备 id 在在线（serial）与离线（容器 id）间切换，单键匹配失效 | 按 id / serial / containerId 三重匹配；serial 为空时跳过 ADB 连接并记录「容器已启动（未映射）」 |
| 5 | 设备页列表瞬时变 1 台且不自愈（状态栏却显示 3 台） | `docker ps` 瞬时失败被静默吞成空列表；页面 mount 后不跟随 store 更新 | `list_containers` 失败重试一次并记 ERROR；设备页订阅 store 设备列表自愈 |

其他改动：Dashboard 空 serial 不再渲染孤立「·」；WebView2 强制开启渲染进程无障碍树（`--force-renderer-accessibility`），屏幕阅读器/自动化可完整读取 UI。

### 验证证据

- 真实管道复现（python 模拟 inspect 补全 + 建议算法）：rdc-redroid-1→5555、rdc-redroid-2→5556、unruffled_shirley→无映射，`next_free_adb_port` = **5557**（修复前恒 5555）。
- 创建对话框实测：打开即填 5557 + 实例名 redroid-4；手动改 5555 → 提交禁用 + 「改用 5557」建议按钮 → 点击后恢复。
- 自动启动实测：应用重启后经 serial 匹配到 rdc-redroid-1，自动 start 容器 + ADB 就绪（等待 39s，尝试 8 次），二次刷新显示「已在线跳过」。
- scrcpy 实测：启动画面弹出独立窗口显示 Android 实时画面；断开后卡片状态回 stopped。
- ADB Shell 实测：`getprop ro.product.model` → `redroid13_x86_64 [exit 0]`，执行历史/收藏联动。
- 局域网扫描实测：/24 254 地址 1.25s，空结果给出明确反馈。
- 回归：cargo test 7/7、tsc 0 错误、i18n 852 键 0 缺失、vite build 成功。

---

## 十、自动化测试记录（2026-09-04 第三轮：Magisk 实例全链路 GUI 验证）

### 通过 UI 创建 Magisk 实例（端到端实测）

创建对话框（redroid-mk / 端口 5557 / 勾选 Magisk+LSPosed+Shamiko / 不装 GApps）→ 镜像构建 → 首启配置 → 激活重启 → ADB 就绪，全程 ~66 秒。容器内实测：magiskd 30.6、Zygisk=1、denylist=1、zygisk_lsposed v1.9.2 + zygisk_shamiko v1.2.5 已装、伪装生效（ro.product.model=2210132C、Xiaomi 指纹、ro.kernel.qemu 已删除、release-keys）。

### 本轮发现并修复

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 6 | 勾选 Magisk 后 LSPosed/Shamiko 显示「缺 zip」且创建被禁用（资产明明存在） | `tauri dev` 下进程 cwd 是 `src-tauri/`，`resolve_magisk_dir` 只查 `cwd/vendor/magisk` 与 exe 同级，找不到仓库根的资产；GApps 靠一条写死的绝对路径侥幸工作 | 新增共享 `project_root_dirs()`（cwd 与 exe 目录逐级上溯），magisk/overlay/gapps/wsl 内核脚本目录统一使用；移除写死的绝对路径 |
| 7 | 伪装成 user 构建（ro.debuggable=0、release-keys）后 ADB 永远 unauthorized，Root 面板显示「未检测到 Magisk」 | adbd 仅在 userdebug 构建免认证；无人值守容器无法点授权弹窗 | 创建流程首启阶段把宿主机 `~/.android/adbkey.pub` 注入容器 `/data/misc/adb/adb_keys`（等效真机「一律允许」），user 构建真实性保留 |
| 8 | Root 面板 Zygisk/Denylist 显示「未启用」（实际已启用）、模块列表为空 | `magisk --sqlite/--denylist` 拒绝 adb shell（uid 2000，"Root is required"） | root.rs 引入 RootExec：有容器的实例改走 `docker exec`（稳定 root），真机回退 adb+`adb root` |
| 9 | denylist 添加未安装的包显示「完成」但实际没写入（假成功） | DeviceDetail `run()` 只捕获 promise rejection，不校验 ShellResult.success；且 magiskd 拒绝未安装包 | 前端校验返回对象并弹错误详情；后端 add 前用 `pm path` 预检，给出「设备上未安装 X」可读错误 |
| 10 | denylist 移除永远失败（usage 输出，exit 1） | Magisk v30 CLI 的移除动作是 `rm`，代码用的是 `remove` | op 映射修正，移除成功（容器内验证） |

Root 面板全交互实测通过：denylist 添加（成功/失败路径）、移除、立即应用伪装、Shamiko 白名单↔黑名单切换（容器内 whitelist 文件随动）、深色/浅色主题、中英文。

### 事故与教训：危险操作确认框被窗口状态绕过

第三轮测试中，自动化点击误触了容器行的「删除」。代码本有 `window.confirm` 双重确认，但**宿主窗口处于最小化状态时 WebView2 会静默跳过脚本对话框并自动放行**——rdc-redroid-2（10 天前旧测试实例，Exited）连同其数据卷被无确认删除，数据不可恢复。

修复：所有不可恢复操作（删除容器/镜像/数据卷、清理未使用卷、清空日志、删除设备文件、清除应用数据、卸载应用、切换 WSL 内核）改用 Tauri 原生对话框（`plugin-dialog` 的 `ask()`，独立 top-level 窗口，不受宿主窗口状态影响），封装于 `src/lib/dialogs.ts`。可逆操作（重启/停止/断开）保留原确认，后续可统一迁移。

---

## 十一、补漏（2026-09-04 第四轮：确认框迁移收口 + 回归复核）

上一轮修复后复核发现两类残留，本轮全部收口：

1. **批量替换残留损坏标识符复核**：`askConfirmonfirm` / `alertMsglert` 全仓 grep 0 命中，`npx tsc --noEmit` 退出码 0——第三轮末尾的残点修复已实际落盘（此前复核实况与总结一致，未再发现新残点）。
2. **可逆操作确认框全量迁移**：原「可逆操作保留 window.confirm，后续可统一迁移」的欠账本轮还清。迁移清单（15 处）：Adb kill-server / 全部断开；Devices 批量装 APK / 批量停止；Apk 离线设备仍安装确认；DeviceDetail 重启 / 停止 / Shamiko 白名单 / 黑名单 / 文件下载后打开目录 / 日志导出后打开目录 / 语言切换重启；Docker 重名建议采纳 / ADB 端口不可用仍创建 / 清理悬空镜像 / 导出配置后打开目录。统一走 `src/lib/dialogs.ts` 的 `askConfirm`（Tauri 原生 top-level 对话框，不受宿主窗口最小化影响）。

唯一保留的 `window.confirm`：Settings 未保存离开守卫（`hashchange` 同步事件内，无法 await；且其失效方向是安全的——被抑制时自动恢复回设置页，不会丢守卫）。

### 回归结果（本轮实测）

- `npx tsc --noEmit`：0 错误
- `cargo test`：8/8 通过
- `npm run build`（tsc + vite build）：成功（1721 modules）
- `python scripts/i18n-audit.py`：字典 888 键 / 使用 853 键，MISSING 0 / PLACEHOLDER MISMATCH 0

---

## 十二、黑屏修复（2026-09-04 第四轮：GApps 实例 scrcpy 永久黑屏）

### 现象与根因

用户报告 5555 实例 scrcpy 一直黑屏。诊断链：

1. `screencap` 显示设备**在渲染**（状态栏时钟 + 底部导航栏都在），只是壁纸区纯黑、无应用图标 → 不是 SurfaceFlinger/编码问题，是**没有 HOME 界面**。
2. crash 缓冲区实锤：`com.google.android.setupwizard` FATAL 循环崩溃——`SecurityException: WifiService: Permission denied`（其 WiFi 列表页 `WifiManager.getCurrentNetwork` 在 redroid 上被拒）。
3. GApps 镜像上 setupwizard 未完成前就是 HOME（`resolve-activity` 落在 `SetupWizardActivity`），且 `user_setup_complete=0`、`device_provisioned=0`。无头容器永远点不完向导 UI → 向导崩 → 没有 HOME → 永久黑屏。

### 修复

- **存量实例**：对 5555（redroid-1）、5558（redroid-5）手动执行 `settings put secure user_setup_complete 1` + `settings put global device_provisioned 1` + `pm disable-user com.google.android.setupwizard`，两台 screencap 均确认桌面恢复（Google 搜索栏 + Gallery/Play Store 图标）。
- **产品化（docker.rs）**：新增 `skip_first_boot_provisioning()`，在创建流程 ADB 就绪后（含 Magisk 激活重启完）对勾选 GApps 的实例自动执行上述三步；幂等，标记与停用态均持久化在数据卷上。`wait_adb` 关闭时仍不跳过（与 Magisk 激活同一前提）。

### E2E 验证（通过应用 UI 实测）

UI 创建 rdc-redroid-4 / 端口 5556 / 勾选 GApps / 不勾 Magisk / 等待 ADB → 创建完成后容器内验证：`user_setup_complete=1`、`device_provisioned=1`、setupwizard 已自动停用、HOME 解析到 `com.android.launcher3.uioverrides.QuickstepLauncher`，screencap 直接显示完整桌面。黑屏类别闭环。

### 回归

cargo test 8/8、tsc 0 错误、npm run build 成功、i18n 0 缺失（本节修复未新增界面文案）。

---

## 十三、全预装实例交付 + 组合镜像支持（2026-09-05）

### 新能力：Magisk + GApps 组合镜像

原创建流程 `if install_magisk {} else if install_gapps {}` 是二选一：两个都勾时 GApps 被**静默丢弃**。已改为 GApps 叠加在 Magisk 预设镜像之上（`ensure_gapps_image(preset_tag, zip)`，`FROM 预设 + COPY overlay /system/`），两个选项可同时生效。镜像标签形如 `rdc-gapps:rdc-preset-<预设tag>-<gapps戳>`。

### 交付实例：rdc-redroid-2 @ 127.0.0.1:5555

通过 UI 创建（GApps+Magisk+LSPosed+Shamiko 全勾选、等待 ADB），端到端实测：

- Magisk 30.6，Zygisk=1，denylist=1（magisk --sqlite 实读）
- 模块：zygisk_lsposed + zygisk_shamiko
- 伪装生效：ro.product.model=2210132C / Xiaomi / alioth 指纹 / release-keys / ro.debuggable=0 / ro.kernel.qemu 已删
- GApps：11 个 Google 包（Play Store 可见可用）
- provisioning 自动跳过生效（user_setup_complete=1、device_provisioned=1、setupwizard 停用、HOME=QuickstepLauncher）
- screencap 确认桌面完整渲染（激活重启后屏幕会因空闲超时熄屏，scrcpy 里按键唤醒即可）

### 环境事故（诚实记录）

昨晚 22:1x–22:3x Docker Desktop/WSL 两次异常（22:22 事件日志重置、22:38 引擎管道消失、WSL 全停，宿主内存一度 98.5%）。**rdc-redroid-1 / rdc-redroid-4 / rdc-redroid-mk 三个容器及其数据卷（含 mk 的 magisk.db/denylist/模块状态）在该期间丢失，docker 无 destroy 事件、本应用代码无批量删除路径，数据不可恢复。** 镜像完好；应用、Docker Desktop 已重启恢复。已重建 rdc-redroid-2（即本节交付的全预装实例）作为替代。

遗留：设置中的自动启动列表残留 127.0.0.1:5555 / :5557 两条失效条目（对应已丢失实例），可在设置里手动移除；如需 redroid-2 开机自启，在创建表单勾选「创建后加入自动启动」或设置里添加。

### 回归

cargo test 8/8；本节改动未触及前端与文案（此前 tsc/vite/i18n 结果仍有效）。

---

## 十四、清理 + 两项改进 + 第四轮测试（2026-09-05）

### 清理

- 删除冗余实例 rdc-redroid-5（纯 GApps，redroid-2 已完全覆盖其能力）及数据卷 rdc-redroid-5-data。
- 删除两个无容器引用的镜像（旧 rdc-preset 2.92GB + 纯 GApps rdc-gapps 2.87GB），合计释放约 5.8GB。

### 改进 1：自动启动失效条目自动清理

容器在应用外被删（或因引擎崩溃丢失）后，其自启动条目会在每次启动时报「找不到设备」且永不消失。现在 `runAutoStart` 结束后：仅当设备列表非空（Docker 在线，空列表意味着引擎不可用、匹配无意义）时，把未匹配到任何设备的条目从 `autoStartDeviceIds` 中移除并写日志。实测：重启应用后自动清掉 5557 / f1567823edcd 两条死条目，保留匹配 redroid-2 的 5555 条目。

### 改进 2：首启后屏幕常亮 + 点亮

无头实例开机后因空闲超时熄屏，scrcpy 表现为黑屏、需手动发键唤醒。创建流程 ADB 就绪后（含 Magisk 激活重启完）现统一执行 `stay_on_while_plugged_in=7` + `svc power stayon true` + `KEYCODE_WAKEUP`，首次投屏直接落在点亮桌面。best-effort、幂等。

### 第四轮测试：redroid-2（组合镜像实例）Root 面板全交互

- 面板检测：Magisk 30.6 / Zygisk 已启用 / Denylist 已启用 / 模块 zygisk_lsposed v1.9.2 + zygisk_shamiko v1.2.5 / 伪装属性全套显示正确。
- denylist 加包（com.android.settings）：UI「完成」+ 容器内 `magisk --denylist ls` 实见条目，面板计数 0→1。
- denylist 移除：UI「完成」+ 容器内条目消失，计数 1→0。
- 立即应用伪装：重放后 ro.product.model=2210132C / release-keys / bootmode unknown 保持正确。
- 结论：组合镜像（GApps 叠加 Magisk 预设）上 Root 通道（RootExec docker exec）全链路正常。

### 回归

cargo test 8/8、tsc 0 错误、i18n 854 键 0 缺失（新增 autostart.pruned 中英文）。

---

## 十五、优化：投屏自动唤醒（2026-09-05）

- scrcpy 启动链路（`scrcpy::start`）在设备就绪后、拉起镜像前执行 `KEYCODE_WAKEUP`：熄屏的实例投屏不再是黑屏窗口。best-effort，失败仅告警。
- 首版实现带过 `keyevent 82`（MENU）在桌面会弹出壁纸菜单，已移除——redroid 默认无锁屏，仅 WAKEUP 即可；有锁屏的场景由用户在投屏窗口内手动划开。
- 存量实例 redroid-2 已手动补 `stay_on_while_plugged_in=7` 并验证 Awake；新建实例由首启流程自动设置。
- E2E 实测：故意 `keyevent 26` 熄屏 → 应用点「投屏」→ scrcpy 启动且 `mWakefulness=Awake`，截屏为点亮桌面。
- 回归：cargo test 8/8。

---

## 十六、测试轮⑤：文件 / 应用管理页（2026-09-05）

### 文件页（rdc-redroid-2 实测）

- 目录导航（快捷路径/面包屑）、列表（权限/大小/时间列）✓。
- **发现并修复 BUG**：下载选择保存路径后，产物是一个**同名文件夹**而非文件——`adb pull` 到不存在的本地路径会建同名目录。`download_file` 改为：目标是已存在目录才直接 pull，否则 pull 到旁路临时目录再移动到用户选的精确路径。修复后实测落盘为正确的文件且内容一致。
- 删除：原生 askConfirm 确认 + 文件移除 ✓；下载后「打开所在目录？」原生确认 ✓。

### 应用页（rdc-redroid-2 实测）

- 系统应用列表 116 个加载正常；启动/停止/详情/更多 per-row 操作布局正常。
- **发现并修复 BUG（UX）**：启动无 LAUNCHER 界面的后台应用（如 com.android.localtransport）时，错误弹窗直接展示 monkey 原始 args 转储。`start_app` 失败时检测 monkey 输出，改为人话提示「X 没有可启动的界面（无 LAUNCHER activity）…」。实测生效。
- 启动成功路径：`am start` 实测 DeskClock 正常打开（topResumedActivity 变更、无 crash）；UI 与后端同一条 monkey 命令链路。
- 备注：自动化点击在该长列表存在 a11y 索引漂移（连续稳定偏移一行，疑似行内 loading 状态增删元素所致），系自动化工具层问题、非应用逻辑 bug——React 每行绑定自身包名，人工点击不受影响。

### 回归

cargo test 8/8。

---

## 十七、优化：Docker 掉线一键启动（2026-09-05）

- 针对本次会话两次目击的 Docker Desktop/WSL 崩溃场景：状态栏检测到引擎离线时，「Docker 未运行」旁出现「一键启动 Docker Desktop」按钮（新命令 `start_docker_desktop`：定位 `%ProgramFiles%\Docker\Docker\Docker Desktop.exe` 并 spawn，日志记录结果）。启动后由既有 15s 轮询自动恢复状态显示；按钮仅在离线时出现，engine 在线时隐藏。
- 端口冲突预检确认已完整存在（表单防抖 check_adb_port → 警告 + 建议端口一键采纳 + 提交禁用），本轮无需改动。
- 说明：按钮的在线态隐藏已冒烟验证；离线态实弹验证需停掉运行中的实例，为避免影响 redroid-2 未做（spawn 机制与此前面板手动拉起 Docker Desktop 相同）。
- 回归：cargo test 8/8、tsc 0 错误、i18n 857 键 0 缺失（新增 startDocker/startingDocker/startDockerTitle 中英文）。

---

## 十八、测试轮⑥：端口预检 + APK 安装链路，修复安装挂死（2026-09-05）

### 端口冲突预检实弹验证 ✓

创建表单填入已占用端口 5555 → 红字警告「端口已被占用，可用 5556」（建议可一键采纳）+ 提交按钮自动禁用。

### 重大发现与修复：redroid(TCP) 上 APK 安装必挂死

- **现象**：UI 安装 APK 状态栏卡「安装中」180 秒超时；CLI 复现 `adb install -r` 打印 "Performing Streamed Install" 后永久挂起；`pm install` 同样挂。
- **根因**（logcat 实锤）：GApps 镜像的 Play Protect（Finsky VerifyApps）对每次安装发起 install-time verification，无头/无网环境等不到验证结果 → 安装会话永久挂起，且超时残留会话会继续阻塞后续安装。
- **修复（双层）**：
  1. GApps 实例首启配置（`skip_first_boot_provisioning`）自动写入 `package_verifier_enable=0`、`verifier_verify_adb_installs=0`（及 coefficient）——无头环境本就无法响应验证会话；设置持久化在数据卷。
  2. `adb::install` 对 TCP 目标（serial 含 `:`，即 redroid）改走 **push 到 /data/local/tmp + 设备端 `pm install`**（push 实测 95MB/s），装完清理临时文件；USB 物理设备保留流式安装。
- **验证**：关验证后 pm install 数秒内 Success；流式 `adb install -r` 也恢复正常；UI 全链路（选设备→选 APK→安装）结果表 Success/成功，DeskClock 重新安装成功（测试后已还原为卸载态）。

### 其他确认

- /sdcard/Download 目录一次性消失未再复现，判定为 /storage 挂载时序的一次性怪象。
- 应用长列表 a11y 索引漂移再次出现（自动轮工具层问题，见第十六节备注）。

### 回归

cargo test 8/8、tsc 0 错误、i18n 857 键 0 缺失。

---

## 十九、新功能：设备 HTTP 代理一键设置（2026-09-05）

- 设备详情 → 设置页新增「HTTP 代理（抓包用）」卡片：显示当前代理（`settings get global http_proxy`），输入 host:port 一键应用（`settings put global http_proxy`），一键清除（写回 `:0`）。走既有 device_shell 通道，纯前端改动。输入校验 `host:port` 格式，应用/清除即时回显并写状态栏。
- 实测（redroid-2）：未设置显示「未设置代理（流量直连）」→ 应用 192.168.1.100:8080 → 设备侧 `settings get` 确认 → 清除 → 设备侧确认回到 `:0`。红队对接 Burp/mitmproxy 不再需要手敲 shell。
- 开发中自纠一个小 bug：Android `settings get` 对未设置键返回字面量 "null"，显示层需将其视为未设置（否则显示「当前代理：null」）。
- 回归：cargo test 8/8、tsc 0 错误、i18n 866 键 0 缺失（新增 proxy 相关 9 组中英文）。

---

## 二十、安全强化：ADB 端口仅绑定回环（2026-09-05）

- **风险**：实例 ADB 端口此前绑定 `0.0.0.0`（所有网卡），局域网内任何机器都能访问；纯 userdebug 实例的 ADB 是免认证的，等于把调试接口裸奔在局域网。
- **修复**：创建与克隆的 `docker run -p` 统一改为 `127.0.0.1:{port}:5555`——只有宿主机本机能连（应用/scrcpy/adb 均走 127.0.0.1，不受影响）。端口占用检测解析器已兼容回环前缀格式。
- **E2E**（新建纯基础实例 redroid-3 @5556 实测）：端口显示 `127.0.0.1:5556->5555/tcp` ✓；宿主 adb connect 正常 ✓；**首启屏幕常亮首次实弹生效**（`stay_on_while_plugged_in=7`、`mWakefulness=Awake`）✓。测试实例已删除。
- **存量提示**：redroid-2 仍是 0.0.0.0 绑定（改动前创建）；其伪装为 user 构建、ADB 已要求 RSA 授权（仅宿主机公钥），风险可控。如需同样收口，删除后重建即可（数据卷同名保留）。
- 回归：cargo test 8/8。

---

## 二十一、主力机收口：redroid-2 重建为回环绑定（2026-09-05）

- 删除 rdc-redroid-2 容器（**数据卷 rdc-redroid-2-data 保留**），同名重建（GApps+Magisk+LSPosed+Shamiko 全套勾选），端口映射自动变为 `127.0.0.1:5555->5555/tcp`。
- **数据卷状态保留验证**：重建后 Magisk 30.6 / Zygisk=1 / denylist=1 / zygisk_lsposed + zygisk_shamiko 模块俱在；伪装（2210132C/Xiaomi/release-keys）保持；Play 验证关闭（verifier_verify_adb_installs=0）与屏幕常亮（stay_on=7）均在卷上持久化；桌面正常渲染。
- 重建走 UI 全流程，组合镜像直接复用，全程约 2 分钟。
- 回归：`npm run build`（tsc + vite）成功。

---

## 二十二、测试轮⑦：RAM 显示修正 + 克隆链路补全（2026-09-05）

**修复 1 —— 设备 RAM 显示的是宿主机内存而非实例限额**
- 原状：详情页 RAM 取容器内 `/proc/meminfo` 的 MemTotal，那是 Docker VM（WSL2）的总量（本机 16GB），与实例无关。
- 修复：`enrich_device` 追加 `docker inspect` 读取 `HostConfig.Memory`，有限额时显示「X.X GB（实例限额）」。实测 redroid-2 显示 **2.0 GB（实例限额）** ✓。

**修复 2 —— 克隆实例未继承源实例资源限制**
- 原状：克隆的 `docker run` 不带 `--cpus/--memory`，克隆体静默扩张到整个 Docker VM 可用资源。
- 修复：新增 `container_resource_limits()`（serde_json 解析 inspect 的 HostConfig），克隆时继承源实例的 CPU/内存上限。
- E2E（克隆 redroid-2 → redroid-2-copy）：新容器 `Memory=2147483648 NanoCpus=2000000000` ✓，端口自动回环绑定 `127.0.0.1:5556` ✓。

**修复 3 —— 克隆体黑屏 + GApps 环境丢失（无头引导修复重放）**
- 根因：克隆 = `docker commit` 容器文件系统 + **全新数据卷**。所有活在 /data 上的首启修复（GMS 向导跳过、Play 验证关闭、屏幕常亮）全部随旧卷留在源实例上——GApps 克隆体会再次掉进 setupwizard 崩溃循环黑屏。
- 修复：克隆 ADB 就绪后自动 ① 点亮并保持屏幕常亮；② 检测到 setupwizard 存在（GApps 镜像）时重放无头引导修复。
- E2E：克隆体 `user_setup_complete=1`、`device_provisioned=1`、`verifier_verify_adb_installs=0`、`stay_on=7`、`mWakefulness=Awake`，桌面焦点为 Launcher3（无黑屏）✓。

**修复 4 —— Finsky 首启回写 package_verifier_enable（时序竞态）**
- 发现：克隆的修复重放跑得比 GMS 首启初始化更早，Finsky 随后把 `package_verifier_enable` 写回 1（源实例是创建流程在 GMS 初始化后才写所以没这问题）。
- 修复：无头引导脚本内置设备端 nohup 重断言循环（每 45s 重写一次、共 ~4 分钟，覆盖首启窗口），不依赖宿主机调度。实测人为置回 1 后 55s 内被自动拉回 0 ✓。
- 回归：`npm run build`（tsc + vite）成功；cargo 编译 0 错误。验证用克隆体（容器 + 数据卷 + commit 镜像）已全部清理。

---

## 二十三、测试轮⑧：端口探测补盲 + 克隆失败清理 + 冷启动空页（2026-09-05）

**修复 1 —— 端口占用检测只看 Docker 容器映射，非 Docker 监听全盲**
- 风险：`host_port_in_use` 只解析 `docker ps` 的端口映射。宿主机上任何非 Docker 进程（本机代理、python 调试服务等）占住 5556 时，创建/克隆照常选中该端口，直到镜像准备完毕、`docker run` 才因端口冲突失败——克隆场景下白等数分钟 commit。
- 修复：`host_port_in_use` 增加 `TcpListener::bind(127.0.0.1:port)` 探测（同时覆盖 Hyper-V 保留端口段）。单测改为不固定具体端口号（结果依赖宿主环境）。
- E2E：python 监听 127.0.0.1:5556 后，创建表单端口建议自动跳到 **5557**；手动输入 5556 立即告警「端口已被占用，可用 5557」并禁用提交 ✓。

**修复 2 —— 克隆失败泄漏 commit 镜像**
- `docker run` 失败（端口冲突等）时，commit 产生的 `rdc-clone-*` 镜像（数 GB）不会自动删除。现在 run 失败即 best-effort `docker rmi -f` 清理（ADB 未就绪路径保留容器供排查，不清理）。

**修复 3 —— 应用冷启动后 Docker 页静默显示「未运行 + 全空」**
- 根因：`is_running_fast()` 3 秒超时探测 `docker version`，引擎冷启动（WSL 忙碌）时误判未运行并缓存，Docker 页首查落空且不报错，直到手动刷新才恢复（本轮实测复现）。
- 修复：快速探测失败时自动补一次 12 秒慢探测（`is_running_slow`），成功即纠正缓存。常规路径实测首查直接出全量数据 ✓。
- 回归：cargo test 8/8、`npm run build`（tsc + vite）成功。

---

## 二十四、修复：Magisk 管理 App 从未出现在实例中（2026-09-05）

**现象**：实例抽屉里没有任何 Magisk App（`pm list packages -3` 为空），但 magiskd/模块/伪装一切正常。用户无法从 App 侧操作。

**根因（两层叠加）**：
1. 首个实例首次预设时 Play 安装验证还在，`pm install magisk.apk` 被 Finsky 回滚，而预设脚本**不论成败都写 `.rdc_apk_installed` 标记**，此后每次开机跳过重装。
2. 修复第 1 层后依然被卸：magiskd（release 构建，check-signature 特性）在 post-fs-data 从 `/sbin/stub.apk` 提取受信证书；direct-system-install 模式下 rc 的 `--setup-sbin` 源目录里没有 stub.apk → trusted_cert 为空 → **任何**管理器安装后一分钟内被守护进程静默卸载（logcat: `pkg: APK signature mismatch` → `pm_uninstall`）。实测 release 与 debug 两个 APK 均被卸（v30.6/v30.7 release APK md5 相同，同一产物）。

**修复方案（自建信任对）**：
- 本地生成 `vendor/magisk/rdc-resign.keystore`，用 apksig（Google Maven jar + SignApk.java）把管理器 APK 做 v2 重签；**同一份 APK 复制为 stub.apk** 放进 `--setup-sbin` 源目录（烤入镜像 `/system/etc/init/magisk/stub.apk`）。
- 开机后守护进程自动 install_stub 安装管理器（证书与 stub 一致 → 校验通过），预设脚本另作保底（`cp → /data/adb/magisk.apk` + pm install + 按包存在性重试 + 先关安装验证）。
- `fetch-magisk.ps1` 增加 2b 步骤：下载后自动重签 + 产出 stub.apk。

**E2E 验证**：
- 一次性容器（bind mount sbin 源目录）：守护进程自动装上管理器，5 分钟零 mismatch，重启后依然在；App 打开显示 Installed 30.6 / Zygisk Yes，Home/Superuser/Logs/Modules 标签正常。
- redroid-2 同名重建（数据卷保留，新 stamp 镜像 89fa852d…）：管理器安装且存活、launcher 入口在、伪装 2210132C/release-keys、Zygisk=1、denylist=1、LSPosed+Shamiko 模块俱在。
- 注意：App 内顶部黄条（非官方版本警告）与「Requires additional setup」弹窗是 fork/直装环境的正常现象，**点 CANCEL 关掉即可，不要点 OK/Install/Update**（那是给真机刷 boot 的流程）。

### 补记（同日）：LSPosed / Shamiko 的"App"问题

- **Shamiko 本无 App**：纯后台 Zygisk 模块，无界面属正常。但发现预设脚本的
  白名单模式判断写的是 `modules/shamiko`，而模块实际 id 为 `zygisk_shamiko`，
  条件永不成立 → 白名单标记文件从未生成（且旧卷上的标记也丢失）。已修脚本条件
  并在 redroid-2 上补 `touch /data/adb/shamiko/whitelist`（重启后确认持久）。
- **LSPosed 管理器**：lspd 守护进程（pid 108）其实一直处于激活态，只是无 UI 入口
  （状态通知 importance=MIN 被折叠、快捷方式未注册）。模块内嵌的
  `manager.apk` 与守护进程同签名，直接 `pm install` 即得 `org.lsposed.manager`：
  实测打开显示 **Activated 1.9.2 (7024) - Zygisk**、Xposed API Enabled、
  设备识别为伪装的 Xiaomi redroid13_x86_64。
- 已把「安装 LSPosed 内嵌管理器」写入预设脚本（按包存在性幂等重试），
  下一轮镜像构建自动生效；App 内"Parasitic Manager Recommended"弹窗点
  Never show 关闭即可（寄生模式是给要隐藏 App 图标的高检测场景用的）。

---

## 二十五、测试轮⑨：克隆预设重放 + Root 面板体检（2026-09-05）

**修复 —— 克隆实例丢失整套 Magisk 预设（关键缺口）**
- 根因：克隆 = commit 容器文件系统 + 全新数据卷，而模块/伪装/denylist/管理器全部活在数据卷上。克隆首启虽有烤入镜像的 rc 自动重放预设脚本（装模块、开 Zygisk、伪装、Shamiko 白名单），但 **Zygisk 需要再重启一次容器才能真正注入 zygote**，且 denylist 目标清单不会继承。
- 修复（clone_container）：检测镜像携带 Magisk → 从源实例读 denylist 目标写入克隆的 rdc_target_packages.txt → 自动重启克隆 → 重新等 ADB → 点亮屏幕。实测克隆 redroid-2：重启后 zygiskd64（pid 418）与 lspd（pid 108）都在跑、两个模块装上、denylist 继承 com.android.settings、伪装 2210132C/release-keys、Magisk App 由守护进程自动安装、端口回环绑定 127.0.0.1:5556。

**延伸 —— Root 面板升级为「预设体检」**
- root_status 新增真实激活状态检测（区别于"DB 开关已打开"）：
  - `zygiskActive`：zygiskd 进程在跑（Zygisk 真正注入中；只开了 DB 标志而没重启时显示"重启容器后生效"）
  - `lsposedActive`：lspd 守护进程在跑（模块真正激活）
  - `magiskApp` / `lsposedManager`：两个管理器是否已作为 App 安装
  - `shamikoWhitelist`：白名单/黑名单模式（模块不存在时隐藏）
- 面板新增 LSPosed、Shamiko、管理 App 三行 + Zygisk 行细分注入状态，中英文 i18n 齐全（874 键 0 缺失）。

**验证**：cargo test 通过、`npm run build`（tsc + vite）成功、UI 现场确认全部体检项。克隆体与测试 denylist 条目已清理。

---

## 二十六、测试轮⑩：模块管理 + 管理器修复 + LSPosed 作用域（2026-09-05）

**延伸功能一 —— Magisk 模块启用/禁用/移除（Root 面板内联按钮）**
- 新命令 `magisk_module_set_enabled` / `magisk_module_remove`：写/删模块目录下的
  `disable` / `remove` 标记文件（Magisk 官方机制，重启实例后生效）。
- 模块 ID 校验复用预设重放的字符集（字母数字 `._-`），拒绝路径穿越。
- UI：模块区每行「禁用/启用」「移除」按钮（移除有确认弹窗），底部提示"重启实例后生效"。

**延伸功能二 —— 管理器一键修复**
- 新命令 `magisk_repair_managers`：Magisk App 缺失时从 /data/adb/magisk.apk 重装；
  LSPosed 管理器缺失时从模块内置 manager.apk 重装（装完回验 pm path 才算成功）。
- UI：仅当管理 App 行出现 ✗ 时才显示「修复管理器」按钮，避免界面常驻噪音。

**延伸功能三 —— LSPosed 作用域只读展示**
- 关键发现：redroid 镜像自带的 /system/bin/sqlite3 是坏的（对新库也 core dump），
  设备端读不了 /data/adb/lspd/config/modules_config.db。
- 方案：新增依赖 rusqlite（bundled）+ util::run_command_bytes（二进制安全的命令
  输出），把 db/-wal/-shm 三个文件 docker exec cat 到临时目录，本地用 SQLite 重放
  WAL 后查询 modules + scope 表（过滤 lspd 自身的寄生管理器条目）。
- 新命令 `get_lsposed_scope` 返回 `{modules: [{pkg, enabled, scope[]}], message}`；
  UI 在 lspd 激活时自动加载，按模块列出作用域包名，带刷新按钮。
- 仅容器实例支持（物理设备需 adb root 才能拉受保护文件，暂不实现）。

**顺带修复**
- Denylist 只显示数量不显示明细 → 现在逐行列出，包名与进程名分离
  （`com.pkg (com.pkg.MainActivity)`，之前直接显示 `com.pkg|com.pkg.MainActivity` 原始行）。

**E2E 实测（redroid-2 现场验证）**
- Shamiko 禁用 → 设备上出现 disable 标记、UI 状态变「禁用」→ 启用 → 标记消失恢复「启用」。
- denylist 加入 com.android.settings → 明细行 `com.android.settings (com.android.settings)`
  → 移出 → 设备端 --denylist ls 清空。
- pm uninstall org.lsposed.manager → 面板显示 LSPosed ✗ + 「修复管理器」按钮 →
  点击 → 管理器重装成功、状态恢复 ✓、按钮自动隐藏。
- LSPosed 作用域区正常加载（当前无作用域显示"无作用域"）。
- cargo test 10/10（新增模块 ID 校验、scope db 解析两个单测）、npm run build 通过、
  i18n audit 922 键 0 缺失。

---

## 二十七、测试轮⑪：克隆配置库继承 + Superuser 授权管理（2026-09-05）

**修复 —— su 被拒的真相与默认授权**
- `adb shell su` 返回 Permission denied，magiskd 日志 `su: request rejected (2000)`。
  读 fork 源码（native/src/core/su/daemon.rs + SuPolicy.kt）确认策略值：
  **0=QUERY, 1=DENY, 2=ALLOW** —— 策略表里 shell（uid 2000）存的是 1（早前确认
  弹窗未批准被记为拒绝），不是 bug 而是被正确拒绝。
- 预设脚本新增：每次开机 `REPLACE INTO policies VALUES (2000,2,0,0,0)`，adb shell
  的 su 对新实例开箱即用（红队自动化无交互提权）。当前实例已手工改 2 并实测
  `su -c id` → uid=0(root)，容器重启后依然生效。

**新功能 A —— 克隆完整继承配置库（su 策略/完整 denylist/LSPosed 作用域）**
- 第⑨轮克隆只继承 denylist 文本；su 授权、denylist 完整表、Zygisk 设置、
  LSPosed 作用域都在数据卷的 SQLite 库里（/data/adb/magisk.db 和
  /data/adb/lspd/config/modules_config.db）。
- clone_container 重放阶段：先 kill lspd/magiskd（防写入竞态），再用二进制安全
  的 `docker exec -i sh -c 'cat > path'` stdin 管道把两个库（含 -wal）整库拷入
  克隆，然后照旧重启激活 Zygisk。字节完整性已用 md5 往返验证（40960 字节一致）。
- 第⑨轮的 denylist 文本重放保留，作为旧镜像预设脚本的兜底。

**新功能 B —— Root 面板 Superuser 授权管理**
- 新命令：`get_su_policies`（magisk --sqlite 查 policies + `cmd package list
  packages -U` 解析 uid→包名，按 app id 匹配）、`magisk_set_su_policy`（允许/拒绝）、
  `magisk_remove_su_policy`（删除行，回退为弹窗确认）。
- 修了一个解析 bug：magisk --sqlite 行输出带键名前缀（`uid=2000|policy=1`），
  初版按裸值解析导致列表恒空——真机验证时抓到并修复。
- UI：Root 面板新增「Superuser 授权」区，每行显示 包名 · uid · 允许/拒绝 +
  允许/拒绝/移除按钮；策略修改需重启实例生效（magiskd 缓存已评估的策略；未
  缓存过的 uid 立即生效，redroid-3 实测 UI 切允许后 su 立即放行）。
- 附带：Root 面板任意操作完成后同步刷新作用域/su 区块。

**验证**：cargo test 12/12（新增 su 策略行解析、包名-uid 行解析单测）、npm build
通过、i18n audit 0 缺失。redroid-3（用户自建新实例，镜像戳 0af706be）确认预装
链路完整：Magisk 30.6 + Zygisk 注入 + LSPosed 管理器 + Shamiko 白名单全部自动就位。
克隆全流程 E2E 因当前内存压力（两实例在线 ~95%）暂缓执行，拷贝机制已单独
字节级验证；下次内存充裕时可直接复验。
