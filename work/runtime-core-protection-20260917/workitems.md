# Work Items

| ID | title | role | targets | surface | status | evidence | notes |
|----|-------|------|---------|---------|--------|----------|-------|
| WI-001 | Establish scope and auth | lead | case | process | done | | scope.md: auth granted; ready_for_act=true |
| WI-002 | Measure and optimize runtime resource policy | lead | src-tauri/qemu-center | local_runtime_measurement | implemented | E-001,E-005 | snapshot/profile/scheduler/ART/app-hibernation code landed; component breakdown added; manual matrix pending |
| WI-003 | Implement server-authoritative core delivery | lead | src-tauri/authorization-service | desktop_client_authorization | implemented | E-002,E-003 | signed lease, encrypted chunks, Rust gate; production deployment pending |
| WI-004 | Produce report and acceptance evidence | doc | docs/work | documentation | in_progress | E-001,E-002,E-003,E-004,E-005 | automated gate complete; manual acceptance pending |

## Coverage
- [x] Recon/analysis complete for in_scope assets
- [x] Critical/High candidates triaged (or N/A for pure RE)
- [x] Validated findings have Evidence (E-*)
- [x] Path documented (attack/call/solve)
- [x] Timeline continuous across major phases
- [x] Report via docs-generator
- [x] field-journal anonymized

## Refs
- skills/ops/timeline-workitem.md
- skills/ops/evidence-finding-path.md
