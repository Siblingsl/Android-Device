# 授权服务签名密钥轮换手册

本文描述 `RDC_AUTH_SIGNING_KEY` 的生产轮换流程。它只适用于已由
secret manager 管理私钥、由托管边缘终止 TLS 1.3 的部署；示例中的值均为
占位符，不能写入仓库、日志或命令行历史。

## 轮换前提

- 当前客户端已经支持 `RDC_AUTH_PUBLIC_KEYS`，并且新版本同时信任旧公钥和下一把公钥。
- 下一把私钥已在 secret manager 中生成并完成双人复核；桌面构建环境只获得对应公钥。
- 已确认数据库、artifact root、旧私钥引用和服务回滚方式可恢复。
- 已准备维护窗口：切换期间暂停新的受保护 QEMU 预装、升级、恢复和详情增强操作。

## 为什么必须重新发布 runner

发布后的 guest runner 会内嵌当前执行票据签名公钥。服务端切换到下一把密钥后，
旧 runner 仍会信任旧公钥，因而会拒绝下一把密钥签发的 execution grant。
所以不能只替换服务端环境变量；必须在切换后用下一把密钥重新渲染并发布每个
Android/ABI/工作流对应的 runner artifact。

## 操作顺序

1. 生成下一把密钥并记录 `next-key-id`，只把私钥放入 secret manager。
2. 构建并发布同时包含旧公钥和下一公钥的桌面客户端，先验证：
   - 旧服务端签发的 lease、manifest 和 execution grant 仍可验证；
   - 客户端不会把私钥或旧密钥明文写入构建产物；
   - 发布配置使用 HTTPS 服务地址和 `RDC_AUTH_PUBLIC_KEYS`。
3. 等待旧客户端进入退出/升级窗口，确认没有必须长期保留的旧版本客户端。
4. 进入维护窗口，暂停新的受保护 QEMU 操作，等待已开始的操作完成或按既定回滚流程结束。
5. 将服务端 `RDC_AUTH_SIGNING_KEY_ID` 和 `RDC_AUTH_SIGNING_KEY` 原子切换为下一把，
   重启服务并验证健康检查、`key_id`、`no-store` 和撤销状态。
6. 在私有管理主机上用下一把密钥重新执行 `artifact publish-runner`，覆盖所有实际支持的：
   - `qemu-guest-script` / `preset_apply`；
   - `qemu-guest-script-universal` / `preset_restore`、`preset_details`；
   - 每个 Android 目标和 ABI 组合。
7. 用双公钥客户端完成一次真实的租约、artifact 下载、execution grant 消费和 Docker 前置动作，
   确认新 runner 的 `key_id` 与服务端一致，再恢复新操作。
8. 观察一个完整租约周期，确认旧客户端已退出、旧 runner 不再被下载或执行。
9. 从发布配置中移除旧公钥，构建只信任下一把密钥的客户端；保留旧私钥的受控撤销/销毁记录，
   不删除审计记录。

## 回滚条件

如果双公钥客户端无法验证新 lease/manifest、runner 的 grant 消费失败、artifact 哈希不一致，
或旧版本客户端仍有业务需求：立即暂停受保护操作，恢复服务端旧密钥和旧 runner artifact，
保留失败请求、key id、artifact hash、版本和时间戳，禁止通过把私钥放入客户端来绕过问题。

## 验收记录

每次轮换至少记录：旧/新 `key_id`、维护窗口、客户端版本、runner artifact 哈希、服务端健康检查、
一次成功操作、一次旧客户端拒绝、旧公钥移除时间和回滚负责人。真实账号、TLS、密钥托管和
跨设备复制结果必须来自生产或隔离部署的实际记录，不能用单元测试替代。

## 当前证据链

- **Evidence**：`E-035` 覆盖 execution grant、guest 验签和 runner 发布渲染；`E-055` 覆盖
  Release 核心边界与授权链源码审计；`E-056` 覆盖最终门禁和 Release 核心扫描。
- **Finding**：服务端签名密钥切换必须和 runner artifact 重新发布绑定，否则旧 runner 会拒绝
  新签名的 execution grant；这也是本手册要求维护窗口的原因。
- **Path**：双公钥客户端 → 服务端 key 切换 → 下一把密钥渲染 runner → artifact 下载与哈希校验
  → guest grant 验签/一次性消费 → 恢复受保护 QEMU 操作。
