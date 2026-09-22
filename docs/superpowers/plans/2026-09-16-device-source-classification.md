# 设备来源分类修复实施计划

## 阶段 1：回归测试（先红）

1. 在 `src-tauri/src/services/unified.rs` 增加 ADB 设备分类测试：emulator serial、Redroid model/product、未知 ADB。
2. 增加 QEMU 与普通 ADB 同 serial 时的合并优先级测试。
3. 在 `src/pages/Devices.test.tsx` 增加模拟器与 Redroid 徽标及筛选行为测试。
4. 运行对应 Rust/Vitest 定向测试，确认失败原因正是缺少新分类行为。

## 阶段 2：最小实现

1. 扩展 Rust 来源常量和分类函数，使用已有 `AdbDevice` 的 serial/model/product 信息。
2. 在 unified 合并处让 QEMU serial 覆盖普通 ADB 重复行。
3. 扩展前端来源徽标、云机判定和中英文文案；未知来源只显示 ADB设备/ADB device。
4. 运行定向测试并修正实现，不顺带重构无关代码。

## 阶段 3：完整验证

1. `npx tsc --noEmit`
2. `npx vitest run`
3. `cargo test --manifest-path src-tauri/Cargo.toml`
4. `cargo test --manifest-path qemu-center/Cargo.toml`
5. `npm run build`

完成后报告代码验证结果，并把界面刷新后的人工确认标为待确认。
