# 设备应用导出 APK 实施计划

## 阶段 1：回归测试（先红）

1. 为应用列表增加导出成功路径测试，要求保存对话框和现有下载服务收到正确参数。
2. 增加导出取消静默测试，确保不调用下载服务、不弹错误。
3. 运行 DeviceDetail 定向测试，确认当前菜单没有导出选项而失败。

## 阶段 2：最小前端实现

1. 增加导出状态和导出处理函数。
2. 在“更多”菜单加入导出选项，使用 APK 文件过滤器和安全默认文件名。
3. 复用文件页已使用的 `DeviceService.downloadFileTracked`，直接把设备端 APK 下载到用户选定的文件路径，避免普通下载封装的临时目录移动问题。
4. 补齐中英文状态文案。

## 阶段 3：完整验证

1. `npx tsc --noEmit`
2. `npx vitest run`
3. `npm run build`
4. `cargo test --manifest-path src-tauri/Cargo.toml`
5. `cargo test --manifest-path qemu-center/Cargo.toml`
6. `git diff --check`

不改后端；实际设备权限和导出结果待人工在已连接设备上确认。
