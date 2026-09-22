# E-027 授权服务回环监听护栏

**日期**：2026-09-17  
**范围**：`authorization-service` 启动配置  
**结论**：自动化通过；生产 TLS 边缘和部署拓扑仍需人工确认

## 目的

授权服务自身提供明文 HTTP，生产 TLS 由同机受管反向代理终止。为了避免误配置
`RDC_AUTH_BIND=0.0.0.0:8787` 直接暴露租约、manifest 和加密分块接口，服务在
`TcpListener::bind` 前只接受字面量回环地址。

## 实现

- `127.0.0.1:8787` 和 `[::1]:8787` 通过；
- 通配地址、局域网/公网地址和 `localhost:8787` 等主机名拒绝；
- 没有明文公网监听旁路开关；跨容器部署需另行评审内部 TLS 或 Unix socket；
- 失败信息只说明配置错误，不包含签名私钥、数据库或 artifact 内容。

## TDD 与验证

1. 先添加两个启动配置测试；首次运行因 `validate_loopback_bind` 不存在而编译失败。
2. 添加纯函数和 `main` 启动前校验后，两个测试均通过：

```text
tests::accepts_literal_loopback_socket_addresses ... ok
tests::rejects_non_loopback_and_hostname_bindings ... ok
```

3. `cargo test --manifest-path authorization-service/Cargo.toml`：
   - 16 个库测试通过；
   - 2 个启动配置测试通过；
   - 2 个协议集成测试通过；
   - 0 失败。
4. `cargo fmt --manifest-path authorization-service/Cargo.toml -- --check`：通过。
5. Release 二进制使用隔离假配置 `RDC_AUTH_BIND=0.0.0.0:8787` 启动：在打开
   数据库或监听器前返回配置错误，退出码为 `1`；对应的临时 SQLite 文件未被创建。

## 未覆盖边界

本证据不替代真实生产反向代理、TLS 1.3、密钥托管、账号审批、撤销和轮换演练。
