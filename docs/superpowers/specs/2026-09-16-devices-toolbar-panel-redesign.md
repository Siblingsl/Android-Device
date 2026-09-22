# 设备中心工具栏与网格视图重设计

## 背景

用户截图指出四处布局问题：

1. 默认工具栏（红框）：批量按钮被 `space-between` 拆散，主操作「批量投屏」夹在两组辅助按钮中间。
2. 「投屏布局」用 `<details>` 内联展开在第一行的 auto 列里，六个数字输入把筛选行挤成三行。
3. 「广播输入」用 `<details>` 内联展开在批量按钮行首位，把整排按钮推到右侧并换行。
4. 网格视图：卡片内容高度不一致，meta 单元格与操作行不对齐，长镜像串换行把卡片撑高。

## 方案

### 工具栏：行为分层 + 互斥面板

- 行 1（`.devices-toolbar-main`，2 列）：搜索 / 筛选 / 视图切换 + 全选操作。
- 行 2（`.devices-batch-rail`）：主操作组（批量连接 / 投屏 / 布局投屏 / 推送 / 装 APK）→ 工具组（截图 / 伪装 / 更多 / 快速启动 / 复制 Serial）→ 面板开关（固定最右，`margin-left: auto`）。
- 行 3（`.devices-toolbar-panel`）：广播输入、投屏布局、批量伪装三个可选面板共享的全宽容器，由
  `toolbarPanel` 状态互斥控制（`null | "broadcast" | "layout" | "spoof"`）。展开不再回流按钮行。
- `DeviceBroadcastInput` 增加 `variant="panel"`，只渲染字段主体，开关由页面持有。

### 网格卡片：共享内部轨道

- `.device-grid` 增加 `align-items: stretch` 与 `grid-auto-rows: minmax(min-content, auto)`，同排卡片等高。
- 卡片体改为 flex 列：信息块 `flex: 1 1 auto`，`.meta-grid` `margin-top: auto` 贴底，操作行固定在底部
  → meta 与按钮在整排卡片上处于同一水平线。
- `Meta` 改用 `.device-meta-label / .device-meta-value`，网格内值单行省略号截断，长镜像串不再撑高卡片。

## 验证

- `tests/signalDeskLayout.test.ts` 新增两条布局契约测试（面板共享行、网格内部轨道）。
- `npm run test` 442/442 通过，`tsc --noEmit` 通过。
- 视觉走查：`preview-devices.html`（mock Tauri 桥 + 真实组件）配合无头 Chrome 截图，覆盖
  列表 / 网格 / 三个面板共五种状态。

## 预览 harness

- 根目录 `preview-devices.html` + `src/preview-devices.tsx`：`window.__TAURI_INTERNALS__` 注入 mock，
  支持 `?view=cards|table` 与 `?panel=broadcast|layout|spoof`。仅开发预览用，不参与构建。
