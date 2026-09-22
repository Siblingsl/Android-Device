# E-044 授权服务真实进程冒烟验收（2026-09-18）

## 范围

使用当前 release 二进制启动独立的授权服务进程，临时 SQLite 数据库、临时 artifact 目录和临时 loopback 端口；未使用生产数据库、生产密钥、QEMU 节点或业务容器。

## 结果

- 服务以 `127.0.0.1:18787` 成功启动并监听。
- 未携带授权头请求 `GET /v1/capabilities` 返回 `401 Unauthorized`。
- 同一响应包含 `Cache-Control: no-store` 和 `Pragma: no-cache`。
- 将 `RDC_AUTH_BIND` 改为 `0.0.0.0:18788` 后，服务在监听前以退出码 `1` 拒绝启动，错误为 loopback bind guard。
- 服务进程已停止，临时数据库、日志和 artifact 目录已清理；当前没有残留授权服务进程。

## 限制

这只证明 release 进程的本机配置护栏和未授权拒绝路径，不等于生产 TLS、账号审批、密钥轮换、真实客户端注册或真实设备验收；这些仍需部署现场执行。
