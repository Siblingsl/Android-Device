# E-025 — 实例 cgroup 饱和度提示

日期：2026-09-17

## 目的

避免把主机可用内存“正常”和单个 redroid 容器已经接近自身 cgroup 上限混为一谈。

## 实现

`src/lib/runtimeProfile.ts` 新增无副作用的 `runtimeMemoryPressure(current, limit)`：

- 小于 75%：`normal`；
- 75% 至 90% 以下：`caution`；
- 达到 90%：`critical`；
- 缺失、负数、非有限值或无效上限：`unknown`。

QEMU 页面在资源摘要和实例表中展示该状态；出现 `caution`/`critical` 时提示优先
暂停应用或新建 `lean`/`standard` 实例，不会在线修改现有容器限制。

## 验证

- TDD focused test 首次因分类器不存在而失败；实现后 6 个
  `runtimeProfile` tests 通过。
- `src/pages/QemuCenter.test.tsx` 新增界面回归：实例达到 90% cgroup 上限时显示
  “实例接近上限”和处理建议；QEMU 页面测试 30/30 通过。
- `npx tsc --noEmit`：通过。
- `npx vitest run`：60 文件 / 457 用例通过。
- `git diff --check`：通过（仅既有 LF/CRLF 转换提示）。
