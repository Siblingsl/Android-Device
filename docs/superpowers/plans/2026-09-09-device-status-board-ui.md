# Device Status Board UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不删除现有能力的前提下，把主窗口改造成紧凑的设备状态看板，并为后续补齐用户列出的 escrcpy 功能建立稳定入口和可验证的实现边界。

**Architecture:** 保留现有 React Router、Zustand、DeviceService 和 Tauri 命令作为唯一设备操作入口。新增的主窗口组件只负责设备分栏、行内快捷操作、悬浮信息卡、工具启动器和活动抽屉；完整的设备详情和旧页面继续作为深层工作区。scrcpy 仍由现有 Rust 外部进程服务启动，绝不嵌入 WebView。

**Tech Stack:** React 19、TypeScript、React Router 7、Zustand、lucide-react、Vitest、Testing Library、Tauri 2、Rust。

**Spec:** `docs/superpowers/specs/2026-09-09-device-status-board-ui.md`

## Global Constraints

- 不删除或改名现有 Tauri 命令、服务方法、设置字段、localStorage/sessionStorage 键。
- Dashboard、设备中心、设备详情、Docker、ADB、APK、文件、Volumes、Logcat、监控告警、系统日志、设置和 Root 入口必须继续可达。
- 现有截图轮询、鼠标手势、独立 scrcpy、设备控制、Shell、应用管理、文件传输、批量结果、监控图表和告警撤销必须保留。
- `Reference_Projects/escrcpy` 只用于对照，不修改其文件；Vite/Vitest 不扫描该参考目录。
- 不伪造后端没有返回的电量、温度、电压、摄像头、录制或无线配对数据；缺少能力时提供明确禁用原因。
- 每个新增行为先写一个会失败的测试，确认失败原因正确，再写最小实现并运行回归。
- 现阶段不改写用户未跟踪的参考项目文件，也不覆盖与本任务无关的工作区变化。

### Task 1: 隔离参考目录并建立看板数据边界

**Files:**
- Modify: `vite.config.ts`
- Create: `src/lib/deviceBoard.ts`
- Test: `src/lib/deviceBoard.test.ts`

**Interfaces:**
- Consumes: `DeviceInfo` from `src/types/index.ts`。
- Produces: `isDeviceOnline(device)`, `deviceLaneFor(device)`, `groupDevicesForBoard(devices)` and `deviceCapabilitySummary(device)`，供主看板与测试复用。

- [ ] **Step 1: 写看板分栏失败测试**

```ts
it("uses adb readiness as the online lane and keeps unauthorized devices separate", () => {
  expect(groupDevicesForBoard([
    { ...device("ready"), online: true, adbStatus: "device" },
    { ...device("auth"), online: true, adbStatus: "unauthorized" },
    { ...device("offline"), online: false, adbStatus: "offline" },
  ])).toMatchObject({
    online: [{ id: "ready" }],
    attention: [{ id: "auth" }],
    offline: [{ id: "offline" }],
  });
});
```

- [ ] **Step 2: 运行测试确认因为函数不存在而失败**

Run: `npx vitest run src/lib/deviceBoard.test.ts`

Expected: FAIL with an import or missing-export error for `groupDevicesForBoard`。

- [ ] **Step 3: 实现最小纯函数**

```ts
export type DeviceBoardLane = "online" | "attention" | "offline";

export function isDeviceOnline(device: DeviceInfo): boolean {
  return device.online && device.adbStatus === "device";
}

export function deviceLaneFor(device: DeviceInfo): DeviceBoardLane {
  if (isDeviceOnline(device)) return "online";
  if (device.adbStatus === "unauthorized" || device.adbStatus === "authorizing") return "attention";
  return "offline";
}

export function groupDevicesForBoard(devices: DeviceInfo[]) {
  return devices.reduce((groups, device) => {
    groups[deviceLaneFor(device)].push(device);
    return groups;
  }, { online: [], attention: [], offline: [] } as Record<DeviceBoardLane, DeviceInfo[]>);
}
```

- [ ] **Step 4: 配置 Vitest 排除参考目录并运行测试**

Modify `vite.config.ts` so the test configuration excludes `Reference_Projects/**`; run `npx vitest run src/lib/deviceBoard.test.ts` and then `npm test`。

Expected: 看板测试通过；主项目原有测试通过，参考项目不再被收集。

