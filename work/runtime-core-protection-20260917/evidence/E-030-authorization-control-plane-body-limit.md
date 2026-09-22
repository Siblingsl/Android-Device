# E-030 — authorization-service 控制面请求体护栏

日期：2026-09-18

## 目的

补齐授权服务的内存与输入边界：`/v1` 只接收小型 JSON 控制请求，artifact
内容仍通过既有加密分块响应交付。超大请求不应进入 JSON 解析、数据库访问或
transfer 创建路径。

## TDD 证据

1. 先加入 `routes::tests::control_plane_request_body_limit_is_enforced`。
2. 未实现边界时测试失败：请求进入 handler 并返回 `400`，预期为 `413`。
3. 在 `/v1` router 增加 Axum `DefaultBodyLimit::max(64 * 1024)`。
4. focused test 通过，返回 `413 Payload Too Large`。

## 实现边界

- 文件：`authorization-service/src/routes.rs`
- 上限：`64 KiB`
- 影响：注册、session、heartbeat、artifact prepare 等 JSON 控制请求
- 不影响：artifact 256 KiB 加密分块下载；没有客户端离线回退
- 失败位置：JSON extractor/业务逻辑之前

## 验证结果

- `cargo test --manifest-path authorization-service/Cargo.toml`：17 个库测试通过
- 授权服务启动配置测试：2 个通过
- 协议集成测试：2 个通过
- `npx tsc --noEmit`：通过
- `npx vitest run --reporter=dot`：60 个文件 / 457 个用例通过
- `cargo test --manifest-path src-tauri/Cargo.toml`：271 通过 / 1 忽略
- `cargo test --manifest-path qemu-center/Cargo.toml`：211 个库测试 + 6 个 CLI 测试通过
- 三个 Rust crate `cargo fmt -- --check`：通过
- `git diff --check`：通过；仅有既存的 LF/CRLF 转换提示

本项没有启动 QEMU、修改 qcow2、上传 artifact 或变更生产服务配置。
