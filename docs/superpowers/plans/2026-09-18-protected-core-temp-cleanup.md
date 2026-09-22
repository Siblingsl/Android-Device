# Protected core temporary-file cleanup

**Goal:** reduce the amount of plaintext protected runner material left behind
after a desktop process crash, without changing the server-authoritative
delivery or guest execution protocol.

## Tasks

- [x] Add a focused failing test proving that only abandoned final core files
  are removed; partial download files and unrelated files remain untouched.
- [x] Add a once-per-process startup cleanup before a new protected download;
  fail closed if a matching file cannot be inspected or removed.
- [x] Keep the cleanup non-recursive and refuse symlinks/non-regular files.
- [x] Run the focused test, full Rust/Python/frontend gates, formatting and
  release-core scan; record the evidence and update the handoff.

## Boundary

This is best-effort filesystem hygiene, not secure erasure. The core still has
to exist as plaintext briefly to be transferred into the guest, so high-value
algorithms remain server-side and the existing device-bound execution grant
remains mandatory.
