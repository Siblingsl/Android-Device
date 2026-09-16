# Beta P6b Runtime Metrics Implementation Plan

> **For agentic workers:** execute this plan task by task and keep the required
> TypeScript, Vitest, and both Rust crate gates green after each stage.

**Goal:** Replace the four honest `不可用（无数据源）` cells in the read-only
cross-track comparison with real, provenance-preserving values from the two
tracks' existing read snapshots.

**Scope:** This plan is explicitly authorized for `src-tauri` backend changes.
It does not add writes, background polling, a new service call from the shell,
or a new qemu-center command. Docker and QEMU both enrich the read data they
already publish.

## Metric contract

Each instance may carry an optional `RuntimeMetrics` record:

- `cpuQuotaCores` + `cpuUnlimited`: a capped CPU quota, or an explicitly known
  unlimited quota; missing fields mean the inspect read could not answer.
- `memoryQuotaBytes` + `memoryUnlimited`: the same distinction for memory.
- `diskBytes`: the container writable-layer size from `docker inspect --size`
  (`SizeRw`), including zero only when Docker reported that real value.
- `startedAt` / `finishedAt`: Docker's ISO timestamps. The comparison computes
  the last-run duration as `StartedAt` → `FinishedAt`, or `StartedAt` → snapshot
  time while running. This is labelled as the metric's duration semantics and
  is not presented as Android boot-completion time.

The comparison is grouped by Android major version, so aggregation is explicit:
quota values show distinct values, disk is the sum of known instance sizes, and
start duration is the average of known durations. Partial data retains the
known value and states how many instances were unavailable; no data uses an
unavailable reason; a group with zero instances does not fabricate a metric.

## Stages

### Stage 1 — failing contract tests

- Add Rust parser tests for Docker inspect JSON: capped/unlimited resources,
  `SizeRw`, valid timestamps, and missing fields.
- Add Python guest-runner tests for the same metric projection.
- Add TypeScript aggregation tests for complete, partial, unlimited, empty, and
  duration cases; update the old no-source assertions to require real cells.

### Stage 2 — backend and snapshot contract

- Add the shared serializable metrics shape to Rust models and TypeScript types.
- Add a batched `docker inspect --size` enrichment only to `DockerInfo` refresh;
  keep the fast generic device-list path unchanged.
- Extend the existing QEMU guest details read and `redroid_list` enrichment.
- Publish metrics through `RuntimeInstanceRow` without changing shell behavior.

### Stage 3 — pure comparison rendering

- Aggregate and format the four metrics in `runtimeCompare.ts`.
- Remove the four no-source cells while preserving unavailable-source semantics.
- Add bilingual copy and render value/partial/unavailable cells accessibly.

### Stage 4 — verification and evidence

- Run targeted tests, then the required full gates and production build.
- Keep the manual P7-1 and clean-Windows evidence items marked unexecuted;
  backend metrics being implemented does not constitute real-device evidence.

