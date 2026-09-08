# Redroid Device Center

面向 Android 自动化开发、云手机控制、App 自动化测试的桌面管理平台。

底层：Tauri 2 + React + TypeScript，通过 Docker 跑 Redroid，用 ADB / scrcpy 控制。

## 启动

```powershell
cd F:\code\project\Android-Device
npm install
npm run tauri dev
```

只看前端（无 Docker / ADB 后端）：

```powershell
npm run dev
```

打安装包（仅 NSIS）：

```powershell
npm run tauri build
```

产物在 `src-tauri\target\release\bundle\nsis\`。

## 前置依赖

- Node.js 18+
- Rust（rustup）
- Docker Desktop
- ADB（platform-tools）
- scrcpy
- Windows + WSL2（Redroid 需要自定义 binder 内核）

**设置** 里可浏览 / 打开 / 检测 `docker`、`adb`、`scrcpy` 路径。Docker、Volumes、ADB 页顶部也会显示是否可用。

## 当前能力

| 模块 | 说明 |
|---|---|
| Dashboard | Docker / ADB、本机 CPU 内存、最近日志与截图（可打开目录） |
| 设备中心 | 列表、筛选/搜索、多选、批量连接 / 断开 / 重启 / 停止 / HOME / BACK / RECENT / 锁屏 / 装 APK / 亮屏 / 截图；结果可点进详情、只选失败 |
| 设备详情 | 打开时离线会自动等开机并 ADB 连接；顶栏可启动/停止/重启；离线时禁用控制与文件/应用操作，Logcat 停止轮询；Settings 可勾选自动启动 |
| Docker | 创建 Redroid、名称/端口占用检测、创建进度、连续建机、实例检查/日志、复制 Serial、搜索会记住；引擎不可用时禁用操作 |
| 数据卷 | `rdc-*-data` 持久化 `/data`；与实例互跳；搜索/筛选会记住；点卷名复制；清理空闲卷 |
| ADB | 扫描、连接（Enter）、记住上次地址、点 Serial 复制、Server 维护；工具不可用时禁用操作 |
| APK | 选文件批量安装；记住路径/勾选；全选在线；离线会确认；可复制结果 |
| 日志 | 内存 + 按天落盘到设置中的日志目录 |
| 设置 | 路径浏览 / 打开 / 单条或全部检测；自动启动设备清单（可清理失效项）；创建时默认加入自动启动 / 留在表单 |

## 创建一台带 GApps 的虚机

1. Windows：先在 **Docker** 页切自定义 binder 内核，再重新打开 Docker Desktop。  
2. 默认镜像：`redroid/redroid:13.0.0-latest`（官方无 Android 11 的 x86_64 GApps）。  
3. 准备 MindTheGapps 13 x86_64 zip（**不要提交 Git**）：

```powershell
.\scripts\fetch-mindthegapps.ps1
```

包会放到 `vendor\gapps\`（已 gitignore）。

4. **Docker → 创建实例**：预装 GApps；分辨率须为 `宽x高`，DPI 为 120–640。上次规格会记住。名称或 ADB 端口被占用时会提示可用值，创建按钮不可点。  
5. 会先检测 Docker；ADB 不可用时可选择只建容器、不等开机。进度会显示阶段（拉镜像 / GApps / 等 ADB，含已等待秒数和 `boot=`）。成功后默认进设备详情。

删容器**不会**删数据卷。要清安卓数据：到 **Volumes** 删对应 `rdc-*-data`。

### 连续建机

在创建表单勾选：

- **创建后留在此表单**：不跳详情；名称和端口自动变成下一台。失败且容器已在时可「打开这台」。列表里刚建的那一行会绿框高亮（不抢滚动）。
- **创建后加入自动启动**：写入开机清单。

两项默认值可在全局 **设置** 改。

### 自动启动

下次打开应用要自动开机：进该设备 **Settings** 勾选「自动启动」。全局 **设置** 页可查看/移除清单。启动后在后台启动（同时最多 2 台），界面可先用；若 Serial 为 `host:port` 再等 ADB `state=device`（每台最多约 180 秒），超时记日志，不卡住窗口。

## Root 预装（红队对抗测试）

创建实例时可勾选**预装 Magisk + Zygisk**（可选 LSPosed / Shamiko 模块），并应用
`ro.product.*` / 指纹伪装（resetprop 每次开机重放）。仅用于对**授权内部 App** 的对抗测试。

1. 下载资产（Magisk fork APK + LSPosed + Shamiko，均不进 Git）：

```powershell
.\scripts\fetch-magisk.ps1
```

2. **Docker → 创建实例**：勾选「预装 Magisk + Zygisk」；可选填 denylist 目标包（创建后对目标 App 隐藏 root）与伪装配置文件（留空用 `vendor/magisk-overlay` 内置 profile）。
3. 创建流程自动完成：构建 `rdc-preset:*` 定制镜像 → 首启 magiskd 配置（Zygisk、模块安装、denylist、Shamiko 白名单）→ 自动重启一次容器激活 Zygisk。
4. 设备详情 Overview 底部 **Root / 伪装** 卡片：Magisk 版本、Zygisk / denylist 状态、模块列表、getprop 抽样、首启日志；支持立即重放伪装、增删隐藏包、Shamiko 白/黑名单切换。

排障：容器内 `adb shell tail -n 100 /data/adb/rdc_preset.log`。机制与版本矩阵见 `docs/ROOT-PRESET-SPEC.md`。

## 局域网扫描自动连接

**ADB → 局域网扫描**：输入网段（默认自动检测本机 /24，如 `192.168.1.0/24`）与端口（默认 5555），
勾选「自动连接发现的设备」后开始扫描。后端对网段内 254 个地址做并发 TCP 探测（64 线程、300ms 超时，
整段约 2–3 秒），对端口开放的候选执行 `adb connect` 并读取 `ro.product.model`；结果表可对单台
重连或打开设备详情。设备需开启无线调试（ADB over TCP）才会被发现；仅支持 /24 网段。

## 国际化（i18n）

界面文案中英文双语（zh-CN / en-US）：

- 切换入口：侧边栏底部 **中文 / EN** 按钮，或 **设置 → 外观与语言 → 语言**（两者等效，立即生效并持久化）。
- 实现：`src/i18n/index.tsx`（`I18nProvider` / `useI18n().t`），词典按页面拆分在 `src/i18n/pages/*.ts`（每页一个文件，`xxxZh` / `xxxEn` 两个导出）；非 React 模块用 `tStatic()`。
- 覆盖范围：全部页面 UI 文案、confirm/alert 提示、title/placeholder；**不含** Rust 后端返回的日志与创建阶段文案（`get_create_stage` 等，仍为中文）。
- 缺失词条回退：en 缺失时显示 zh，再缺失显示 key 本身。

## Binder / 平台（Win + Linux，无 Mac）

| 平台 | 做法 |
|------|------|
| **Windows x64** | 预编译 WSL `bzImage` 或本机编译 |
| **Windows ARM64** | 另编 arm64 内核（不能用 x64 包） |
| **Linux x64 / ARM64** | 主机 binder，不用 WSL 内核 |

```powershell
.\scripts\detect-platform.ps1
.\scripts\install-wsl-kernel.ps1 -Apply
# 或本机编译
.\scripts\setup-wsl-binder-oneclick.ps1 -Apply
```

```bash
bash scripts/detect-platform.sh
bash scripts/setup-linux-binder.sh
```

应用内：**Docker** 页 → 切换自定义 / 恢复默认 / 检测 binder（不内置编译）。  
详见 `scripts/README-WSL-KERNEL.md`、`scripts/platform-assets.json`。

## 体积说明

- 客户端不打包 Docker 引擎、不打包 Redroid 镜像、不提交 GApps zip。  
- 发布只打 NSIS；Rust Release 开 LTO / strip。  
- 前端已去掉 framer-motion 和未使用的 Tauri 插件。

## 注意

- Windows 上 Redroid 容器 Up ≠ ADB 可用，缺 binder 内核时常见 `offline`。  
- GApps 是社区 overlay，Play 登录与认证需在虚机里自行完成。  
- scrcpy 目前是独立窗口；页内提供截图预览、ADB 点击/滑动、常用按键、文本/剪贴板输入和 Shell 控制。
