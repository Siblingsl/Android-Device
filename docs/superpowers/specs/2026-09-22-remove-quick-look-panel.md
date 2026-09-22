# Quick look 浮动详情移除方案

## 目标

移除设备列表全局悬浮 Quick look 抽屉及右下角收起/展开按钮，保留 `/devices/:id` 正式详情页和列表内已有“详情”入口。

## 根因/范围

`DetailPanel` 由 `AppLayout` 全局挂载，状态由 `appStore.detailOpen` 持久化，CSS 与翻译专门服务该抽屉。它是冗余快捷摘要，不是设备运行链路依赖。

## 方案

- 删除 `DetailPanel` 挂载和组件文件。
- 删除 `detailOpen` 状态、持久化 setter、preview 特判。
- 删除仅供 Quick look 使用的 CSS 与翻译；保留 DeviceDetail 的 `.detail-*` 样式和通用设备字段翻译。
- 保留 `/devices/:id` 正式详情页。

## 验收

- 全局壳层不再渲染 Quick look 和右下角上箭头。
- `/devices/:id` 入口仍可用。
- TypeScript、Vitest、两套 Rust 测试全绿；真实 Tauri 视觉需人工确认。
