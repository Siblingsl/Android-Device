# QEMU Instance Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete QEMU creation presets and reversible existing-instance upgrades.

**Architecture:** Reuse host-independent Docker build-context preparation. The desktop transfers a context and a Python stdlib guest runner over SSH; guest Docker builds and manages containers. Existing instances are upgraded against a cloned volume, retaining the old instance for restore.

**Tech Stack:** Rust/Tauri, React/TypeScript, Python stdlib, guest Docker, OpenSSH.

**Spec:** docs/superpowers/specs/2026-09-15-qemu-presets.md

## Global Constraints

- No host Docker Desktop dependency; build inside the QEMU node.
- Upgrade preserves Android version and runtime settings; clone data and retain rollback.
- Do not automatically modify current r1. Do not commit/push feature work.
- Keep downloaded assets, guest state and keys out of Git.

### Task 1: Shared preset context

**Files:** src-tauri/src/services/docker.rs, src-tauri/src/services/preset.rs, services/mod.rs.

**Interfaces:** `preset::prepare(req: &CreateInstanceRequest, base: &str, work: &Path) -> Result<(), String>` prepares Dockerfile/bin/data/etc/modules/overlay without launching Docker. `preset::validate_gapps(path: &Path, version: &str) -> Result<(), String>` rejects incompatible metadata.

- [ ] Add tests preparing a real miniature GApps zip and rejecting 13/14 or arm64/x86_64 mismatch.
  ```rust
  assert!(validate_gapps(Path::new("MindTheGapps-13.0.0-x86_64.zip"), "14").is_err());
  ```
- [ ] Run focused Rust tests, observe missing preparation behavior.
- [ ] Extract the existing preparation closure; both guest and desktop use it.
- [ ] Run focused tests and Rust check.

### Task 2: UI and wire contract

**Files:** src/pages/QemuCenter.tsx, src/pages/QemuCenter.test.tsx, src/types/index.ts, src/services/deviceService.ts, src/i18n/pages/qemu.ts.

**Interfaces:** `QemuRedroidCreateRequest` keeps existing fields and adds optional `image`, `androidVersion`, `installGapps`, `gappsZip`, `installMagisk`, `installLsposed`, `installShamiko`, `installCloak`, `installNativeCloak`, `nativeCloakZip`, `moduleZips`, `spoofProfileId`, `spoofProfile`, `spoofAbilist`, `hidePackages`, `cleanTraces`. `QemuService.redroidUpgrade(req)` uses `qemu_redroid_upgrade`; `redroidRestore(vm,name)` uses `qemu_redroid_restore`. Upgrade request is the creation request; backend ignores resource overrides and derives existing settings. Instance rows may include optional `androidVersion`, `image`, `rollbackAvailable`.

- [ ] Add UI tests that choosing upgrade populates the name and that failure details remain visible; test GApps/dependency controls.
  ```tsx
  fireEvent.click(screen.getByRole("button", {name: "升级预装"}));
  expect(screen.getByText(/保留数据/)).toBeTruthy();
  ```
- [ ] Observe tests fail before adding controls.
- [ ] Add complete preset fields, dependency handling, upgrade/restore actions and translations.
- [ ] Run QemuCenter tests and TypeScript check.

### Task 3: Guest pipeline and bridge

**Files:** src-tauri/src/services/qemu_presets.rs, src-tauri/src/services/qemu_guest.py, src-tauri/src/services/qemu.rs, src-tauri/src/commands/mod.rs, src-tauri/src/lib.rs, qemu-center/src/main.rs.

**Interfaces:** `qemu_presets::apply(req, upgrade) -> Result<QemuCliOutput,String>`; `restore(vm,name)`; stdlib runner CLI `qemu_guest.py request.json`, actions build/create/upgrade/restore/details. SSH state uses existing portable registry and keys. CLI image argv must remain quoted as one remote argument.

- [ ] Test guest configuration cloning preserves bind mounts, caps, ports and command; failed activation restores previous volume/container.
  ```python
  self.assertEqual(clone_config(fixture, "new-image", "old-data", "new-data")["HostConfig"]["Binds"], ["new-data:/data"])
  ```
- [ ] Observe test failure, implement guest runner and bridge.
- [ ] Validate same-version guard before stop; clone `/data`, clear stale completion marker, seed adb key, activate/probe, automatic rollback.
- [ ] Run guest tests, backend/CLI tests, UI checks, and a disposable runtime probe. Document results and limitations.
