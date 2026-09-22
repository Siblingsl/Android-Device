# E-053 — guest 侧受保护核心 RAM 暂存与最终复验

**日期**：2026-09-20  
**范围**：qemu-center 首启/恢复置备、Tauri 受保护 preset 上传、发布构建扫描  
**目标**：避免服务端下发的 runner 因异常退出而长期残留在 guest 的持久化 home 卷，同时保留现有执行授权和逐操作清理边界。

## 变更

- `qemu-center/src/cloudinit.rs` 的首启脚本创建 `/run/rdc-presets`，所有者为
  `rdc:rdc`，权限为 `0700`。
- `qemu-center/src/guest.rs` 的恢复置备脚本执行同样的目录初始化，覆盖已有节点的
  recovery 路径。
- `src-tauri/src/services/qemu_presets.rs` 将受保护 runner 和 grant 的远程 staging
  路径从 `/home/rdc/.cache/rdc-presets/<job>` 改为 `/run/rdc-presets/<job>`；每次
  上传前还会通过现有 SSH 管理通道补建并锁定父目录，兼容已经创建的节点。
- 每个操作结束时原有的 per-operation 删除仍保留；本改动不把 guest 中执行所需的
  明文误称为不可提取的密钥材料。

## TDD 证据

先加入三个失败断言，再实现最小改动。失败阶段分别观察到：

- cloud-init 渲染测试缺少 `install -d -o rdc -g rdc -m 700 /run/rdc-presets`；
- recovery provision 渲染测试缺少同一目录初始化命令；
- Tauri staging 测试缺少 `GUEST_CORE_ROOT` 常量。

实现后 focused 测试通过：

```text
cloudinit::tests::user_data_contains_hostname_and_user ... ok
guest::tests::provision_script_has_binder_docker_and_marker ... ok
services::qemu_presets::tests::protected_runner_stages_in_guest_runtime_directory ... ok
```

## 最终自动化门禁

- `npx tsc --noEmit`：通过。
- `npx vitest run`：60 个测试文件、459 个用例通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：284 通过、1 忽略、0 失败。
- `cargo test --manifest-path qemu-center/Cargo.toml`：库 213 通过、CLI 6 通过。
- `cargo test --manifest-path authorization-service/Cargo.toml`：库 22、管理工具 2、启动配置 2、集成 3 全部通过。
- `python -m unittest src-tauri/src/services/test_qemu_guest.py`：17/17 通过。
- `git diff --check`：通过。

## 发布验证

- `cargo build --release --manifest-path src-tauri/Cargo.toml`：通过。
- `cargo build --release --manifest-path qemu-center/Cargo.toml`：通过。
- `scripts/verify-release-core.ps1` 对两个 release 二进制均返回 `clean`，未发现受保护
  runner 正文标记。

## 安全边界与未完成项

`/run` 是 guest 的运行时文件系统，因此能降低异常退出后在持久化 qcow2/home 卷中
留下核心明文的风险；VM 重启后该目录不应从持久化盘恢复。但 runner 在合法操作期间
仍需以明文存在，拥有 guest root、宿主管理员权限或调试能力的攻击者仍可能读取它。
设备私钥证明、短时 execution grant、一次性 JTI 和服务端执行高价值算法仍是必要边界。

本证据覆盖代码渲染、上传路径、自动化测试和 release 扫描，不替代真实 Tauri 窗口、
真实 QEMU 节点上的登录/浏览/30 分钟稳定性，以及跨机器复制、断网、撤销和密钥轮换
人工走查。现有 `node1` 未被本轮改写；运行态结果仍以 P7 人工清单为准。
