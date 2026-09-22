# E-034 — full profile admission guard

日期：2026-09-18

## 目的

E-033 的真实采样显示，full `r13` 在 4096 MiB 节点上达到约 3060/3072 MiB
容器内存，并把主机可用内存压到约 0.356 GiB。本证据确认新建路径不会再把
同一高风险组合当作默认可用配置。

## 变更

- `qemu-center::redroid::resolve_instance_resources` 在 Docker 创建前拒绝
  `full + node_mem_mib < 6144`，返回明确的最小节点内存提示。
- 6144 MiB 及以上仍按 profile 映射计算资源；4 GiB 节点的 lean/standard 映射
  不变。
- QEMU 桌面创建表单复用同一 6144 MiB 边界：低于边界时禁用 full 选项并说明
  应选择 lean/standard 或更大节点；后端仍是最终护栏。
- 现有节点、容器、磁盘和运行状态没有被修改；这是新建 admission guard，
  不是在线缩容。

## TDD 与验证

先加入失败测试：

```text
full_profile_is_rejected_on_a_four_gib_node
runtimeProfileAvailable("full", 4096) == false
```

失败结果分别是后端仍返回 `(2.0, 3072)`，以及前端 helper 尚不存在。

实现后 focused 测试通过：

```text
qemu-center: 2 full-profile tests passed
runtimeProfile + i18n: 9 tests passed
```

完整门禁：

```text
npx tsc --noEmit                          PASS
npx vitest run                            60 files / 458 tests PASS
cargo test --manifest-path src-tauri/...  271 passed / 1 ignored PASS
cargo test --manifest-path qemu-center/... 213 library + 6 CLI PASS
cargo test --manifest-path authorization-service/... 17 + 2 + 3 PASS
cargo fmt --manifest-path qemu-center/... -- --check PASS
git diff --check                          PASS
```

这些测试不启动 live QEMU；3072/4096 MiB 的真实登录、浏览和稳定性矩阵仍需
人工在复制实例上完成。
