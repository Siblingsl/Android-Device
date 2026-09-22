# E-061 — 多阶段 QEMU 预装流程的单次 execution grant 修复

- 日期：2026-09-20
- 范围：受保护 Redroid 创建/升级的 `build`、`seed`、`activate` 阶段

## 发现

原流程为一个创建操作申请一个 execution grant，但同一个 grant 会被
`qemu_guest.py` 在多个阶段重复消费。服务端 JTI 是一次性的，因此真实创建
会在第二阶段被拒绝；如果把服务端改成允许重复消费，又会削弱重放防护。

## 修复

- 创建现在申请 3 个独立的 `preset_apply` grant，分别绑定同一设备、VM、实例、
  artifact 和会话，但拥有不同的 nonce/JTI；依次交给 `build`、`seed`、`activate`。
- 升级申请 2 个独立 grant，分别交给 `build` 和 `upgrade`。
- guest runner 仍在每个阶段开始前验证签名、设备 proof、核心哈希和工作流上下文，
  并向服务端一次性消费当前阶段的 JTI。
- 下载核心或编码 grant 失败时仍由本地清理器删除临时明文核心。

## 验证

新增 Rust 回归测试 `protected_workflow_consumes_distinct_grants_in_stage_order`，
确认 grant 按阶段顺序消费且不足阶段票据时 fail closed；Tauri qemu preset 聚焦测试通过。
完整 `src-tauri`、前端和 qemu-center 门禁仍需在本轮结束前复验。