- [ ] **Step 5: 提交**

```bash
git add vite.config.ts src/lib/deviceBoard.ts src/lib/deviceBoard.test.ts
git commit -m "feat: define compact device board lanes"
```

### Task 2: 新增工作区栏、工具启动器和活动抽屉

**Files:**
- Create: `src/components/layout/WorkspaceHeader.tsx`
- Create: `src/components/layout/ToolLauncher.tsx`
- Create: `src/components/layout/ActivityDrawer.tsx`
- Modify: `src/components/layout/AppLayout.tsx`
- Modify: `src/styles/global.css`
- Modify: `src/i18n/pages/common.ts`
- Test: `src/components/layout/WorkspaceHeader.test.tsx`

**Interfaces:**
- Consumes: `useAppStore` status/devices/alerts、React Router navigate、现有 `StatusBar` 的状态反馈。
- Produces: 顶部工作区栏、可打开所有旧路由的工具启动器、可收起的活动抽屉；`AppLayout` 继续执行原有设置加载、设备刷新和自动启动。

- [ ] **Step 1: 写启动器与旧路由可达的失败测试**

```tsx
it("exposes the existing tools without rendering the old large sidebar", () => {
  render(<WorkspaceHeader />, { wrapper: TestShell });
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  expect(screen.getByRole("link", { name: "设备中心" })).toHaveAttribute("href", "#/devices");
  expect(screen.getByRole("link", { name: "文件与应用" })).toHaveAttribute("href", "#/apk");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/layout/WorkspaceHeader.test.tsx`

Expected: FAIL because the new header and launcher do not exist。

- [ ] **Step 3: 实现最小入口组件**

工作区栏显示产品名、当前路由上下文、设备搜索、在线/待处理数量、工具和设置按钮。工具启动器列出 Dashboard、设备中心、Docker、ADB、APK、文件、Volumes、监控、日志和设置，并使用现有路径。

- [ ] **Step 4: 把旧布局替换成新壳层但保留旧组件与行为**

`AppLayout` 改成 `WorkspaceHeader`、`Outlet`、`ActivityDrawer`、`StatusBar` 的结构；保留 `Sidebar.tsx` 与 `DetailPanel.tsx` 文件和路由行为，暂不删除，以便回退和深层入口兼容。活动抽屉的四个页签分别链接到现有监控、日志和设备中心批量结果入口，状态文本和告警撤销继续由原组件提供。

- [ ] **Step 5: 添加紧凑样式并运行组件与全量测试**

Run: `npx vitest run src/components/layout/WorkspaceHeader.test.tsx src/components/layout/StatusBar.test.tsx` and `npm test`。

Expected: 新壳层测试通过，原有 164 个主项目测试保持通过。

- [ ] **Step 6: 提交**

```bash
git add src/components/layout src/styles/global.css src/i18n/pages/common.ts
git commit -m "feat: add compact workspace shell"
```

### Task 3: 实现设备状态看板与设备卡

