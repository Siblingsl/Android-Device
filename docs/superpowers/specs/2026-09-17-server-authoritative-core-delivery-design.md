# 服务端权威授权与核心能力交付设计

**日期**：2026-09-17  
**状态**：实施中；授权闸门与加密分块交付已落地，需部署配置和人工验收
**默认部署**：项目维护者控制的公网授权服务  
**范围**：Windows Tauri 客户端、`qemu-center` 受保护能力、授权服务、核心文件/能力交付

## 1. 目标与安全边界

目标是让复制或逆向桌面客户端的人无法在没有有效服务端授权的情况下使用受保护能力，并能由服务端实时吊销、限制并发、限制版本和限制设备。

必须先明确一个不可绕过的事实：只要完整秘密或核心代码必须在本机/Android guest 中执行，拥有管理员、调试器或 guest root 的攻击者就可能在运行时提取明文或调用结果。因此：

- “核心逻辑”优先改为服务端执行；
- 必须本地执行的文件只做会话级、设备绑定、短期加密交付；
- 客户端只保留公钥和通用运行壳，不保留服务端私钥、长期 API secret 或可离线工作的万能密钥；
- 本地校验是纵深防御，不把可 patch 的客户端判断当成最终信任根。

此方案保护的是项目自有的授权能力和专有逻辑，不改变 GApps、Magisk、LSPosed、Shamiko 等第三方资产的许可证义务，也不把第三方资产包装成项目自有秘密。

## 2. 威胁模型

需要抵抗：

1. 复制安装包后离线运行；
2. 修改 UI 或 Tauri 命令绕过前端授权判断；
3. 从二进制、配置、日志、命令行和缓存中寻找长期密钥；
4. 重放旧授权响应、旧文件或旧请求；
5. 把授权文件复制到另一台机器或另一个账号；
6. 篡改核心文件、版本、哈希、时间和设备标识；
7. 服务端密钥轮换、客户端升级和网络短暂中断期间的错误放行。

不承诺抵抗：

- 受控机器上的内核级调试、管理员注入或完整 guest root；
- 已经获得合法短期授权后对本次运行时明文的观察；
- 用户主动把账号、设备私钥和有效会话全部交给攻击者。

## 3. 推荐架构

采用“服务端权威 + 本地最小运行时”的混合模式：

```text
Tauri UI
   │  protected operation request
   ▼
Rust authorization client ── TLS 1.3 ── Authorization/API service
   │                                  │
   │ signed short-lived lease          ├─ account/entitlement/revocation
    │ encrypted session artifact        ├─ version/device/concurrency policy
   ▼                                  └─ audit and key rotation
qemu-center / local runtime
```

服务端负责账号、授权、吊销、版本、设备和核心算法；客户端负责界面、通用设备控制和受保护运行时的最小编排。核心操作不能只由 React 页面决定，必须经过 Rust 授权层，并在需要时向服务端取得一次性能力令牌或结果。

## 4. 密钥体系

### 4.1 服务端签名密钥

- 服务端使用 Ed25519 签发授权租约、能力清单和文件 manifest。
- 私钥只存在服务端密钥管理系统或受保护的部署 secret 中，不进入仓库、安装包、日志和客户端配置。
- 客户端只内置当前和下一代公钥及 `keyId`；验签支持轮换窗口。发布配置使用
  `RDC_AUTH_PUBLIC_KEYS=id=base64url-public-key,id=base64url-public-key`，并拒绝空值、重复
  `keyId` 和格式错误的公钥；未设置时兼容单组 `RDC_AUTH_PUBLIC_KEY_ID` /
  `RDC_AUTH_PUBLIC_KEY`。
- 轮换顺序固定为：先发布同时信任旧/新公钥的客户端，再把服务端切到新私钥，确认旧版本
  已退出后再发布只信任新公钥的客户端。服务端不通过未签名远程配置下发新的信任根。
- 公钥更新必须由旧的可信公钥签名，避免远程配置把信任根替换成攻击者的 key。

### 4.2 客户端设备密钥

首次运行在本机生成不可导出的设备密钥对，私钥使用 Windows DPAPI/CNG 保护，公钥注册到服务端。设备密钥只用于证明“这是已注册设备”，不用于代替服务端签名。

客户端不得把私钥放在命令行参数、普通 JSON、日志、localStorage、资源文件或 guest 共享目录中。

### 4.3 会话加密密钥

每次核心文件请求生成一次性的 X25519 临时公钥。服务端使用 X25519 派生会话密钥，再用 HKDF-SHA256 和 ChaCha20-Poly1305（分块 AEAD）加密交付内容。文件密钥、nonce、会话和 manifest 绑定，避免把一个会话的密文复制到另一台设备。

即使采用该方案，运行时仍可能被调试器提取，所以最敏感的计算和策略不能只依赖本地解密文件。

## 5. 授权协议

