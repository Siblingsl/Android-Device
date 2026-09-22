# Guest 侧核心交付设计

**日期**：2026-09-20  
**状态**：待评审；作为现有服务端授权与加密分块交付的下一阶段  
**范围**：`src-tauri` 授权客户端、`qemu-center` guest runner、`authorization-service`、发布配置与验收

## 1. 背景与问题

现有链路已经具备服务端签名、设备绑定、短期 lease、一次性 execution grant、artifact 哈希校验和 guest 在线消费授权。它已经阻止了“复制安装目录后离线运行受保护能力”。

但当前受保护 runner 的实际路径仍是：

```text
授权服务 --加密分块--> Tauri Rust --本机解密--> Windows temp/qemu_guest.py
                                             │
                                             └-- scp --> QEMU guest
```

因此 Windows 临时目录、进程内存和上传前后的调试窗口会出现核心明文。清理文件只能缩短残留时间，不能消除暴露。

本阶段将路径改为：

```text
授权服务 --只返回票据/授权上下文--> Tauri Rust --上传通用 loader + 请求--> QEMU guest
                                                                    │
                                                                    ├-- guest 内 HTTPS 请求核心
                                                                    ├-- guest 内校验哈希
                                                                    └-- guest 内短期落盘并执行
```

Tauri 不再下载、解密或持有 `qemu_guest.py`。guest loader 是通用编排壳，不包含服务端私钥、长期 secret 或可离线工作的核心逻辑；真正的 runner 仍由授权服务按 artifact、设备、会话、版本、VM、实例和短期 grant 控制。

## 2. 安全目标与明确边界

### 2.1 必须达到

1. 发布版 `src-tauri` 的临时目录、工作目录、命令行和普通日志中不出现 `qemu_guest.py` 明文。
2. 发布版 `qemu-center` 只携带通用 loader，不携带受保护 runner 源码或其可执行副本。
3. guest 只有在拿到有效的签名 execution grant 后，才能向授权服务请求对应 artifact。
4. 授权服务在 release 请求中再次校验 grant 签名、设备 proof、session、entitlement、版本、artifact 哈希、动作、VM/实例和有效期；失败即不返回核心。
5. 核心进入 guest 后仍必须经过现有一次性在线消费门禁；release 预取不能替代 execution grant consume。
6. release、核心传输和错误响应均不可缓存；服务端不把长期 bearer secret 下发给 guest。

### 2.2 不承诺

以下仍属于已有的诚实边界：

- QEMU guest root、宿主机管理员、内核级调试器或被劫持的 TLS 信任根可以观察 guest 运行时明文；
- 合法授权设备在一次合法运行中必然会看到部分运行时数据；
- Python loader 本身不是硬件可信执行环境，不能作为最终信任根；
- GApps、Magisk、LSPosed、Shamiko 等第三方文件仍按其各自许可证和来源处理。

如果未来要抵抗宿主机管理员或 QEMU 调试，必须另立“硬件/远程证明 + guest 端不可导出密钥”子项目，不能把本阶段描述成完全反逆向。

## 3. 协议变更

### 3.1 Release 预取接口

新增：`POST /v1/execution-grants/release`

请求体：

```json
{
  "grant": {
    "key_id": "auth-2026-01",
    "payload": "base64url-signed-claims",
    "signature": "base64url-signature",
    "device_proof": "base64url-device-signature"
  }
}
```

响应体：

```json
{
  "artifact_id": "qemu-guest-script",
  "artifact_sha256": "64-lowercase-hex",
  "artifact_size_bytes": 33945,
  "content_base64": "base64url-runner-bytes"
}
```

实现约束：

- 服务端复用现有 grant 验证逻辑和 artifact policy；不能只检查 `jti` 非空。
- release 只负责把核心送到已经证明拥有 grant 的 guest；真正的一次性授权仍由现有 `/v1/execution-grants/consume` 完成。这样 loader 预取失败或执行前中断不会错误消耗 grant。
- release 不返回现有 execution authorization receipt；该 receipt 只有 `/consume` 成功后才能产生，避免把“预取证明”误当成“已授权执行证明”。
- 返回的 `artifact_sha256` 必须与 grant claim 和服务端当前 artifact 三者一致；响应内容大小必须与服务端文件一致。
- release 不接受客户端自带的 artifact 路径、哈希、签名公钥或服务端地址作为信任根；artifact、哈希和授权服务配置从已验证 grant/构建配置得到。
- 返回体设置 `Cache-Control: no-store`、`Pragma: no-cache`，并限制单个 runner 的最大大小。超过上限时 fail closed，后续另行设计分块 release。
- 生产服务必须使用 HTTPS；HTTP 只允许 loopback 开发服务。

### 3.2 Guest loader 请求

loader 接收一个普通请求文件，内容只包含操作参数和 signed grant，不在 argv 中传 token：

