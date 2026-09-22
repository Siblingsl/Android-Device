# E-074 — Live VM start memory guard (2026-09-20)

## Command

```powershell
.\qemu-center\target\debug\qemu-center.exe vm start node1 --state-dir qemu-center\state
```

## Result

- Start was rejected before QEMU creation:
  `host available memory is too low to start VM "node1": current 663 MiB,
  required at least 5120 MiB (VM 4096 MiB + 1024 MiB headroom)`.
- Exit code was non-zero.
- A follow-up process check found no `qemu-system-x86_64` process.
- No VM disk, snapshot, or node configuration was changed by this attempt.

## Conclusion

The runtime admission guard is active on the real Windows host and prevents a
4 GiB node from being launched while the host cannot reserve the node plus the
configured safety headroom. This is a fail-closed safety result, not a claim
that the host has a fixed memory saving or that the real Tauri walkthrough is
complete.
