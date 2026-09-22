# Case Scope

## meta
- case_id: runtime-core-protection-20260917
- created: 2026-09-17T14:08:28.0683500+08:00
- operator: local
- project_root: F:\code\project\Android-Device
- primary_skill: edr-bypass-re/SKILL.md
- primary_id: R18
- lead_role: lead
- specialist_roles: [cre, cae, cce, doc]
- hint: Android redroid runtime memory optimization and server-authoritative anti-reverse core delivery

## auth
- status: granted
- basis: own_system
- evidence_of_auth: cli-flag AuthGranted or AuthStatus=granted
- MUST NOT proceed if status != granted

## in_scope
- assets:
  - F:\code\project\Android-Device\src\
  - F:\code\project\Android-Device\src-tauri\
  - F:\code\project\Android-Device\qemu-center\
- surfaces: [android_client_protection, desktop_client_authorization, local_runtime_measurement]
- activities: [static_design_review, local_code_change, offline_protocol_tests]

## out_of_scope
- assets: [external_production_services, third_party_apks, user_data]
- activities: [dos, phishing_real_users, unrestricted_exfil, live_target_scanning, bypass_implementation]

## network_profile
- mode: offline
- notes: |
    offline | lab_only | authorized_target_only | unrestricted_lab
    Change mode only after auth.status = granted.

## deliverables
- report: true
- field_journal: true
- diagrams: true
- timeline: true

## constraints
- timebox: {}
- stealth: low
- data_handling: anonymize

## signoff
- ready_for_act: true
- checklist:
  - [x] auth.status = granted
  - [x] in_scope.assets non-empty OR offline sample path set
  - [x] network_profile.mode chosen
  - [x] out_of_scope reviewed
  - [x] roles assigned (see skills/ops/role-map.md)
  - [x] ready_for_act = true for offline local work only

## ops_refs
- skills/ops/scope-contract.md
- skills/ops/evidence-finding-path.md
- skills/ops/role-map.md
- skills/ops/timeline-workitem.md
- skills/ops/IDENTITY.md