### 5.1 注册

`POST /v1/clients/register`

```json
{
  "installId": "random-install-id",
  "clientVersion": "1.0.0",
  "platform": "windows-x64",
  "devicePublicKey": "base64url",
  "requestedProduct": "redroid-device-center"
}
```

服务端返回 `clientId`、挑战值、当前服务端 `keyId` 和注册状态。客户端必须用设备私钥签名挑战，服务端验证后才允许建立会话。

### 5.2 会话租约

`POST /v1/sessions`

请求包含：设备签名、客户端版本、产品版本、请求能力、随机 nonce。响应为签名的短期 lease：

```json
{
  "keyId": "auth-2026-01",
  "lease": {
    "iss": "rdc-auth",
    "aud": "rdc-client",
    "sub": "account-id",
    "clientId": "client-id",
    "deviceId": "device-id",
    "sessionId": "session-id",
    "capabilities": ["protected-preset", "protected-artifact"],
    "clientVersion": ">=1.0.0 <2.0.0",
    "iat": 0,
    "exp": 0,
    "jti": "one-time-id",
    "nonce": "request-nonce"
  },
  "serverTime": 0
}
```

默认 `exp` 不超过 15 分钟；受保护能力需要心跳续租。服务端维护 `jti`、设备、账号、并发和吊销状态。

### 5.3 心跳与吊销

`POST /v1/sessions/{sessionId}/heartbeat` 每 60 秒发送一次，服务端返回新的过期时间或明确的吊销原因。检测到吊销、账号禁用、版本不兼容、设备变更或并发超限时，客户端立即停止获取新核心能力，并让当前运行进入受控停止/只读状态。

授权服务不可达时，受保护能力默认不允许建立新会话；已建立会话最多按租约剩余时间运行，不能通过改本机时钟延长。若产品需要网络抖动容错，宽限期也不得超过租约过期时间且不能用于首次授权。

客户端收到租约时，必须使用 `max(localWallClock, serverTime)` 做首次验签和过期判断，避免旧的或被篡改的未签名 `serverTime` 把已过期租约重新变成可用。租约一旦接受，后续进程内的过期判断以“验签时的有效时间 + 单调时钟经过时间”为准，不反复信任系统墙上时钟；进程重启后必须重新取得租约。

## 6. 核心能力与文件交付

### 6.1 服务端执行优先

以下类别优先留在服务端：

- 专有授权策略和能力组合判断；
- 核心配置生成、敏感规则计算和版本兼容决策；
- 能够改造成 API 的核心算法和高价值数据。

客户端只拿到执行所需的最小结果，避免把完整算法包放进安装目录。

### 6.2 不可避免的本地文件

对必须进入 QEMU/Android guest 的文件：

1. 客户端先向服务端请求 artifact manifest，包含版本、文件哈希、大小、目标 ABI、目标 Android 版本、设备/会话绑定和过期时间。
2. 客户端提交本次会话的临时 X25519 公钥。
3. 服务端返回签名 manifest 和每次请求的临时 X25519 公钥；客户端与服务端各自派生会话密钥，分块 AEAD 密文只对该临时密钥可解。
4. 客户端在受保护的短期目录中完成完整性校验，写入 guest 后立即删除传输缓存和临时密钥材料。
5. guest 使用的授权句柄与 session、实例、版本和文件哈希绑定；停止实例或租约到期后不得继续获取新句柄。

客户端用于下载 artifact 的工作实例必须继承刚刚验证通过的当前 session；不能因为重新创建
HTTP/secure-store 客户端而丢失内存中的 lease，导致“已授权但下载端未注册”的错误路径。

对不依赖具体 Android 版本的 guest runner 动作（例如恢复升级前状态），使用单独
的通用 artifact 标识和显式 `targetAndroid=any`；不能为了选择 artifact 而先执行
未授权的详情 runner。通用 artifact 仍必须经过同一 capability、设备、会话、版本、
签名 manifest、加密分块和过期校验。

实例列表的增强详情读取（Android 版本、镜像、资源档案和回滚标记）同样使用该通用
artifact，不在 release 包中保留本地详情脚本。授权服务不可用时仍可返回容器名称、
端口和状态等基础只读信息，但不得以本地脚本回退来恢复受保护的详情能力。

不把授权 token 放进进程命令行，不把明文写入普通日志，不把长期解密密钥挂载到共享目录。大文件下载必须支持分块校验、失败重试和中断清理，不能因为断点缓存而留下可直接使用的未加密核心包。

### 6.3 本地运行时的信任边界

`qemu-center` 可以校验发布时嵌入公钥环验证的执行 grant、manifest、哈希、版本、VM/实例绑定和过期时间，但这只是纵深防御。当前 Tauri 的 QEMU 预设命令在 Rust 层先取得 `protected-preset` 与 `protected-artifact` 双能力，并在发布版不嵌入本地 `qemu_guest.py`；否则攻击者 patch 掉本地 `if authorized` 仍可能绕过。guest 在运行时仍会看到可执行明文，这不是客户端加密能够消除的限制。

