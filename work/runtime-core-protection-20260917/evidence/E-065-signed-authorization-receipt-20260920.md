# E-065 — 服务端签名 authorization receipt 与节点侧 Docker 前验签闸门

日期：2026-09-20

## 目的

修复 E-063 遗留的信任缺口：guest 作业目录中的纯 JTI marker 只能证明“文件内容等于某个 JTI”，如果 guest 内的写权限被滥用，攻击者仍可能伪造该文件。现在 marker 保存的是授权服务在原子消费 grant JTI 后签发的 Ed25519 签名回执。

## 实现边界

- `authorization-service` 的 `/v1/execution-grants/consume` 在完成设备 proof、session、entitlement、artifact 哈希和一次性 JTI 消费后，返回 `{key_id, payload, signature}`。
- 回执 payload 固定绑定 `client_id`、`device_id`、`session_id`、`client_version`、`artifact_id`、`artifact_sha256`、`action`、`vm`、`instance`、`grant_jti`、`iat`、`exp`，audience 为 `rdc-qemu-center`。
- guest runner 只接受并写入可验签的完整回执；历史纯 JTI marker 会被明确拒绝。
- `qemu-center redroid create` 通过 SSH 读取 marker，使用发布时嵌入的 `RDC_AUTH_PUBLIC_KEYS` 信任环验签，检查 issuer/audience/时间窗口，并将回执的所有操作绑定字段与已验签 grant 逐项比较；失败时不会执行 guest Docker 命令。
- 回执有效期不替代服务端 grant 一次性消费；服务端 JTI 消费、设备 proof 和 artifact 哈希检查仍是授权源头。

## 自动化证据

| 检查 | 结果 |
|---|---|
| 授权服务路由测试 | 通过；消费响应为签名回执，测试验签并确认 audience、JTI、artifact 哈希、VM、实例绑定；重放仍返回 `409` |
| qemu-center receipt 正向测试 | 通过；正确回执可验签并通过 grant 绑定校验 |
| qemu-center receipt 负向测试 | 通过；纯 JTI marker、签名篡改均拒绝 |
| guest runner 测试 | 21 个通过；消费响应回执写入 marker，纯 JTI marker 被拒绝 |
| qemu-center 全量测试 | 216 个库测试 + 15 个命令行测试通过 |
| authorization-service 全量测试 | 23 个库测试 + 2 个管理工具测试 + 2 个启动配置测试 + 3 个集成测试通过 |
| TypeScript / Vitest | `tsc` 通过；60 文件 / 460 用例通过 |
| Tauri 全量测试 | 通过；299 个通过、0 失败、2 忽略；Windows ConPTY PTY 用例在本轮全量复跑也通过 |
| `git diff --check` | 通过；仅有工作树换行风格提示 |
| release 构建与核心扫描 | 通过；qemu-center、authorization-service release 构建完成，Tauri NSIS release 安装包生成；桌面主程序、DLL、MCP、qemu-center 扫描均为 `clean` |

## 残余边界

该闸门防止复制客户端文件、伪造 marker、篡改 grant 或绕过服务端一次性消费直接触发 Docker。它不能阻止拥有 guest root、宿主管理员权限或调试器的攻击者在一次合法授权运行期间观察内存中的 runner 明文；最高价值算法和最终授权判定仍必须留在服务端。真实 HTTPS、生产账号、跨机器复制、断网、密钥轮换和登录/连续浏览矩阵仍待人工验收。
