# Device detail control layout implementation plan

## Stage 1 — regression coverage

- Assert the control DOM exposes a dedicated preview row and controlled disclosure state.
- Assert CSS uses a full-width preview row and a symmetric, stretching two-column action grid.

## Stage 2 — minimal implementation

- Add a local preview open state to `Control` and reuse `ControlActionShelf` for collapse/expand.
- Move the existing `DevicePreview` into the full-width preview shelf.
- Change the action dock and assistant modules to equal-width two-column grids.

## Stage 3 — verification

- Run the targeted layout test.
- Run TypeScript, the full Vitest suite, and the production build.
- Run `git diff --check` and note any unrelated backend environment test failures separately.
