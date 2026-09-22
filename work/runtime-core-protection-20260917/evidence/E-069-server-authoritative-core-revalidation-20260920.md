# E-069 — 服务端核心下发链路复验

**日期**：2026-09-20  
**状态**：自动化复验通过；生产部署、跨设备复制和真实 Tauri 走查仍待人工  
**范围**：授权服务、guest runner、发布产物明文扫描

## 本轮复验

| 检查 | 结果 |
|---|---|
| `cargo test --manifest-path authorization-service/Cargo.toml` | 通过：23 个库测试、2 个管理工具测试、2 个启动配置测试、4 个协议集成测试；0 失败 |
| `python -m unittest src-tauri/src/services/test_qemu_guest.py` | 通过：21 个测试；0 失败 |
| `scripts/verify-release-core.ps1` | 通过：`redroid-device-center.exe`、桌面 DLL、`rdc-mcp.exe`、`qemu-center.exe` 均返回 `clean` |

## 这组证据实际证明的边界

- 授权服务仍拒绝未知 artifact/workflow 组合、错误设备证明、重放 nonce、撤销会话和错误版本；加密 artifact 仍绑定签名 manifest。
- guest runner 仍在执行票据消费、签名 receipt/授权 marker 和 Docker 前置校验路径上工作；负向测试覆盖拒绝和不执行副作用。
- 当前四个 release 产物不包含受保护 runner 的源码标记，发布版不依赖本地明文核心才能通过扫描。

## 尚未由本证据证明

- 生产 HTTPS、账号审批、secret manager、真实签名密钥轮换和跨设备复制演练。
- guest 运行时明文无法被 root/宿主机管理员/调试器观察；这仍是系统无法完全消除的残余边界。
- 小红书登录、连续浏览和 30 分钟内存稳定性；这些属于 P7-1/运行时人工验收。
