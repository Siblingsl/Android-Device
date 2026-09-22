# E-038 — Release authorization configuration

日期：2026-09-18

## 目的

确认 Windows desktop release 不会在缺少授权服务配置时产出一个“没有本地核心、
合法用户也无法下载核心”的不可用构建，同时不把服务端签名私钥带入桌面构建。

## 变更

- `.github/workflows/windows-release.yml` 将 `RDC_AUTH_BASE_URL` 与
  `RDC_AUTH_PUBLIC_KEYS` 作为 GitHub Actions repository variables 注入 job 环境。
- Tauri 编译前新增 preflight：任一变量为空即失败；若检测到
  `RDC_AUTH_SIGNING_KEY` 则同样失败。
- `authorization-service/README.md` 与验收文档同步说明变量契约。

## 验证

- 静态检查确认 workflow 只引用 `vars.RDC_AUTH_BASE_URL`、
  `vars.RDC_AUTH_PUBLIC_KEYS`；`RDC_AUTH_SIGNING_KEY` 只出现在“必须为空”的负向检查，
  没有作为 secret 注入或构建参数传递。
- `npx tsc --noEmit`：通过。
- `npx vitest run`：60 文件 / 458 用例通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：277 通过 / 1 忽略。
- `cargo test --manifest-path qemu-center/Cargo.toml`：213 个库测试 + 6 个 CLI 测试通过。
- 两个 crate `cargo fmt --check`：通过。
- `git diff --check`：通过；仅有工作区既有的 LF/CRLF 规范化警告。
- 使用测试用的非生产公开配置完成一次真实 release 编译：`cargo build --release
  --manifest-path src-tauri/Cargo.toml`，构建耗时 5 分 50 秒。
- 编译后的 `redroid-device-center.exe` 包含测试授权 URL/公钥环字符串，
  `redroid_device_center_lib.dll` 与主程序均不包含 `qemu_guest.py` runner body marker；
  `scripts/verify-release-core.ps1` 返回 clean。

## 边界

当前环境没有实际 GitHub Actions repository variables，也没有执行远程 release job；本地
编译使用的 URL/公钥仅为测试值，不能用于生产。
因此“变量已在仓库设置”和“生产 TLS/密钥轮换演练”仍需发布者在 CI 与真实授权服务上人工确认。