## 7. 客户端状态与用户体验

授权层对 UI 输出结构化状态：

- `not_registered`：需要注册设备；
- `authentication_required`：需要账号/授权；
- `lease_expired`：租约到期，需要联网续租；
- `server_unreachable`：服务不可达，说明当前是否仍在租约内；
- `client_outdated`：客户端版本不再被允许；
- `device_binding_mismatch`：授权与设备不匹配；
- `artifact_integrity_failed`：签名/哈希/目标环境校验失败；
- `revoked`：服务端已吊销；
- `ready`：当前能力可用。

错误消息不得泄漏服务端私钥、内部数据库、完整授权 token 或设备私钥。日志只记录 `sessionId`、`jti`、artifact 哈希前缀和错误分类。

## 8. 服务端与客户端验收

### 8.1 协议测试

- 无效签名、过期租约、错误 audience、错误设备、错误版本和重复 nonce 必须拒绝；
- 修改任意 manifest 字段或密文分块必须拒绝；
- 旧 `jti`、旧 session 和已吊销设备不能重放；
- 服务端密钥轮换期间旧/新公钥按窗口正确验签，未知 `keyId` 拒绝；
- 设备私钥不出现在命令行、日志、普通配置和 guest 共享目录；
- 服务器返回的能力必须经过 Rust 授权层，不能只有 React 守卫；
- 断网、时钟回拨、部分下载、磁盘残留和客户端异常退出都必须进入安全失败状态。

### 8.2 运行验收

1. 新设备无授权时能打开基础页面，但不能创建或启动受保护能力。
2. 合法授权后只能在绑定设备、版本和租约内运行。
3. 服务端吊销后，心跳到期不得继续取得核心文件或能力令牌。
4. 将安装目录复制到另一台设备不能直接使用。
5. 重新打包并删除前端授权调用不能绕过 Rust/服务端门禁。
6. 当前公开的基础 Docker/QEMU 诊断能力是否也需要授权，必须在产品授权策略中显式列出，不能由客户端默认猜测。

## 9. 实施边界与顺序

安全子项目按以下阶段实施，每阶段独立可测：

1. 先落 threat model、协议类型、错误状态和只读授权探针，不改变现有设备运行行为。
2. 增加服务端签名验签和租约生命周期，先保护一个非破坏性的演示能力。
3. 增加 artifact manifest、加密分块交付、缓存清理和完整性测试。
4. 将真正高价值逻辑迁移到服务端接口，并在 Rust 层接入一次性能力令牌。
5. 最后再把受保护能力接入 QEMU/实例创建链路，并完成吊销、升级和回滚验收。

后续实施计划预计涉及 `src-tauri` 授权服务、`qemu-center` lease 校验、前端授权状态、服务端独立目录/服务和发布配置。服务端私钥、账号 token、生产 URL 证书和第三方资产凭据不进入仓库。

## 10. 发布配置的 fail-closed 策略

发布版授权客户端的构造必须要求服务地址和至少一组有效的服务端公钥同时存在；
缺少任一项、空值、重复 key ID、非法公钥或非 HTTPS 的非回环地址都必须在执行
受保护动作前失败。该策略抽成无副作用的配置解析函数并单测，避免只能依赖某个
构建环境的 `option_env!` 结果来推断安全边界。回环 HTTP 仅作为本地开发服务例外，
不改变 release 的服务端授权要求。

## 11. Per-operation execution authorization

Artifact acquisition and artifact execution are separate trust boundaries. The
protected runner path now obtains a short-lived, signed execution grant after
the manifest is verified and before the runner is uploaded. The grant must bind
at least the session, device, artifact hash, action, VM/instance, client
version, expiry and the request nonce. Rust rejects a missing, expired or
mismatched grant before guest transfer, and the service consumes the request
nonce transactionally. The guest additionally enforces
the signed grant's expiry and operation context.

The guest-side runner must also fail closed without a verifiable grant (or the
operation must move to a server-side execution API). A plain non-empty field in
`request.json` is not sufficient: the verifier must use a trusted public key
and a signed payload, and the trusted key must not be taken from the request
itself. This reduces the value of copying a downloaded runner and makes the
execution boundary explicit. The rendered runner now also contains a
server-side consume URL and submits the signed grant immediately after local
verification and before any Docker operation. The service atomically consumes
the grant JTI; a second submission or an unavailable service fails closed.
The consume endpoint does not mint a new grant and accepts no client private
key or bearer credential. Local QEMU development needs a reachable gateway or
HTTPS deployment because the authorization service's loopback-only listener is
not reachable from the guest by itself. An attacker with
administrator/root/debugger access during a legitimate operation may still
observe plaintext or patch the runner.
