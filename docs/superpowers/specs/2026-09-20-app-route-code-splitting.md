# App route code-splitting specification

## Goal

Reduce the initial JavaScript payload of the desktop UI by loading page-level
features only when their route is opened. The app shell, router, i18n provider,
and layout remain available immediately.

## Scope

- Split the page modules currently imported statically by `src/App.tsx`.
- Keep the merged `/containers` route and its existing Docker/QEMU panel
  lifecycle unchanged.
- Keep `/docker` and `/qemu` redirects, `/terminal`, and the dedicated
  `?window=device` entry working.
- Keep each page component's existing named/default export contract; adapt
  named exports at the lazy boundary instead of changing page modules.

## Constraints

- Use React `lazy` and `Suspense` with existing dependencies only.
- Do not add a DOM wrapper inside `AppLayout` or around the runtime panels.
- Do not change Tauri commands, service calls, QEMU/Docker behavior, or
  authorization behavior.
- Use a null fallback so route loading does not introduce a permanent layout
  element or alter page-specific markup.

## Acceptance

1. `src/App.tsx` has no static page imports for route components; route modules
   are loaded through explicit dynamic imports.
2. The main production index chunk is materially smaller than the recorded
   944.01 kB baseline, and page chunks are emitted separately.
3. The merged runtime tests still cover legacy redirects, track switching,
   mounted background tasks, and panel accessibility after lazy resolution.
4. The dedicated device window route still renders its page after its lazy
   module resolves.
5. TypeScript, Vitest, production build, and `git diff --check` pass.
