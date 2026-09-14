//! Simulated battery curve ("电池伪装").
//!
//! A deterministic state machine maps (serial, wall clock) to a plausible
//! battery level so every instance looks like a phone that has been running
//! for a while instead of a container stuck at 100% charging forever.
//!
//! Shape: discharge 100 → 15 over ~14 h, charge 15 → 100 over ~2.5 h, then
//! repeat. `apply_battery_policy` pushes the current state into the container
//! with `dumpsys battery set …` (see the module docs for what AOSP's shell
//! interface supports). The curve is computed on the host — no device I/O is
//! needed to *read* a state, which also keeps it testable.

use std::time::Duration;

use crate::models::{BatteryState, ShellResult};
use crate::services::{docker, log, root, util};

/// Discharge window: 100 → 15 (seconds).
const DISCHARGE_SECS: u64 = 14 * 3600;
/// Charge window: 15 → 100 (seconds).
const CHARGE_SECS: u64 = 9_000;
/// One full discharge + charge cycle.
const CYCLE_SECS: u64 = DISCHARGE_SECS + CHARGE_SECS;
/// Lowest level the discharge curve reaches before the charge phase.
const LEVEL_MIN: u32 = 15;
/// Full level.
const LEVEL_MAX: u32 = 100;

// BatteryManager status codes.
const STATUS_CHARGING: u32 = 2;
const STATUS_DISCHARGING: u32 = 3;
const STATUS_NOT_CHARGING: u32 = 4;
const STATUS_FULL: u32 = 5;

