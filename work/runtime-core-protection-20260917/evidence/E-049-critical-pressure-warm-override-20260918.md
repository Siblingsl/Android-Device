# E-049 — critical-pressure warm-node override

日期：2026-09-18

## 行为

已有配置可能显式保存 `runtimeKeepVmWarm=true`。为避免该历史偏好在主机临界内存时继续保留
QEMU 基座，闲置回收现在先读取只读主机压力：

- `normal` / `caution` / `unknown`：仍保持用户选择的温热节点；
- `critical`：将温热偏好临时覆盖为内存优先；停止目标容器后仍必须由新鲜只读列表证明没有其它
  `Up`/`running` 实例，才允许 `vm_stop`；状态未知、探针失败或其它实例运行时仍保持节点。

## TDD 与测试

- 先加入 `critical_pressure_overrides_warm_node_preference_but_unknown_does_not`，旧代码因缺失
  helper 无法编译，确认测试捕获了缺失行为。
- 实现 `keep_vm_warm_for_pressure` 和 `runtime_release_idle` 的主机压力读取后，focused test 通过。
- 设置页提示已说明 critical 压力下的自动释放。
- 串行 Tauri 全量测试随后通过：281 通过、1 忽略、0 失败。

该策略不承诺固定节省多少 GB；实际回收量仍需在真实节点上按验收矩阵采样。
