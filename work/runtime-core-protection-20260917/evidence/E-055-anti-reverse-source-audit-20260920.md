# E-055 — 反逆向授权边界源码审计

**日期**：2026-09-20
**范围**：Tauri 授权客户端、安全存储、QEMU 核心下发、guest runner、授权服务和 Windows Release workflow

## 威胁模型

- 攻击者复制或逆向 Release 客户端，试图在另一台 Windows 机器上使用受保护能力。
- 攻击者篡改请求、核心文件、执行票据或授权服务响应。
- 攻击者拥有原机器管理员权限或 guest root，试图观察一次合法运行中的核心明文。

高价值资产是设备签名私钥、授权服务签名私钥、受保护核心和执行票据。Release 客户端不应携带
设备私钥导出材料、授权服务签名私钥或核心脚本明文。

## 自动检索与人工验证

本机未安装 Semgrep、Bandit 或 cargo-audit，因此使用限定范围的源码检索后逐条人工验证：

- `src-tauri/src/services/qemu_presets.rs` 中的 `include_str!("qemu_guest.py")` 位于
  `cfg(debug_assertions)` 分支；`cfg(not(debug_assertions))` 明确返回“发布版必须从授权服务取得
  QEMU 核心脚本”。Release 二进制扫描结果为 clean。
- `authorization-service/src/main.rs` 只从 `RDC_AUTH_SIGNING_KEY` 读取服务端私钥，并在缺失时拒绝
  启动；Windows Release workflow 同时拒绝将该变量带入桌面构建。
- 客户端只保存 DPAPI 兼容私钥或 CNG named-key 元数据；CNG 只导出 SEC1 公钥，启动时校验 key
  是否存在及公钥是否匹配，删除或替换会 fail closed。
- 核心下载使用临时 X25519 会话密钥、签名 manifest、分块 AEAD 和完整 SHA-256；执行前还需要
  服务端签发的短时 execution grant、设备签名 proof、artifact/action/VM/instance 绑定和一次性
  JTI 消费。
- guest runner 使用发布时嵌入的执行票据公钥，不接受请求传入的信任公钥；执行前校验自身哈希，
  grant 消费失败不会进入 Docker 操作。
- Release workflow 和 `scripts/verify-release-core.ps1` 均验证最终二进制不包含 protected runner
  明文。本轮 Tauri 与 qemu-center Release 构建后的两个二进制均返回 `clean`。

## 结论

没有发现可让复制的 Release 客户端在没有已注册设备密钥、有效租约、服务端 entitlement、签名
execution grant 和一次性消费的情况下直接运行受保护核心的高危路径。

### 可接受的低风险项：debug 本地核心回退

位置：`src-tauri/src/services/qemu_presets.rs` 的 debug-only `include_str!` 分支。

这是本地开发便利，不进入 Release 二进制；生产构建在缺少服务端核心时 fail closed。修复建议是
继续把 Release 扫描保留为 CI 阻断门禁，不能把 debug 构建用于生产部署。

### 残余风险：合法运行时明文

核心脚本最终必须在 guest 中以明文运行；拥有原机管理员权限、guest root 或调试能力的攻击者仍
可以在合法运行期间观察它。临时目录清理和 `/run/rdc-presets` RAM staging 只能缩短残留时间，
不是安全擦除。最高价值算法、最终授权判定和长期秘密仍应留在服务端。

### 残余风险：硬件隔离尚未远程证明

当前 CNG provider 可能是软件实现；客户端会显示保护级别，严格策略可以拒绝非硬件级别，但
`RDC_REQUIRE_HARDWARE_BACKED_KEYS=1` 本身是本机策略，不是服务器可独立验证的 TPM/VBS 证明。
生产高保证部署仍需在目标 Windows 设备上人工核对 TPM/VBS，并完成密钥轮换、撤销、跨机器复制
和断网/篡改演练。

本审计未启动或停止 `node1`，未修改 qcow2，也未读取生产密钥。
