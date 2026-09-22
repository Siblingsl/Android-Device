# Dashboard 响应式宽度实施计划

**目标：** 让 Dashboard 在窗口放大时占满内容区域，消除固定最大宽度造成的大面积空白。

**范围：** 只修改 `src/styles/global.css` 的共享容器变量，并在 `tests/signalDeskLayout.test.ts` 增加 CSS 契约测试；不改后端和组件 DOM。

1. 在布局测试中断言 `--content-max: 100%`，先确认当前 1800px 上限 CSS 失败。
2. 将共享容器宽度替换为 `100%`，保留现有内边距和响应式断点。
3. 运行布局回归、TypeScript、Vitest 及项目要求的两套 Rust 测试；视觉尺寸由用户在真实 Tauri 窗口确认。
