# Client Functional Test Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复客户端完整功能测试中可归因于项目的 PTY 测试时序问题与预览测试桥接契约问题，并用单元测试、类型检查和浏览器回归验证修复结果。

**Architecture:** 保持生产页面的数据契约不变；将预览桥接补齐为与 `DeviceService` 返回类型一致的最小 fixture，并补上 Tauri 事件监听的 mock 生命周期。PTY 只修复已复现的本地 PowerShell 会话启动竞态，不改变设备终端的原始输入语义。

**Tech Stack:** React、TypeScript、Vitest、Playwright CLI、Tauri、Rust、portable-pty。

## Global Constraints

- 仅修改能直接解释测试失败的代码和测试夹具，不做风格、命名或无关重构。
- 不将真实设备/QEMU 未接入误报为通过；相关结论保留为人工确认项。
- 保留工作区已有改动，不执行 reset、checkout、clean 或提交。
- 完成后运行项目要求的四组验证命令，并单独记录 lint/SAST 工具缺失情况。

## Review Focus

- 边界条件：空数组、空字符串、缺省字段、无设备及无 Docker/ADB 时页面仍可渲染。
- 异常处理：预览桥接不应把结构化查询结果伪装成 ShellResult；事件卸载不应抛异常。
- 性能瓶颈：只提供静态最小 fixture，避免定时器或重复请求造成额外负担。
- 安全风险：不放入真实凭据、路径或可执行外部动作；mock 操作保持无副作用。

## Tasks

- [x] Task 1: 为 PTY 启动竞态增加失败复现与稳定性验证，实施最小修复并通过目标 Rust 测试。
- [x] Task 2: 为预览桥接建立命令返回契约测试，补齐 Dashboard、设备详情、ADB、Volumes、Logs、Settings 和 Docker 页面所需的返回形状。
- [x] Task 3: 补齐预览 Tauri 事件监听/卸载 mock，并回归原有 Devices、详情页和全局路由。
- [x] Task 4: 运行 TypeScript、Vitest、两套 Rust 测试和可用的 lint/SAST 检查，记录未安装工具和真实设备人工确认项。
