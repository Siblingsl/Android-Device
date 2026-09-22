# E-004 — Validation record

最终自动化结果（2026-09-17）：命令必须在仓库根目录执行。

```text
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
cargo test --manifest-path authorization-service/Cargo.toml
git diff --check
```

结果：

- `npx tsc --noEmit`：通过。
- `npx vitest run`：60 个文件、453 个用例通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：258 通过、1 个既有测试忽略、0 失败。
- `cargo test --manifest-path qemu-center/Cargo.toml`：197 个库测试 + 5 个命令行测试通过、0 失败。
- `cargo test --manifest-path authorization-service/Cargo.toml`：14 个单元测试 + 2 个集成测试通过、0 失败。
- `npm run build`：通过（1850 个模块）；仅有既有单 chunk 体积警告（约 1.02 MB），不是构建错误。
- 应用级暂停安全测试：包名校验与 QEMU 三元映射校验通过；QEMU 页面用例 28 个通过。
- 启动调度测试：6 个 runtime scheduler 用例通过，覆盖 FIFO 提升、成功/失败后的释放、重复请求抑制和应用包名边界。
- `cargo check --manifest-path src-tauri/Cargo.toml --release`：通过，release 构建不存在本地核心脚本回退。
- `cargo build --manifest-path src-tauri/Cargo.toml --release`：通过（2026-09-17，本轮约 5 分 05 秒）。对生成的 `redroid-device-center.exe` 做二进制字符串检查：未发现 `qemu_guest.py` 的脚本正文标记（`Node-side preset runner`、`import http.client`、`def main(`、`#!/usr/bin/env python3`、`__RDC_QEMU_GUEST`）；命中的文件名/错误文案仅证明运行时路径，不是脚本内容嵌入。
- `git diff --check`：通过；仅有 Git 的换行符提示。

- E-006 安全代码审查：发现并修复已有客户端注册在 proof-of-possession 之前
  修改版本/撤销会话的问题；semgrep 不在环境中，已用限定范围检索、人工数据
  流核验和新增回归测试完成替代审查。

人工待确认：QEMU 3072 MiB 冷/热启动矩阵、真实授权服务 TLS/账号部署、断网与撤销演练、登录浏览稳定性和视觉观感。
