# E-019 — Protected download session handoff

The protected runtime download path first validates or acquires the shared
runtime session, then passes that session into the concrete authorization client
used for manifest and encrypted-chunk retrieval. This closes a functional and
security boundary where an authorized runtime could otherwise create a fresh
client without its in-memory lease and fail as `NotRegistered`.

TDD evidence:

- A fake-transport regression was added before the handoff helper existed; the
  focused test failed at compilation because the handoff function was missing.
- After implementation, the focused test passed and confirmed that the
  download client has the exact validated session before it requests the
  artifact. The fake transport then fails at its intended network boundary.

The full project validation rerun is recorded after this source change in the
same case timeline. Manual production authorization and runtime acceptance
remain required.
