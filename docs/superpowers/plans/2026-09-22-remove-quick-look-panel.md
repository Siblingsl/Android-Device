# Quick look 浮动详情移除实施计划

**目标：** 删除全局 Quick look 抽屉而不影响设备正式详情页。

1. 在 `tests/signalDeskLayout.test.ts` 添加失败契约，覆盖 AppLayout 挂载、store/preview 状态、组件文件、专用 CSS/翻译。
2. 删除挂载、状态、preview 特判、组件文件和专用 CSS/翻译；保留 DeviceDetail 详情页代码。
3. 运行定向测试，再运行 TypeScript、全量 Vitest、两套 Rust 测试。
