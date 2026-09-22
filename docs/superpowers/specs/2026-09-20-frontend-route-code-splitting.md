# Frontend route code-splitting specification

## Goal

Reduce the initial JavaScript payload of the desktop UI by loading the heavy
Docker and QEMU runtime panels only when their track is mounted, without
changing route behavior, task persistence, or panel accessibility semantics.

## Constraints

- Keep `RuntimePage` as the merged route and preserve the existing `?track=` and
  `?view=compare` behavior.
- Keep a mounted panel alive while its track owns a long-running task.
- Do not add a wrapper DOM element around either panel; the panel root must
  remain the direct child used by the existing layout selectors.
- Use React/Vite dynamic imports only; add no dependency.
- Do not change Tauri commands, QEMU state, Docker behavior, or authorization.

## Acceptance

1. Docker and QEMU panels are loaded through separate dynamic imports.
2. The active panel still renders with its existing tabpanel id and labels
   after the import resolves.
3. Switching tracks and legacy `/docker`/`/qemu` redirects keep their current
   behavior, and a background task does not lose its mounted panel.
4. Production build emits separate panel chunks and the previous 913 kB
   single-index warning is materially reduced or removed.
5. TypeScript, Vitest, build, and `git diff --check` pass.
