# 应用暂停后 guest 回收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 在应用级暂停成功后复用既有的安全 guest balloon 回收链路，改善 QEMU 工作集释放机会。

**Architecture:** 保留 qemu-center 对指标、保留量和 QMP 校验的唯一所有权；Tauri 命令只在
ADB `force-stop` 成功后调用现有 CLI。通过一个纯策略函数把“是否允许调用”和“回收结果”
隔离出来，测试不会启动真实 QEMU。

**Tech Stack:** Rust/Tauri commands、qemu-center CLI、Vitest/pytest 不涉及。

**Spec:** `docs/superpowers/specs/2026-09-20-app-hibernate-balloon-reclaim.md`

## Global Constraints

- 不改变 QEMU 启动内存上限、qcow2、容器状态或 VM 生命周期。
- 回收失败不覆盖应用暂停成功结果。
- 不把自动化结果解释为固定宿主内存节省。
- 后端改动必须通过 `cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo test --manifest-path qemu-center/Cargo.toml`。

## Review Focus

- `force-stop` 成功但 balloon 不可用：应用仍应显示暂停成功。
- 前置校验失败：不能产生额外 qemu-center 调用。
- 已有 active/unknown 实例：仍由 qemu-center fail-closed，Tauri 不自行计算目标。
- 重复点击：保持现有 busy 锁，不增加并发回收。
- 真实 host working set：只记录现场数据，不在代码或 UI 中承诺固定节省量。

---

### Task 1: 固定暂停后回收策略

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`（命令辅助函数与 hibernate 成功分支）
- Test: `src-tauri/src/commands/mod.rs` 内现有测试模块

**Interfaces:**
- Produces `run_guest_reclaim_after_app_hibernate(app_stopped, reclaim)`，仅在
  `app_stopped == true` 时调用传入的回收闭包，并返回闭包结果。

- [x] **Step 1: Write the failing test**

```rust
#[test]
fn app_hibernate_reclaims_only_after_force_stop_succeeds() {
    let mut calls = 0;
    assert!(run_guest_reclaim_after_app_hibernate(true, || {
        calls += 1;
        true
    }));
    assert_eq!(calls, 1);

    assert!(!run_guest_reclaim_after_app_hibernate(false, || {
        calls += 1;
        true
    }));
    assert_eq!(calls, 1);
}
```

- [x] **Step 2: Run the focused test and verify it fails for the missing helper**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::tests::app_hibernate_reclaims_only_after_force_stop_succeeds -- --exact`

Expected: FAIL because `run_guest_reclaim_after_app_hibernate` does not exist yet.

- [x] **Step 3: Implement the minimal policy and wire the success branch**

```rust
fn run_guest_reclaim_after_app_hibernate<F>(app_stopped: bool, reclaim: F) -> bool
where
    F: FnOnce() -> bool,
{
    app_stopped && reclaim()
}

// inside the successful stop_app branch:
let reclaimed = run_guest_reclaim_after_app_hibernate(true, || {
    try_auto_reclaim_guest_memory(&vm)
});
Ok(result(true, if reclaimed { "idle_app_reclaimed" } else { "idle_app" }.into()))
```

- [x] **Step 4: Run the focused test and the relevant Rust suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::tests::app_hibernate_reclaims_only_after_force_stop_succeeds -- --exact`

Expected: PASS. Then run the complete four-suite project gate before reporting the change.

- [x] **Step 5: Update the handoff evidence**

Record that the code path now attempts one qemu-center reclaim after successful app hibernation,
while real host working-set savings remain pending manual WHPX measurement.
