# E-063 — 创建前 guest 在线预授权与 Docker 闸门

日期：2026-09-20  
范围：Tauri protected create、guest runner、qemu-center CLI

## 审计发现

原流程由 qemu-center redroid create 先执行 guest Docker 创建，随后
activation runner 才消费 execution grant。这样在授权服务不可达时，虽然
runner 最终会 fail closed，但 Docker 可能已经启动了一个未完成预装的容器。

## 修复

- 创建流程在 build、seed 后先执行 guest runner 的 authorize 阶段。
- runner 先完成签名 grant、核心哈希、VM/实例绑定和设备证明对应的服务端一次性
  JTI 消费，然后在同一 /run/rdc-presets/<job> 下以 0600 写入
  execution-authorized marker。
- qemu-center redroid create 在任何 guest Docker 命令前，额外校验：
  - 发布构建内嵌公钥环下的 grant 签名与有效期；
  - /run/rdc-presets 范围内的 marker 路径；
  - marker 内容与 grant JTI 完全一致。
- activation runner 只接受并删除已消费的同 JTI marker，不重复消费票据；
  marker 在 host 的所有 cleanup 路径中删除。

## 结果

服务端不可达、票据消费失败、marker 缺失、marker 错绑或直接复制
qemu-center 时，创建流程在 Docker 操作前失败。只读列表/统计路径仍保留原有
诊断行为。

## 自动化证据

- guest Python：20 个测试通过，覆盖授权后写 marker、marker 缺失、JTI 错绑和
  marker 单次创建。
- qemu-center：216 个 library 测试 + 13 个 CLI 测试通过，覆盖 marker shell
  命令转义、路径必须位于 /run/rdc-presets。
- Tauri focused 测试覆盖新的 guest authorization path 参数和受保护 staging
  路径。

## 边界

marker 只是同一 guest 在线预授权的短生命周期证明，不是签名替代品；核心仍会在
合法执行期间以 guest 明文存在。原机管理员、guest root 或调试器能够观察合法运行
时的明文，仍属于明确不可消除的边界。
