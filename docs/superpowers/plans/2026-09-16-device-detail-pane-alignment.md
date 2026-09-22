# 设备详情双栏对齐实施计划

## 阶段 1：回归测试（先红）

1. 在 `tests/signalDeskLayout.test.ts` 增加详情双栏等高与 Root 操作行约束。
2. 运行定向布局测试，确认当前 `align-items: start` 和按钮换行规则使断言失败。

## 阶段 2：最小 CSS 修复

1. 将详情双栏 Grid 改为 stretch，让同一行卡片共享行高。
2. 让 Root 标题栏操作组单行布局，使用明确 gap、右对齐和横向容纳。
3. 保持断点和其他页面样式不变。

## 阶段 3：完整验证

1. `npx tsc --noEmit`
2. `npx vitest run`
3. `cargo test --manifest-path src-tauri/Cargo.toml`
4. `cargo test --manifest-path qemu-center/Cargo.toml`
5. `npm run build`

界面尺寸与按钮间距最终以人工刷新详情页确认。
