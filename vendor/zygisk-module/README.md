# RDC NativeCloak（Zygisk 原生模块）

Redroid Device Center「L3 容器痕迹清理」的原生层交付物。

> **状态：源码交付，本仓库环境未编译。** 桌面端 CI 没有 Android NDK，`dist/` 不会
> 被自动生成（与 `vendor/lsposed-module` 的 APK 约定一致）。按下面的步骤在本机
> 构建后，产物才存在。

## 它解决什么问题

Redroid 容器用的是 x86_64 通用镜像，有三类「痕迹」是 `resetprop`（Java/属性层）
碰不到的：

| 痕迹 | 桌面端能做的 | 本模块补的 |
| --- | --- | --- |
| `/proc/cpuinfo`、`/proc/version` | `docker run -v` 只读 bind-mount 假文件（`services/traces.rs` 生成） | — |
| `/proc/self/cgroup` | 只能加 `--cgroup-parent system.slice` 让路径少一段 `docker` | PLT hook `openat`，把 docker 段整体改写成 systemd service 风格 |
| `/proc/self/mountinfo`、`/proc/mounts` | 无 | PLT hook `openat`，剥离 overlay / docker 行 |
| native `eglQueryString` / `glGetString` | 无（只能改 Java 层 `Build`） | PLT hook 这两个入口，按 `rdc-cloak.json` 的 GL 字段返回 |

## 与 DeviceCloak（LSPosed 模块）的关系

两者互补，不是替代：

* **DeviceCloak**（`vendor/lsposed-module`，Java/Xposed）管 **框架 API**：
  `Build.*`、`Settings`、telephony、以及通过 Java 层拿到的 GL 字符串。
* **NativeCloak**（本模块，C++/Zygisk）管 **PLT 直调**：绕过 Java 层直接走
  libc / libEGL 的 native 调用，以及内核文件读取。

两者读同一份配置 `/data/local/tmp/rdc-cloak.json`（桌面端 `services/cloak.rs`
的 `push_cloak_config` 推送），因此 GL 字符串在两层保持一致。

## 目录结构

```
vendor/zygisk-module/
├── src/
│   ├── main.cpp      # 模块实现：GOT hook + openat / glGetString / eglQueryString
│   └── zygisk.hpp    # Zygisk API v2 头（vendored，见下）
├── module/           # Magisk 模块骨架（module.prop / customize.sh / META-INF）
├── build.sh          # NDK 交叉编译 x86_64 + arm64-v8a 并打包 zip
└── README.md
```

## 构建

```bash
export ANDROID_NDK_HOME=/path/to/android-ndk-r26
cd vendor/zygisk-module
./build.sh            # 或 ./build.sh /path/to/android-ndk-r26
```

产物：

```
dist/x86_64/librdc_nativecloak.so      # 容器（redroid x86_64 镜像）用
dist/arm64-v8a/librdc_nativecloak.so   # 真机测试用
dist/RDC-NativeCloak.zip               # Magisk 模块 zip（含 zygisk/<abi>.so）
```

为什么容器用 x86_64：**redroid 容器内的 zygote 是 x86_64**（宿主 Windows/WSL2 +
Docker Desktop 上的 x86_64 Android 镜像）。Zygisk 在 zygote 进程里 dlopen 的
`.so` 必须与 zygote 同 ABI，否则注入直接失败。arm64-v8a 只是给真机联调准备。

### 使用上游头文件（推荐）

`src/zygisk.hpp` 是从 Magisk 仓库 vendored 的 API v2 头。构建生产版本前，建议用
<https://github.com/topjohnwu/Magisk>（`native/src/zygisk/` 下随样本分发的
`zygisk.hpp`）**覆盖**本文件，以拿到上游修复。入口符号
（`zygisk_module_entry`）与 `Api` 虚表顺序是 ABI 的一部分，不要自行改动。

## 安装

两种方式：

### 方式一：桌面端一键安装（存量实例，推荐）

设备详情 → 深度伪装（DeviceCloak）→「安装 NativeCloak」。桌面端
（`services/cloak.rs` 的 `install_native_cloak`）会：

1. `docker cp dist/RDC-NativeCloak.zip <容器>:/data/local/tmp/RDC-NativeCloak.zip`；
2. 容器内优先走 `magisk --install-module`（fork 支持该 CLI 时）；否则用 busybox
   `unzip` 解压到 `/data/adb/modules/rdc_nativecloak/` 并 `chmod -R 755`（与预设
   流程的模块布局一致）；
3. 提示**需重启容器生效**（Zygisk 在下次 zygote 启动时注入）。

> ⚠️ 该命令序列以字符串形式做了单元测试，但尚未在真实容器上运行验证；模块
> zip 缺失时桌面端会给出构建指引而不阻断。

### 方式二：手动安装

```bash
# 宿主：拷入容器
docker cp vendor/zygisk-module/dist/RDC-NativeCloak.zip rdc-<name>:/data/local/tmp/

# 容器内：Magisk CLI（若 fork 支持）
docker exec rdc-<name> sh -c 'M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --install-module /data/local/tmp/RDC-NativeCloak.zip'

# 或容器内：busybox 解压等价安装
docker exec rdc-<name> sh -c 'B=/data/adb/magisk/busybox; [ -x $B ] || B=/system/etc/init/magisk/busybox; \
  rm -rf /data/adb/modules/rdc_nativecloak && mkdir -p /data/adb/modules/rdc_nativecloak && \
  $B unzip -o /data/local/tmp/RDC-NativeCloak.zip -d /data/adb/modules/rdc_nativecloak && \
  chmod -R 755 /data/adb/modules/rdc_nativecloak'

# 重启容器生效
docker restart rdc-<name>
```

1. 重启后确认 Zygisk 已启用、模块已勾选。
2. 桌面端在设备详情页推送 `rdc-cloak.json`（DeviceCloak 面板的「推送配置」）。

## 实现说明 / 已知限制

* **GOT hook 是内置的简化实现**（`dl_iterate_phdr` + 解析 `.rel(a).plt` /
  `.rel(a).dyn`，覆写 GOT 槽）。需要更稳的匹配（regex、更多重定位类型）时，可以
  换成 [lsplt](https://github.com/LSPosed/lsplt)，替换 `apply_got_hooks()` 即可。
* hook 在 `postAppSpecialize` 安装：此时 zygote 预加载的 libEGL/libGLESv2 已在
  进程内；应用稍后 dlopen 的第三方 native 库**不会**被 hook（那些库的 GL 调用走
  自己的 GOT 槽）。这是简化实现的边界，严格场景建议改用 lsplt 的全局扫描。
* `/proc` 净化内容缓存在 `/data/local/tmp/rdc-cloak/`（`customize.sh` 创建为
  0777）。每次 open 实际返回的是 `memfd_create` 出的内存 fd（内容与缓存一致），
  避免重复落盘与权限问题。
* `openat` 只覆盖使用 `openat` 的调用方；`open`/`openat64` 在 64 位 bionic 上通常
  汇入 `openat`，但按需可再加 hook。
* 未做 `uname` / `sysinfo` 的 hook（`/proc/version` 已由桌面端 bind-mount 覆盖）。