**Files:**
- Create: `src/components/device/DeviceStatusBoard.tsx`
- Create: `src/components/device/DeviceHoverCard.tsx`
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/styles/global.css`
- Modify: `src/i18n/pages/dashboard.ts`
- Modify: `src/i18n/pages/devices.ts`
- Test: `src/components/device/DeviceStatusBoard.test.tsx`

**Interfaces:**
- Consumes: `useAppStore.devices`、`DeviceService.connect/disconnect/restart/stop/scrcpyStart/scrcpyStop/screenshot`、现有确认与复制工具。
- Produces: 在线运行、待授权、离线/异常三栏；设备名称、Serial、Android、资源、Docker/ADB/scrcpy 状态、可用的高频操作，以及“详情/更多”入口。

- [ ] **Step 1: 写行内操作失败测试**

```tsx
it("starts the independent scrcpy command from the card and exposes failure text", async () => {
  vi.mocked(DeviceService.scrcpyStart).mockResolvedValue({ success: false, stdout: "", stderr: "scrcpy missing", exitCode: 1 });
  render(<DeviceStatusBoard devices={[onlineDevice]} />, { wrapper: TestShell });
  fireEvent.click(screen.getByRole("button", { name: "打开镜像" }));
  expect(await screen.findByText("scrcpy missing")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重试镜像" })).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/device/DeviceStatusBoard.test.tsx`

Expected: FAIL because the status board does not exist。

- [ ] **Step 3: 实现设备卡和悬浮信息卡**

卡片使用 `deviceLaneFor` 分栏。悬浮卡只显示 `DeviceInfo` 已有字段：Serial、Android、分辨率、DPI、CPU、内存、FPS、ADB、Docker、scrcpy、IP、数据卷和运行时长；电量、充电、温度、电压和电源来源在后端未提供时显示“未提供”，不得用默认数值代替。

- [ ] **Step 4: 接入行内快捷操作**

在线卡显示“打开镜像、控制、文件、应用、更多”；离线/待授权卡显示“连接/重试、详情、更多”。所有返回 `ShellResult` 的动作检查 `success`，错误使用 stderr → stdout → 本地化默认文案，成功/失败写入现有状态栏。

- [ ] **Step 5: 把 Dashboard 的数据刷新、通知、日志、截图和 APK 入口迁移到看板下方**

不删除现有 Dashboard 数据加载和跳转逻辑；把统计信息收拢为看板顶部摘要，把通知/最近日志/截图/APK 变成活动抽屉中的可点击项目。

- [ ] **Step 6: 运行回归并提交**

Run: `npx vitest run src/components/device/DeviceStatusBoard.test.tsx src/pages/Dashboard.test.tsx src/pages/Devices.test.tsx` and `npm test`。

Expected: 新看板和旧设备批量功能均通过。

```bash
git add src/components/device src/pages/Dashboard.tsx src/styles/global.css src/i18n/pages/dashboard.ts src/i18n/pages/devices.ts
git commit -m "feat: add compact device status board"
```

### Task 4: 保留完整设备详情并优化独立 scrcpy 控制入口

**Files:**
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/components/device/DeviceControlPanel.tsx`
- Modify: `src/components/device/DevicePreview.tsx`
- Modify: `src/components/device/DeviceShell.tsx`
- Modify: `src/lib/deviceActions.ts`
- Modify: `src/i18n/pages/deviceDetail.ts`
- Modify: `src/styles/global.css`
- Test: `src/pages/DeviceDetail.test.tsx`

**Interfaces:**
- Consumes: 原有详情页所有 Tab、截图预览、鼠标手势、Shell 历史和控制反馈。
- Produces: 紧凑横向控制栏、可视化 scrcpy 参数入口、独立窗口状态、控制栏排序和布局持久化接口，但不改变现有命令参数。

- [ ] **Step 1: 先补充现有详情行为的失败测试**：scrcpy 失败后按钮恢复可用；空文本不调用服务；截图失败保留上一张图。
- [ ] **Step 2: 运行 `npx vitest run src/pages/DeviceDetail.test.tsx` 确认新增断言失败**。
- [ ] **Step 3: 将按钮分为导航、设备状态、显示、输入四组，继续使用现有 `DeviceService`，独立窗口只显示状态和重试入口**。
- [ ] **Step 4: 用 `localStorage` 保存控制栏按钮顺序和详情布局，读取失败回退默认顺序**。
- [ ] **Step 5: 运行 `npm test` 和 `npm run build`，确认详情页所有原有测试通过后提交**。

### Task 5: 补齐文件管理 P0 细节

**Files:**
- Modify: `src/pages/DeviceDetail.tsx`
- Create: `src/lib/fileWorkspace.ts`
- Test: `src/lib/fileWorkspace.test.ts`
- Test: `src/pages/DeviceDetail.test.tsx`
- Modify: `src/services/deviceService.ts`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/services/device.rs`

**Interfaces:**
- Consumes: 现有 `listFiles/uploadFileTracked/downloadFileTracked/deleteFile/mkdir` 与传输事件。
- Produces: 多文件/多目录选择、拖拽上传、复制/剪切/粘贴、重命名、移动、新建文件、文本编辑、预览、最近路径、收藏路径、批量下载/删除和递归传输。

- [ ] **Step 1: 为路径规范化、批量选择和收藏/最近路径写失败测试**。
- [ ] **Step 2: 运行对应 Vitest 确认测试因导出不存在而失败**。
- [ ] **Step 3: 先实现前端路径状态和选择模型，继续兼容旧上传/下载命令**。
- [ ] **Step 4: 再为后端新增命令逐个加 Rust 测试与前端服务方法，所有危险删除动作继续确认**。
- [ ] **Step 5: 用真实返回值更新传输抽屉；无法取得真实进度时显示不确定进度**。
- [ ] **Step 6: 运行前端测试、Rust 测试和构建后提交**。

### Task 6: 补齐无线调试与多设备批量能力

**Files:**
- Modify: `src/pages/Adb.tsx`
- Create: `src/lib/wirelessDebug.ts`
- Test: `src/lib/wirelessDebug.test.ts`
- Modify: `src/pages/Devices.tsx`
- Create: `src/components/device/BatchCommandDrawer.tsx`
- Test: `src/components/device/BatchCommandDrawer.test.tsx`
- Modify: `src/services/deviceService.ts`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/services/adb.rs`

**Interfaces:**
- Consumes: 现有 ADB 连接、批量动作、设备多选和状态反馈。
- Produces: Android 无线调试配对码/QR、mDNS 发现、USB 切 TCP/IP、保存地址批量重连与并发控制、批量镜像/推送/多 APK、广播输入。

- [ ] **Step 1: 为配对地址校验、并发队列和取消行为写失败测试**。
- [ ] **Step 2: 运行测试确认失败**。
- [ ] **Step 3: 实现不会泄漏配对码的前端状态模型和有限并发队列**。
- [ ] **Step 4: 接入平台支持检查；不支持的命令显示真实原因并保持其他 ADB 功能可用**。
- [ ] **Step 5: 运行 ADB 页面、设备批量页面和主项目全量测试后提交**。

### Task 7: 补齐录制、摄像头、OTG、音量/旋转/电源、应用快捷选择器

**Files:**
- Modify: `src/components/device/DeviceControlPanel.tsx`
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/services/deviceService.ts`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/services/scrcpy.rs`
- Modify: `src-tauri/src/services/device.rs`
- Test: `src/lib/deviceActions.test.ts`

**Interfaces:**
- Consumes: 独立 scrcpy 生命周期、设备控制入口和现有错误反馈。
- Produces: 普通/音频/摄像头录制、摄像头切换与参数、OTG、UHID、音量、旋转模式、熄屏/重启/精细电源控制、快速应用选择器和新显示屏启动。

- [ ] **Step 1: 为能力参数校验和返回失败状态写测试**。
- [ ] **Step 2: 运行测试确认失败**。
- [ ] **Step 3: 只在后端确认支持后显示可操作按钮，录制格式和时长在前后端同时校验**。
- [ ] **Step 4: 对独立 scrcpy 子进程增加清晰的生命周期状态和可重试操作，不嵌入 WebView**。
- [ ] **Step 5: 运行前端测试、Rust 测试、构建和至少一次 Tauri 开发启动验证**。

### Task 8: 参数设置、快捷键、更新中心和最终验收

**Files:**
- Modify: `src/pages/Settings.tsx`
- Create: `src/components/settings/ScrcpyPresetForm.tsx`
- Create: `src/components/settings/ShortcutSettings.tsx`
- Create: `src/pages/UpdateCenter.tsx`
- Modify: `src/App.tsx`
- Modify: `src/i18n/pages/settings.ts`
- Modify: `src/i18n/pages/common.ts`
- Modify: `src/styles/global.css`
- Test: `src/components/settings/ScrcpyPresetForm.test.tsx`
- Test: `src/components/settings/ShortcutSettings.test.tsx`

**Interfaces:**
- Consumes: `AppSettings`、现有 scrcpy 自定义参数字段和 Tauri 版本信息。
- Produces: 可视化 scrcpy 分类配置、全局快捷键界面、独立更新/下载/文档入口，并保留自定义参数兼容输入。

- [ ] **Step 1: 为参数序列化、快捷键冲突和更新状态写失败测试**。
- [ ] **Step 2: 运行测试确认失败**。
- [ ] **Step 3: 实现可视化表单并把结果转换回现有参数格式，未知参数保留在高级输入中**。
- [ ] **Step 4: 添加更新中心的版本检查状态；没有更新服务时明确显示“暂未配置更新源”，不伪造下载成功**。
- [ ] **Step 5: 运行 `npm test`、`npm run build`、Rust 测试，并检查 `git diff --check`**。
- [ ] **Step 6: 提交最终阶段并按文件级功能清单验收**。

## 运行与验收命令

```bash
npm test
npm run build
git diff --check
```

若涉及 Rust 命令，再运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

