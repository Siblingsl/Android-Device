# E-062 — qemu-center CLI capability gate

日期：2026-09-20

## 问题

桌面端的 QEMU 创建入口已经在 Tauri Rust 层取得服务端核心和 execution grant，
但独立 `qemu-center redroid create` 仍可以直接执行 guest Docker 创建。它不是核心
脚本的复制路径，却留下了一个低层创建绕过面。

## 修复

- `redroid create` 现在必须提供 `--execution-grant-file`；缺失时在任何 guest Docker
  命令前失败。
- qemu-center 在构建时读取 `RDC_AUTH_PUBLIC_KEYS`，解析公钥信任环并校验服务端
  Ed25519 签名、`device_proof` 存在性、issuer/audience、有效期、`preset_apply` 动作、
  VM/实例绑定和 64 位十六进制 artifact hash。
- Tauri 在 `activate` 阶段提前取得当前独立 grant，将 JSON 仅写入 job 临时目录，
  通过文件路径调用 qemu-center；grant 内容不进入进程命令行或普通日志，操作结束后删除。
- guest runner 仍使用同一 grant 做设备私钥证明和服务端一次性 JTI 消费；CLI 校验是
  纵深防御，不能替代 guest/server 的最终授权。
- Windows release workflow 先用公钥环构建 qemu-center，并把它作为
  `resources/qemu-center/qemu-center.exe` 打入安装包；发布核心扫描同时覆盖该二进制。

## 自动化证据

- qemu-center：215 个库测试 + 12 个 CLI 测试通过。
- 新增测试覆盖：缺失 grant、轮换公钥、VM/实例错绑、签名篡改、未知 key id。
- Tauri focused 测试覆盖：grant 文件路径参数、grant JSON 暂存和不把 token 放进 argv。
- Tauri 资源定位测试覆盖：安装包 `resources/qemu-center/qemu-center.exe` 的直接资源布局。

## 明确边界

这不能阻止获得管理员/root/调试器权限的人观察 guest 中已经解密的运行时明文，
也不能把本地 qemu-center 变成服务器本身。最高价值算法和最终授权判断仍必须留在
服务端或受保护 artifact 的服务端消费链路中。
