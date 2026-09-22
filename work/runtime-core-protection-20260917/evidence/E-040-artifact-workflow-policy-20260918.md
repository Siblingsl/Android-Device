# E-040 — Server-side artifact/workflow policy

Date: 2026-09-18

## Finding

Before this change, `/v1/execution-grants` verified that an artifact existed
and that its requested SHA-256 matched the published file, but it did not
verify that the artifact was approved for the requested workflow. A reversed
client with a valid session could therefore ask the service to sign a different
published artifact for `preset_apply`, `preset_restore`, or `preset_details`.

This was an authorization-boundary weakness, not a signature-forgery issue.

## Fix

- The authorization service now allows only `qemu-guest-script` with
  `preset_apply`.
- `qemu-guest-script-universal` is allowed only with `preset_restore` or
  `preset_details`.
- Unknown pairs are rejected with `403 artifact_workflow_mismatch` before the
  request nonce is reserved.
- The same policy is checked again at execution-grant consumption, so a signed
  but mismatched envelope cannot cross the server boundary.
- Artifact download remains separately session/capability protected; this
  change specifically closes executable workflow repurposing.

## Verification

- Added a route-level regression that first reproduces the mismatch as a
  failure, then verifies the fixed response is 403.
- The test reuses the rejected request nonce with the approved universal
  workflow and receives 200, proving the mismatch rejection did not consume it.
- Added a signed-consume negative case and a fail-closed policy unit test.
- Focused authorization tests: 3 execution-policy tests passed.

Production service deployment, rendered-runner copy/tamper testing, and key
rotation remain separate manual acceptance items.
