# E-006 — Authorization and core-delivery code audit

日期：2026-09-17  
范围：自有仓库的 src-tauri/src/services/authorization.rs、
authorization_client.rs、secure_store.rs、qemu_presets.rs、Tauri QEMU
命令，以及 authorization-service/src/。

## Threat model

- 资产：服务端 Ed25519 签名私钥、账号 entitlement、会话/撤销状态、客户端
  DPAPI 设备私钥、核心 artifact、QEMU guest runner。
- 信任边界：React UI 不决定授权；Rust 后端向授权服务取短期租约；授权服务
  持有签名私钥和 artifact 根目录；guest 只在一次受保护操作期间获得 runner
  明文。
- 目标：复制或修改客户端后，离线不能伪造租约、绕过 entitlement、复用其他
  设备/版本/目标的 artifact，或在未获服务端授权时执行发布版核心路径。
- 明确限制：本机管理员、调试器、guest root 能观察合法运行时的明文 runner；
  这不属于本方案可消除的绝对反逆向能力。

## 方法与结论

- 已读取代码审查先例并确认仓库源码访问；自动化 semgrep 不在本机环境，
  因此使用限定目录检索、逐条数据流人工审查和 Rust 测试替代。
- 发布版未发现 qemu_guest.py 脚本正文内嵌；既有 E-004 已记录 release
  构建和二进制 marker 检查。
- 未发现提交到源码中的服务端签名私钥、设备私钥或固定 bearer token。
- 客户端校验签名 lease/manifest、issuer/audience、时间、设备/会话/版本、
  capability、目标 ABI/Android、大小和 SHA-256；artifact 使用 X25519 +
  HKDF + ChaCha20-Poly1305 分块传输，失败时删除临时明文。
- 客户端发布配置已支持构建期多公钥信任环，按签名响应的 `keyId` 验签；
  重复、空值和格式错误的公钥配置会 fail closed。服务端仍只启用当前签名私钥，
  轮换顺序和旧客户端退出需要部署演练。
- 服务端在 artifact prepare/chunk 入口检查会话、撤销、entitlement 和设备/
  会话绑定；artifact 路径限制在配置根目录内。

## 已修复发现

/v1/clients/register 原先在设备私钥证明之前就更新已有客户端版本并撤销
旧会话。知道公开 device ID/public key 的请求方可造成授权拒绝服务。现已把
请求版本随一次性 challenge 暂存，并在 /register/complete 验签成功后才应用
版本更新和旧会话撤销；新增回归测试覆盖“无证明不变更、无效证明不变更、有效
证明才变更”。此外，无效注册 proof 不会消耗有效 challenge，避免攻击者用
错误签名锁死合法设备；授权服务测试覆盖该回归。

## 残余风险与上线条件

- runner 在 guest 中必须以明文执行；高价值算法应继续留在服务端，不要把它们
  下沉到脚本或客户端。
- 生产部署必须由受管 TLS 终止层强制 TLS 1.3，并保护管理员 CLI、数据库、
  artifact 根目录和签名密钥；当前仓库只提供 fail-closed 的服务进程和本地
  示例，不代表生产部署已验收。
- 仍需人工完成断网、撤销、篡改、密钥轮换和真实账号/TLS 演练；在完成前不能
  宣称“绝对反逆向”。