/// Seconds since the Unix epoch (wall clock is the state machine's input).
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// FNV-1a 64-bit — stable across runs, no dependency on the default hasher
/// (which is randomized per process and would break determinism).
fn seed_for(serial: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in serial.as_bytes() {
        h ^= *byte as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// Per-instance phase offset so two containers never share the same curve
/// position at the same time.
fn cycle_offset_for(serial: &str) -> u64 {
    seed_for(serial) % CYCLE_SECS
}

/// Eased position with a small deterministic ripple:
/// `f(p) = p + a·sin(2π·k·p + φ)`. The derivative stays positive
/// (1 ± a·2π·k with a = 0.015, k = 7 → ∈ [0.34, 1.66]), so the curve is
/// strictly monotonic in `p` — the "noise" can never make the level rise.
fn ripple(p: f64, seed: u64) -> f64 {
    const AMPLITUDE: f64 = 0.015;
    const CYCLES: f64 = 7.0;
    let phase = (seed % 1000) as f64 / 1000.0 * std::f64::consts::TAU;
    p + AMPLITUDE * (std::f64::consts::TAU * CYCLES * p + phase).sin()
}

/// Battery state for a serial at `now_secs`. Pure and deterministic: the same
/// (serial, now_secs) always yields the same state. An empty serial yields a
/// neutral, non-charging full battery rather than a misleading curve.
pub fn battery_state_for(serial: &str, now_secs: u64) -> BatteryState {
    let serial = serial.trim();
    if serial.is_empty() {
        return BatteryState {
            level: LEVEL_MAX,
            status: STATUS_NOT_CHARGING,
            charging: false,
        };
    }
    let seed = seed_for(serial);
    let pos = now_secs.wrapping_add(cycle_offset_for(serial)) % CYCLE_SECS;

    if pos < DISCHARGE_SECS {
        let p = pos as f64 / DISCHARGE_SECS as f64;
        // Discharge: fraction of charge remaining, 1 → 0.
        let frac = (1.0 - ripple(p, seed)).clamp(0.0, 1.0);
        let level = level_from_fraction(frac);
        BatteryState {
            level,
            status: STATUS_DISCHARGING,
            charging: false,
        }
    } else {
        let p = (pos - DISCHARGE_SECS) as f64 / CHARGE_SECS as f64;
        let frac = ripple(p, seed).clamp(0.0, 1.0);
        let level = level_from_fraction(frac);
        let status = if level >= LEVEL_MAX {
            STATUS_FULL
        } else {
            STATUS_CHARGING
        };
        BatteryState {
            level,
            status,
            charging: true,
        }
    }
}

fn level_from_fraction(frac: f64) -> u32 {
    let span = (LEVEL_MAX - LEVEL_MIN) as f64;
    ((LEVEL_MIN as f64 + span * frac).round() as i64).clamp(LEVEL_MIN as i64, LEVEL_MAX as i64)
        as u32
}

/// Push the current simulated state into the container via the root channel.
///
/// AOSP BatteryService's shell interface (`dumpsys battery`) accepts
/// `reset`, `unplug`, `set ac|usb|wireless on|off`, `set level <n>` and
/// `set status <n>`. It does **not** accept `set temperature` on the images we
/// target, so temperature is deliberately not spoofed here (see
/// docs/anti-detection-hardwalls.md). Order matters: `reset` clears previous
/// overrides, the power-source command fixes the charging direction, and the
/// explicit `set level` / `set status` win over the recomputed defaults.
pub fn apply_battery_policy(serial: &str) -> ShellResult {
    let state = battery_state_for(serial, now_secs());
    let Some(container) = root::container_id_for(serial) else {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "仅容器实例支持电池伪装（物理设备请使用真实充电控制）".into(),
            exit_code: -1,
        };
    };
    let power = if state.charging {
        "dumpsys battery set usb on;"
    } else {
        "dumpsys battery unplug;"
    };
    let script = format!(
        "dumpsys battery reset >/dev/null 2>&1; {power} dumpsys battery set level {}; \
         dumpsys battery set status {}; echo applied",
        state.level, state.status
    );
    let result = util::run_command_timeout(
        &docker::docker_bin(),
        &["exec", &container, "sh", "-c", &script],
        Duration::from_secs(20),
    );
    if result.success {
        log::info(
            "Battery",
            &format!(
                "[{serial}] battery level={} status={} charging={}",
                state.level, state.status, state.charging
            ),
        );
    } else {
        log::warn(
            "Battery",
            &format!("[{serial}] apply battery failed: {}", result.stderr.trim()),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_is_deterministic_for_the_same_inputs() {
        for t in [0u64, 1_000, 50_000, 60_000, 123_456, 999_999] {
            assert_eq!(
                battery_state_for("emulator-5554", t),
                battery_state_for("emulator-5554", t)
            );
        }
    }

    #[test]
    fn discharge_never_rises_within_a_cycle() {
        let serial = "mono-discharge";
        let mut prev: Option<u32> = None;
        // 60 s steps across two full cycles.
        for step in 0..(2 * CYCLE_SECS / 60) {
            let state = battery_state_for(serial, step * 60);
            if state.charging {
                // A new charge phase resets the monotonic run.
                prev = None;
                continue;
            }
            if let Some(previous) = prev {
                assert!(
                    state.level <= previous,
                    "level rose during discharge: {previous} -> {} at t={}",
                    state.level,
                    step * 60
                );
            }
            prev = Some(state.level);
        }
    }

    #[test]
    fn charge_phase_reaches_full_and_uses_charging_statuses() {
        let serial = "full-charge";
        let offset = cycle_offset_for(serial);
        let charge_start = (CYCLE_SECS - offset % CYCLE_SECS) + DISCHARGE_SECS;
        let mut saw_full = false;
        for step in 0..(CHARGE_SECS / 60) {
            let state = battery_state_for(serial, charge_start + step * 60);
            assert!(state.charging, "expected charging phase at step {step}");
            assert!(
                state.status == STATUS_CHARGING || state.status == STATUS_FULL,
                "unexpected status {}",
                state.status
            );
            if state.status == STATUS_FULL {
                assert_eq!(state.level, LEVEL_MAX);
                saw_full = true;
            }
        }
        assert!(saw_full, "charge phase must reach 100%/full");
    }

    #[test]
    fn every_state_wraps_after_one_cycle() {
        for serial in ["wrap-a", "wrap-b", "wrap-c"] {
            for t in [0u64, 1_234, 40_000, 50_000, 59_000] {
                assert_eq!(
                    battery_state_for(serial, t),
                    battery_state_for(serial, t + CYCLE_SECS),
                    "cycle must wrap for {serial} at t={t}"
                );
            }
        }
    }

    #[test]
    fn serials_get_staggered_phase_offsets() {
        let offsets: Vec<u64> =
            ["alpha", "beta", "gamma"].iter().map(|s| cycle_offset_for(s)).collect();
        assert!(offsets.iter().all(|offset| *offset < CYCLE_SECS));
        // Different serials must not all line up (a collision between two of
        // the three is astronomically unlikely but would still be a bug).
        assert!(offsets[0] != offsets[1] && offsets[1] != offsets[2]);
    }

    #[test]
    fn levels_stay_inside_the_15_to_100_band() {
        for serial in ["band-a", "band-b"] {
            for step in 0..(CYCLE_SECS / 300) {
                let state = battery_state_for(serial, step * 300);
                assert!(
                    (LEVEL_MIN..=LEVEL_MAX).contains(&state.level),
                    "level {} out of band",
                    state.level
                );
                if state.charging {
                    assert!(matches!(state.status, STATUS_CHARGING | STATUS_FULL));
                } else {
                    assert_eq!(state.status, STATUS_DISCHARGING);
                }
            }
        }
    }

    #[test]
    fn empty_serial_is_neutral_and_non_charging() {
        let state = battery_state_for("   ", 12_345);
        assert_eq!(state.level, LEVEL_MAX);
        assert_eq!(state.status, STATUS_NOT_CHARGING);
        assert!(!state.charging);
    }
}
