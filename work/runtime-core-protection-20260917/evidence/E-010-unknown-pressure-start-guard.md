# E-010 — Unknown-pressure start guard

日期：2026-09-17  
范围：运行时启动调度与缺失资源指标的安全语义。

## 根因

资源探针失败时，`runtime_request_start` 使用默认空快照；空快照会被正确
分类为 `unknown`，但旧启动条件只拦截 `critical`，因此多个并发请求可能在
没有可用内存指标时同时进入启动路径。

## 修复与验证

- 保留显式单实例启动：`unknown` 且没有其他启动任务时仍允许用户继续，页面
  同时显示未知压力状态。
- 拦截未知状态下的批量并发启动：调度器锁内检查其他正在启动或排队的实例，
  避免两个请求都在检查前看到“没有任务”而同时放行。
- `critical` 仍无条件阻止；`caution` 保持现有调度语义。
- 先运行新增测试时按预期失败：`should_block_runtime_start` 尚不存在。
- 修复后聚焦测试通过：

  `cargo test --manifest-path src-tauri/Cargo.toml commands::tests::unknown_pressure_blocks_only_batch_runtime_starts -- --exact`

## 边界

该护栏只约束后端启动并发度，不替代人工内存矩阵；真实 lean/standard/full
启动、登录、连续浏览和 30 分钟稳定性仍需在复制实例上人工确认。
