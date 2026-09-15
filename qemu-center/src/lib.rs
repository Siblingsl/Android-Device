//! qemu-center library: all logic lives here so the pure command-assembly /
//! parsing API is a real public surface (and unit-testable without the CLI
//! binary dragging dead-code analysis over it).
//!
//! Modules, in dependency order:
//! * [`iso`] — zero-dependency ISO9660 builder/parser (retired seed carrier,
//!   kept as a library API + test asset)
//! * [`fat`] — zero-dependency FAT16 image builder (the cloud-init seed disk)
//! * [`cloudinit`] — NoCloud seed renderers
//! * [`vm`] — QEMU/qemu-img command assembly, port allocation, state.json
//! * [`qmp`] — minimal QMP client (the only safe writer for a live disk)
//! * [`guest`] — SSH access + guest-side scripts
//! * [`redroid`] — redroid container command assembly (guest-internal docker)
//! * [`doctor`] — host readiness diagnostics
//! * [`verify`] — the seven phase-0 acceptance checks
//! * [`exec`] — std-only process execution (the only runtime glue)

pub mod cloudinit;
pub mod doctor;
pub mod exec;
pub mod fat;
pub mod guest;
pub mod iso;
pub mod qmp;
pub mod redroid;
pub mod setup;
pub mod verify;
pub mod vm;
