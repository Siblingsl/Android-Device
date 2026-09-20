# E-056 — 最终门禁与 Windows PTY 修复

**日期**：2026-09-20
**范围**：Windows 本地 PowerShell PTY、全仓库自动化门禁、Release 核心扫描

## 根因与修复

Tauri 全量测试唯一失败项是
`services::terminal::tests::local_pty_round_trips_input_and_cleans_up`。在本机继承
`TERM=dumb` 时，Windows PowerShell/ConPTY 只输出初始化控制序列，未进入可读命令状态；
同一测试在清除 `TERM` 后立即通过。

修复位于 `src-tauri/src/services/terminal.rs`：仅对 Windows `local` PowerShell 子进程
移除继承的 `TERM`，不改变设备 ADB shell，也不改变 PTY 输入协议。

## 最终自动化结果

```text
npx tsc --noEmit
passed

npx vitest run --maxWorkers=1 --minWorkers=1
60 files, 460 tests passed

cargo test --manifest-path src-tauri/Cargo.toml
294 passed, 0 failed, 2 ignored

cargo test --manifest-path qemu-center/Cargo.toml
213 library tests + 6 CLI tests passed

cargo test --manifest-path authorization-service/Cargo.toml
23 library + 2 admin + 2 main + 3 integration passed

python -m unittest src-tauri/src/services/test_qemu_guest.py
17 passed

cargo build --release --manifest-path src-tauri/Cargo.toml
cargo build --release --manifest-path qemu-center/Cargo.toml
passed

scripts/verify-release-core.ps1
redroid-device-center.exe: clean
qemu-center.exe: clean

git diff --check
passed
```

本轮未启动或停止 `node1`，未修改 qcow2；`target-codex-*` 仅为验证构建目录。
