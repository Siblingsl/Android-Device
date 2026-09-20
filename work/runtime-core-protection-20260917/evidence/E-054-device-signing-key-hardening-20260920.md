# E-054 — Windows device-signing-key hardening

**日期**：2026-09-20
**范围**：Tauri device signer、authorization client、Settings security status
**目标**：让新 Windows 安装优先使用不可导出的 CNG ECDSA P-256 私钥，同时保留已有 DPAPI/Ed25519 身份的兼容路径，并把降级级别明确展示出来。

## 实现边界

- 新安装在生产授权客户端中优先创建用户范围的 Microsoft Platform Crypto
  Provider `ECDSA_P256` named key；客户端只导出并登记 SEC1 `04 || X || Y`
  公钥，不读取私钥材料。
- CNG 签名对 canonical payload 做 SHA-256 后调用 `NCryptSignHash`，服务端按注册时
  保存的 `client_key_algorithm` 选择 Ed25519 或 ECDSA P-256 验证器。
- 已有 DPAPI/Ed25519 元数据不迁移、不旋转，仍按旧算法使用；CNG 元数据记录 key name
  和公钥，若公钥不匹配或 CNG key 丢失则拒绝继续，不静默换绑。
- 安全级别只输出 `hardware_backed`、`cng_software_provider` 或
  `dpapi_software_fallback`；状态接口不输出私钥、DPAPI 明文、CNG handle 或核心明文。
- `RDC_REQUIRE_HARDWARE_BACKED_KEYS=1` 开启严格策略；无法确认硬件隔离时返回策略错误，
  不静默降级。当前 Windows 绑定未提供专用 VBS 创建 flag，硬件/TPM 事实仍须人工验收。

## TDD 与测试证据

RED 阶段先观察到 CNG 类型、算法依赖和解析器均不存在；实现后：

```text
cargo test --manifest-path src-tauri/Cargo.toml services::secure_store
11 passed, 0 failed

cargo test --manifest-path src-tauri/Cargo.toml services::authorization_client
18 passed, 0 failed

npx vitest run src/pages/Settings.test.tsx --maxWorkers=1 --minWorkers=1
7 passed, 0 failed

npx tsc --noEmit
passed
```

显式启用 Windows provider 探针后，创建、签名并删除一次性用户 key：

```text
$env:RDC_RUN_CNG_PROVIDER_TESTS = "1"
cargo test --manifest-path src-tauri/Cargo.toml services::secure_store -- --ignored
1 passed, 0 failed
```

该探针最初暴露 Platform Crypto Provider 返回 `NTE_NOT_SUPPORTED` 的实现类型属性；
现在将其安全分类为“CNG 软件提供者”，不会误报硬件隔离，也不会阻止宽松策略的正常签名。

## 全量与发布验证

本轮还完成了以下自动化验证：

```text
python -m unittest src-tauri/src/services/test_qemu_guest.py
17 passed, 0 failed

npx vitest run --maxWorkers=1 --minWorkers=1 --reporter=verbose
60 files, 460 tests passed

cargo test --manifest-path qemu-center/Cargo.toml
213 library tests + 6 CLI tests passed

cargo build --release --manifest-path src-tauri/Cargo.toml
cargo build --release --manifest-path qemu-center/Cargo.toml
both release builds passed

scripts/verify-release-core.ps1
redroid-device-center.exe: clean
qemu-center.exe: clean
```

Tauri 全量测试为 293 passed、1 failed、2 ignored；唯一失败是已有的 Windows
PowerShell/ConPTY 往返测试 `services::terminal::tests::local_pty_round_trips_input_and_cleans_up`，
输出只有终端初始化控制序列，未涉及本次授权或 CNG 改动。它应作为环境不稳定项单独处理，
不能宣称主程序全量测试已完全通过。

## 未完成的人工验收

- TPM/VBS 是否实际提供硬件隔离：需在目标生产 Windows 设备核对 provider implementation
  flags，不能由本机软件测试代替。
- 新旧安装升级、跨 Windows 用户/机器复制、CNG key 删除/轮换、严格策略下的生产账号审批
  需要人工演练。
- guest 运行时仍必须暂时持有下发核心的明文；拥有 guest root、宿主管理员或调试能力的
  攻击者仍可能在合法运行期间读取它。最高价值算法和最终授权判定仍应留在服务端。

本轮没有启动、停止或修改 `node1`、qcow2 或任何真实 QEMU 运行态。
