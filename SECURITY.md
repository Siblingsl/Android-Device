# 安全说明

## 报告安全问题

请不要通过公开 Issue 发布可利用细节、密钥、代理凭据、设备日志或内部 App 信息。若仓库启用了 GitHub Private Vulnerability Reporting，请使用该入口；否则联系仓库维护者的私下渠道，并提供最小可复现信息。

报告内容建议包括：受影响版本、运行轨道、影响范围、复现步骤、必要日志和建议修复方向。先删除设备 serial、用户名、路径、IP、代理地址和认证信息。

## 敏感数据规则

- 不提交 SSH 私钥、签名证书、updater 私钥、公钥以外的发布密钥或任何 token。
- 不提交 Docker 配置中的代理凭据、设备日志、截图中的账号和内部域名。
- `vendor/` 中的 GApps、Magisk、LSPosed、Shamiko 等资产按其上游许可证和项目 gitignore 规则处理。
- 发布 CI 的 secrets 只存放在 GitHub Secrets；不要把 secret 输出到构建日志。
- 设备和 Root 能力只用于获得授权的内部 App 测试，不要用于绕过未授权服务的访问控制。

## Root 与伪装能力

Magisk/Zygisk、LSPosed、Shamiko、Cloak、设备档案和痕迹清理属于测试工具能力。贡献代码时必须说明测试授权边界、兼容性限制和失败时的真实状态，不能把“模块文件已安装”写成“防护已绕过”。

## 服务端权威核心交付

受保护的 QEMU 预装/核心脚本不应依赖可被修改的前端判断。当前设计由 Rust 后端在执行前取得设备绑定的短期租约和服务端能力，再下载签名 manifest 与 X25519/HKDF/ChaCha20-Poly1305 加密分块；发布构建不嵌入本地核心脚本，未配置授权服务时 fail closed。服务端下发的明文核心只在一次 worker 操作期间存在，并在客户端临时目录、staging 和 guest cache 三侧清理。

这只能阻止离线复制客户端直接使用受保护能力，不能提供绝对反逆向：核心脚本必须在 guest 中以明文运行，拥有管理员、调试器或 guest root 的攻击者仍可能观察本次合法运行。最高价值的算法、授权判定和长期秘密必须留在服务端。服务端私钥、账号认证、TLS 终止、密钥轮换和撤销监控必须由生产部署补齐，不能把占位配置当成上线安全。

Windows 新安装优先使用 Microsoft Platform Crypto Provider 的不可导出 ECDSA P-256
设备签名密钥；客户端只保存和登记公钥，已有 DPAPI/Ed25519 身份保持兼容。保护级别会明确
区分硬件隔离、CNG 软件提供者和 DPAPI 回退。生产账号可通过
`RDC_REQUIRE_HARDWARE_BACKED_KEYS=1` 拒绝无法确认硬件隔离的设备；该策略不会把软件 CNG
或 DPAPI 伪称为 TPM/VBS，硬件事实仍需在目标 Windows 环境人工核验。

## 依赖与发布安全

- PR 使用 lockfile 安装和依赖审计。
- 发布包必须有版本检查和 SHA-256；签名证书不进入仓库。
- updater endpoint 和公钥未同时配置时，不生成声称支持自动升级的包。
- 发现第三方资产、构建脚本或 CI 的供应链问题时，按私下渠道报告，不在公开 Issue 附带可直接滥用的样本。
