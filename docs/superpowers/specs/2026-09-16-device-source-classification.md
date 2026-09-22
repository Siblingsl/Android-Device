# 设备来源分类修复

## 背景

设备中心当前把所有未匹配 Docker 容器的 ADB 行标记为 `source=adb`，前端又把该来源翻译成“真机”。这会把 Android Emulator、Redroid，以及与 QEMU 实例重复出现的普通 ADB 行错误显示成真机。

## 目标

- QEMU 实例优先保留 `source=qemu`，不能被同序列的普通 ADB 行抢占。
- 能从 ADB 设备元数据稳定识别的 Android Emulator 标记为 `source=emulator`。
- 能从 ADB 设备元数据识别的 Redroid 标记为 `source=redroid`。
- 未知的普通 ADB 来源显示为“ADB设备”，不再宣称是真机。
- 已知虚拟来源不计入“实体/ADB设备”筛选。

## 非目标

- 不通过启发式把所有未知 ADB 设备强行判断为实体真机。
- 不改变 Docker / QEMU 的控制命令、连接方式或设备序列号。
- 不修改 QEMU 磁盘、运行中的节点或容器状态。

## 方案

1. 后端统一来源常量扩展为 `docker`、`qemu`、`emulator`、`redroid`、`adb`。
2. `DeviceInfo` 在构造时根据 ADB serial、model、product 识别 `emulator-*` 和包含 `redroid` 的设备；识别结果在 unified 层转换为来源。
3. unified 合并先建立 QEMU serial 集合；普通 ADB 行若与 QEMU serial 重合则丢弃，Docker 容器行仍保留原有优先级。
4. 前端为新来源提供来源徽标，并把原“真机”文案改成“ADB设备”；云机筛选包含 QEMU、Docker、Redroid、模拟器。

## 验收

- 回归测试证明 `emulator-5554` 不会得到 `adb`/“真机”来源。
- 回归测试证明 `redroid_x86_64` 不会得到 `adb`/“真机”来源。
- 回归测试证明与 QEMU 相同 serial 的普通 ADB 行不会覆盖 QEMU 行。
- 前端测试证明模拟器和 Redroid 显示非“真机”徽标并进入云机筛选。
- 全量 TypeScript、Vitest、两套 Rust 测试及构建通过。
- 实际界面刷新后的视觉效果仍需人工确认。