```json
{
  "action": "build|seed|authorize|activate|upgrade|restore|details",
  "vm": "node1",
  "executionInstance": "r13",
  "executionGrant": { "...": "signed grant" }
}
```

loader 的固定流程：

1. 校验请求形状、grant 字段和 artifact hash 约束；Tauri Rust 在交给 guest 前已经用构建期公钥环验签，服务端 release 接口还会再次验签。
2. 通过 guest 内 HTTPS 调用 release 接口，得到核心字节、artifact hash 和 artifact size。
3. 在 guest 内校验字节哈希，使用 `O_CREAT|O_EXCL`、`0700/0600` 和 `rdc:rdc` 权限写入短期文件。
4. 执行核心 runner；核心 runner 自己再次验签并调用现有 consume 接口，产生 execution receipt。
5. 无论成功、失败或异常退出，删除核心和请求临时文件。

核心 runner 的 `main` 仍必须调用现有在线 consume；`authorize` 动作使用 consume 返回的 receipt 写入 authorization marker，其他动作在 consume 成功后才进入 Docker/QEMU 逻辑。release 响应本身不能单独成为离线执行凭证。

## 4. 客户端和 guest 侧接口调整

### 4.1 Rust authorization client

将 `AuthorizedCoreArtifact.path` 和 `AuthorizedCoreWorkflow.path` 删除，改为只返回 grant：

```rust
pub struct AuthorizedCoreArtifact {
    pub execution_grant: SignedExecutionGrant,
}

pub struct AuthorizedCoreWorkflow {
    pub execution_grants: Vec<SignedExecutionGrant>,
}
```

`runtime_download_core_*` 在兼容命名上可以保留，但语义改成 `runtime_authorize_core_*` 更清晰；旧的“下载到 PathBuf” API 必须删除或只在 debug 测试模块中保留，release 编译不能调用。

### 4.2 Tauri 的 QEMU guest staging

Tauri 的 QEMU 预设 staging 将一个通用 `qemu_loader.py` 写入 guest staging 目录。该 loader 通过 `include_str!` 进入发布二进制，但只能包含：

- HTTPS release endpoint；
- 当前/下一代服务端公钥环；
- grant、哈希和临时文件校验逻辑；
- 调用真正 runner 的通用代码。

它不得包含真正 runner 的源码、第三方资产或长期服务端 secret。发布配置缺少 release endpoint 或公钥环时，受保护命令必须 fail closed。

独立 `qemu-center` 继续负责宿主侧 grant/receipt 校验和一次性 ledger，不直接上传受保护 runner；它不会因为本阶段而获得离线核心。

### 4.3 qemu_guest.py

真正 runner 不再由 `qemu-center` 或 Tauri 直接上传。它继续负责 Docker 操作、execution receipt/marker 验证和现有资源策略；不得改成仅相信 loader 的本地结果，仍必须在线 consume grant。

## 5. 验收标准

### 5.1 自动化

- authorization-service：release 缺失 grant、错误签名、错误 device proof、过期 session、撤销 entitlement、artifact/hash 不匹配和未知动作均拒绝且不返回内容。
- authorization-service：release 返回内容哈希、大小和 grant 完全一致；响应带 no-store。
- authorization-service：release 本身不消耗 JTI；随后 consume 成功一次，重复 consume 返回冲突。
- Rust：受保护工作流返回值不再包含本地 path；失败时不会创建 `rdc-qemu-guest-*.py`。
- Tauri QEMU staging：loader 缺失 release endpoint、公钥或请求 grant 时 fail closed；argv 不含 grant payload、device proof 或 artifact 内容。
- Python：loader 对错误 hash、错误动作绑定、release 非 200、过大响应和异常退出均清理临时核心；核心未完成 consume 时不执行 Docker 动作。
- 发布扫描：release 构建产物与 qemu-center 二进制中不出现 `qemu_guest.py` 源码关键片段。

### 5.2 人工/环境验收

以下必须在真实 Tauri + 可联网 guest 环境中人工确认，不能用单元测试代替：

1. 合法授权后创建、升级、恢复和详情读取都能完成。
2. Windows `%TEMP%`、项目 `qemu-center/state/presets` 和进程命令行中只出现 loader/request，不出现 runner 明文。
3. 断网、服务端吊销、guest 时间异常和 release 中断都不会创建或启动受保护容器。
4. 复制安装目录到另一台未注册设备仍不能工作。
5. 关闭授权服务后，已有 grant 不能通过重放继续执行；人工确认一次性消费与清理结果。

## 6. 分阶段原则

先实现接口和测试，再切换默认链路；在真实 Tauri 验收前保留基本只读诊断能力，但不保留 release 版本地核心回退。若 guest 无法可靠访问生产 HTTPS 服务，停止在当前阶段，不通过重新把核心下载回 Windows 来“修复”兼容性。
