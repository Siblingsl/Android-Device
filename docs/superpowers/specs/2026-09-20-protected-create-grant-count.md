# Protected create grant-count specification

## Goal

Make the protected QEMU instance-create workflow request exactly as many
single-use execution grants as the stages it consumes, so a valid authorized
create cannot fail at the final activation stage because of a local count
mismatch.

## Stage contract

The non-upgrade create workflow consumes one distinct grant for each stage:

1. `build`
2. `seed`
3. `authorize` (guest online authorization receipt)
4. `activate` (host Docker creation and protected runner activation)

The upgrade workflow remains a two-stage workflow (`build`, `upgrade`).

## Constraints

- Keep each grant single-use and preserve server-side JTI replay protection.
- Do not reuse a grant across stages.
- Do not weaken host receipt verification or guest online authorization.
- Keep the change limited to the source of the stage-count request and its
  regression test.

## Acceptance

1. The create command requests four grants.
2. The upgrade command requests two grants.
3. A regression test fails before the correction and passes after it.
4. Tauri and qemu-center tests plus the repository TypeScript/Vitest gates pass.
