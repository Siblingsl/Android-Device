# 变更记录

本文件记录用户可见的新增、修复、限制和升级注意事项。未验证的能力必须写入限制，而不是写入“已支持”。

## [Unreleased]

### 计划

- 完成 Windows x64 Beta 的干净机器安装记录、演示素材和发布门。
- 完善 Docker 与 QEMU/WHPX 的首次启动环境引导。

### 已知限制

- 首个公开 Beta 以 Windows x64 为目标；Windows ARM64 和 macOS 为实验性范围。
- 当前 GApps 资产目标为 Android 13 x86_64，不能用于 Android 14。
- Shamiko 在部分 Redroid 环境中可能报告不支持。
- 视觉、真机和干净 Windows 结论以 `docs/qa/` 的人工记录为准。

## [0.1.0 Beta] — 未发布

这是当前开发基线，不代表已经完成公开发布门。公开发布前必须补齐安装包、校验和、Release Notes、兼容性证据和真机走查。

### 已有能力

- Docker 轨道的 Redroid 实例、数据卷、ADB、APK、日志和设备控制。
- QEMU/WHPX 节点轨道、节点内 Redroid 实例、预装、升级和恢复。
- 合并的“容器与节点”入口、轨道切换和只读对比视图。

### 发布前仍需验证

- 干净 Windows x64 安装和首台设备路径。
- Windows x64 安装包的签名状态、升级策略和回滚记录。
- P7-1 页面合并真机人工走查。
