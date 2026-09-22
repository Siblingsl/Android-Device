# E-072：guest 侧服务端核心下发与发布扫描

日期：2026-09-20  
范围：`authorization-service`、`src-tauri`、Windows release 构建配置

## 已验证

- `POST /v1/execution-grants/release` 会重新校验 grant、设备 proof、session、entitlement、artifact 当前哈希和工作流绑定；release 本身不消费 JTI，随后 `/consume` 仍只能成功一次。
- grant 请求允许空 `artifact_sha256`，由服务端解析已发布 artifact 的实际哈希后写入签名 claim；客户端不再为了 staging 核心而下载 manifest 或核心文件。
- Tauri 的创建、升级、恢复和详情路径只传 signed grant；Windows 临时目录不再接收 `qemu_guest.py`。guest 只上传通用 `qemu_loader.py` 和请求文件。
- loader 在 guest 内通过 HTTPS 请求 release，校验 artifact id、grant hash、响应大小和内容 SHA-256，以 `O_EXCL`/`0600` 写入短期核心，执行后删除核心；错误响应、错误哈希、内容篡改和超限响应均不落盘。
- `build.rs` 在发布编译期渲染 release endpoint 和公钥环，二进制不包含未替换占位符；缺少配置时受保护操作 fail closed。
- 自动化：authorization-service `24 + 2 + 2 + 4` 测试通过；qemu-center `224 + 21` 测试通过；Tauri `300` 通过、`2` 忽略；Vitest `61` 文件/`464` 用例通过；TypeScript 通过；loader/runner Python `26` 个测试通过。
- 发布模式构建使用示例 HTTPS 地址和示例公钥环，不含服务端私钥；桌面主程序、DLL、qemu-center 三个 release 二进制均通过 `scripts/verify-release-core.ps1` 的 protected-runner marker 与未渲染配置扫描。

## 尚待人工确认

- 真实授权服务 TLS、账号审批、跨设备复制、断网/撤销/时间异常和生产密钥轮换。
- 真实 Tauri + 可联网 QEMU guest 下的创建、升级、恢复、详情全链路，以及 Windows `%TEMP%`、guest 目录、进程命令行中无 runner 残留。
- guest root、宿主管理员或内核级调试器仍可在 runner 运行期间观察 Python 明文；本证据不宣称“绝对反逆向”。
