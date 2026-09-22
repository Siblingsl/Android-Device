# Protected activation authorization preflight

## Goal

Ensure a protected Redroid create cannot start Docker before the guest has
successfully consumed the server-issued one-time execution grant.

## Scope

- Add a guest-side `authorize` runner action that verifies and consumes the
  activation grant, then writes a one-time marker inside the per-operation
  `/run/rdc-presets/<job>` directory.
- Pass that marker path to `qemu-center redroid create`; the CLI must verify the
  signed grant and the guest marker before issuing any Docker command.
- Make the existing `activate` stage verify and remove the marker without
  consuming the same JTI a second time.
- Remove the marker during every host cleanup path.
- Add focused tests for missing, mismatched, replayed, and valid markers, then
  rerun the complete repository gates and release scan.

## Safety boundary

The marker is not a replacement for the signed grant or server consumption. It
only proves that the same guest runner already completed the online preflight;
the CLI still verifies the grant signature, expiry, VM, instance, and artifact
claims. The live runner remains plaintext during execution and is still within
the documented administrator/root/debugger boundary.

## Acceptance

- An unavailable authorization service fails before `docker volume create` or
  `docker run` for a protected create.
- A copied `qemu-center` binary with only a signed grant cannot create without
  the guest marker.
- The activation JTI is consumed exactly once.
- Existing upgrade, restore, details, and debug-only paths retain their current
  authorization behavior.
