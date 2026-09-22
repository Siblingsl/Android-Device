# QEMU CLI Capability Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent standalone `qemu-center redroid create` from creating a container unless it receives a short-lived server-signed execution grant that matches the VM and instance.

**Architecture:** The Tauri protected preset flow writes only the current activation grant to a temporary job file and passes the file path to qemu-center. qemu-center verifies the server signature with a public-key ring embedded at build time, validates the grant claims and target, then proceeds with Docker creation. The guest runner remains the authoritative device-proof and one-time JTI consumer; qemu-center verification is a host-side defense-in-depth gate.

**Tech Stack:** Rust 2021, clap, serde/serde_json, base64, ed25519-dalek, Tauri Rust bridge, PowerShell release workflow.

**Spec:** `docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md` §6.3 and §9.

## Global Constraints

- The release client must contain public keys only; server signing secrets never enter the desktop or qemu-center build.
- Grant data must not be placed in process arguments or ordinary logs; only a temporary file path crosses the process boundary.
- qemu-center must fail closed when the grant file, embedded key ring, signature, target, action, or time window is invalid.
- Guest-side device proof and one-time JTI consumption remain mandatory; host verification must not replace them.
- Preserve the existing qemu-center memory/QMP guards and the project four-suite validation gate.

## Review Focus

- Missing grant file: the CLI must refuse before volume creation or Docker execution.
- Tampered payload/signature or unknown key id: the CLI must refuse without trusting caller-supplied keys.
- Valid grant for another VM/instance/action or expired grant: the CLI must refuse.
- Multiple public keys during rotation: either trusted key must verify, but a key outside the embedded ring must fail.
- Temporary grant cleanup: success, failure, and serialization errors must not leave the grant file behind.

---

### Task 1: qemu-center grant verifier

**Files:**
- Modify: `qemu-center/Cargo.toml`
- Modify: `qemu-center/src/main.rs`
- Test: `qemu-center/src/main.rs` unit tests

**Interfaces:**
- Produces `verify_execution_grant_file(path, expected_vm, expected_instance) -> Result<ExecutionGrantClaims, String>`.
- Reads build-time `RDC_AUTH_PUBLIC_KEYS` as `key-id=base64url-public-key` comma-separated entries.
- `redroid create` requires `--execution-grant-file <path>` and verifies it before any guest Docker command.

- [x] Write failing tests for missing file, invalid signature, target mismatch, and valid rotation key.
- [x] Run the focused qemu-center tests and observe failure because the verifier/flag is absent.
- [x] Add the minimal verifier and required CLI flag; reject missing build-time key configuration.
- [x] Run focused tests, then the full qemu-center suite.

### Task 2: Tauri protected create bridge

**Files:**
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src-tauri/src/services/qemu_presets.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Test: existing Rust argument and preset workflow tests

**Interfaces:**
- Produces `args_redroid_create_with_grant_file(request, path) -> Vec<String>`.
- Writes the activation grant into the protected job directory immediately before CLI creation.
- Passes only `--execution-grant-file <path>` to qemu-center; the grant JSON never appears in argv or logs.

- [x] Add a failing argv assertion for the grant-file flag and a failing workflow assertion that activation grant is staged before container creation.
- [x] Run focused Tauri tests and observe the expected failure.
- [x] Implement staging, CLI argument forwarding, and cleanup on every result path.
- [x] Run focused Tauri tests and the full Tauri suite.

### Task 3: release configuration and documentation

**Files:**
- Modify: `.github/workflows/windows-release.yml`
- Modify: `qemu-center/README.md`
- Modify: `docs/2026-09-17-runtime-memory-authorization-acceptance.md`
- Modify: `docs/2026-09-17-runtime-memory-and-core-delivery-report.md`
- Create: `work/runtime-core-protection-20260917/evidence/E-062-qemu-cli-capability-gate-20260920.md`

- [x] Build qemu-center with `RDC_AUTH_PUBLIC_KEYS` present and fail the release job when the key ring is missing.
- [x] Document qemu-center as an internal orchestration binary, not an independently distributable client.
- [x] Record tests, artifact scanning, and the explicit guest plaintext boundary.
- [x] Run TypeScript, frontend, Tauri, qemu-center, authorization-service, guest, release build, and release scan gates.
