use std::collections::VecDeque;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::resource_monitor::MemoryPressure;

fn default_false() -> bool {
    false
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LifecyclePolicy {
    pub idle_timeout_minutes: u32,
    #[serde(default = "default_false")]
    pub keep_vm_warm: bool,
    pub max_parallel_starts: u32,
    pub protected_instance_ids: Vec<String>,
    /// When critical host pressure is observed, try one safe idle reclaim
    /// before rejecting a new start. Older settings deserialize as enabled.
    #[serde(default = "default_true")]
    pub auto_release_idle_on_critical: bool,
}

impl Default for LifecyclePolicy {
    fn default() -> Self {
        Self {
            idle_timeout_minutes: 30,
            keep_vm_warm: false,
            max_parallel_starts: 1,
            protected_instance_ids: Vec::new(),
            auto_release_idle_on_critical: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ActivityKind {
    #[serde(rename = "user_window")]
    UserWindow,
    #[serde(rename = "adb")]
    Adb,
    #[serde(rename = "stream")]
    Stream,
    #[serde(rename = "recording")]
    Recording,
    #[serde(rename = "transfer")]
    Transfer,
    #[serde(rename = "automation")]
    Automation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActivity {
    pub instance: String,
    pub kind: ActivityKind,
    /// ISO-8601 timestamp supplied by the frontend; pure state tests use the
    /// `mark_activity` method with `SystemTime` directly.
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", content = "detail", rename_all = "camelCase")]
pub enum StartDecision {
    Starting,
    Ready,
    Queued,
    Blocked(MemoryPressure),
    Failed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleReleaseResult {
    pub instance: String,
    pub released: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppHibernateResult {
    pub scope: String,
    pub instance: String,
    pub serial: String,
    pub package: String,
    pub released: bool,
    pub reason: String,
}

#[derive(Debug, Clone)]
struct ActivityRecord {
    kind: ActivityKind,
    at: SystemTime,
}

#[derive(Debug, Clone)]
pub struct SchedulerState {
    policy: LifecyclePolicy,
    starts_in_flight: u32,
    starting: Vec<StartRequest>,
    queued_starts: VecDeque<StartRequest>,
    activities: Vec<ActivityRecordWithInstance>,
    reclaim_in_flight: bool,
}

#[derive(Debug, Clone)]
struct ActivityRecordWithInstance {
    instance: String,
    record: ActivityRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StartRequest {
    vm: String,
    instance: String,
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self::with_policy(LifecyclePolicy::default())
    }
}

impl SchedulerState {
    pub fn with_idle_minutes(minutes: u32) -> Self {
        Self::with_policy(LifecyclePolicy {
            idle_timeout_minutes: minutes,
            ..LifecyclePolicy::default()
        })
    }

    pub fn with_policy(mut policy: LifecyclePolicy) -> Self {
        policy.max_parallel_starts = policy.max_parallel_starts.max(1);
        Self {
            policy,
            starts_in_flight: 0,
            starting: Vec::new(),
            queued_starts: VecDeque::new(),
            activities: Vec::new(),
            reclaim_in_flight: false,
        }
    }

    pub fn update_policy(&mut self, mut policy: LifecyclePolicy) {
        policy.max_parallel_starts = policy.max_parallel_starts.max(1);
        self.policy = policy;
    }

    pub fn request_start(&mut self, vm: &str, instance: &str) -> StartDecision {
        if self
            .starting
            .iter()
            .any(|request| request.vm == vm && request.instance == instance)
            || self
                .queued_starts
                .iter()
                .any(|request| request.vm == vm && request.instance == instance)
        {
            return StartDecision::Failed(format!(
                "start already tracked for VM {vm} instance {instance}"
            ));
        }
        if self.starts_in_flight >= self.policy.max_parallel_starts
            || self.starting.iter().any(|request| request.vm == vm)
        {
            self.queued_starts.push_back(StartRequest {
                vm: vm.to_string(),
                instance: instance.to_string(),
            });
            return StartDecision::Queued;
        }
        self.starts_in_flight += 1;
        self.starting.push(StartRequest {
            vm: vm.to_string(),
            instance: instance.to_string(),
        });
        StartDecision::Starting
    }

    pub fn finish_start(&mut self, vm: &str, instance: &str, success: bool) -> StartDecision {
        let Some(index) = self
            .starting
            .iter()
            .position(|request| request.vm == vm && request.instance == instance)
        else {
            return StartDecision::Failed(format!(
                "start was not tracked for VM {vm} instance {instance}"
            ));
        };
        self.starts_in_flight = self.starts_in_flight.saturating_sub(1);
        self.starting.remove(index);
        if success {
            StartDecision::Ready
        } else {
            StartDecision::Failed(format!("start failed for VM {vm}"))
        }
    }

    /// Promote exactly the oldest queued request when its VM is not already
    /// starting and the global parallel-start budget has room. Keeping the
    /// queue in the backend means a `Queued` request has an owner and cannot
    /// be lost between two frontend refreshes.
    pub fn promote_next_start(&mut self) -> Option<(String, String)> {
        if self.starts_in_flight >= self.policy.max_parallel_starts {
            return None;
        }
        let request = self.queued_starts.front()?;
        if self
            .starting
            .iter()
            .any(|starting| starting.vm == request.vm)
        {
            return None;
        }
        let request = self.queued_starts.pop_front()?;
        self.starts_in_flight += 1;
        self.starting.push(request.clone());
        Some((request.vm, request.instance))
    }

    pub fn is_starting(&self, vm: &str, instance: &str) -> bool {
        self.starting
            .iter()
            .any(|request| request.vm == vm && request.instance == instance)
    }

    pub fn is_queued(&self, vm: &str, instance: &str) -> bool {
        self.queued_starts
            .iter()
            .any(|request| request.vm == vm && request.instance == instance)
    }

    pub fn has_other_start(&self, vm: &str, instance: &str) -> bool {
        self.starting
            .iter()
            .chain(self.queued_starts.iter())
            .any(|request| request.vm != vm || request.instance != instance)
    }

    pub fn cancel_queued_start(&mut self, vm: &str, instance: &str) -> bool {
        let Some(index) = self
            .queued_starts
            .iter()
            .position(|request| request.vm == vm && request.instance == instance)
        else {
            return false;
        };
        self.queued_starts.remove(index).is_some()
    }

    pub fn mark_activity(&mut self, instance: &str, kind: ActivityKind, at: SystemTime) {
        self.activities
            .retain(|item| item.instance != instance || item.record.kind != kind);
        self.activities.push(ActivityRecordWithInstance {
            instance: instance.to_string(),
            record: ActivityRecord { kind, at },
        });
    }

    pub fn policy(&self) -> &LifecyclePolicy {
        &self.policy
    }

    pub fn clear_instance(&mut self, instance: &str) {
        self.activities.retain(|item| item.instance != instance);
    }

    /// Return known idle instance ids once each, in activity-record order.
    /// The caller must still intersect these ids with a live, running QEMU
    /// listing before issuing a stop command.
    pub fn reclaimable_instances(&self, now: SystemTime) -> Vec<String> {
        let mut candidates = Vec::new();
        for item in &self.activities {
            if candidates.contains(&item.instance) {
                continue;
            }
            if self.is_reclaimable(&item.instance, now) {
                candidates.push(item.instance.clone());
            }
        }
        candidates
    }

    /// Reserve the single automatic reclaim slot. The slot is deliberately
    /// separate from the start budget because the actual Docker stop must run
    /// without holding the scheduler mutex.
    pub fn begin_reclaim(&mut self) -> bool {
        if self.reclaim_in_flight {
            return false;
        }
        self.reclaim_in_flight = true;
        true
    }

    pub fn finish_reclaim(&mut self) {
        self.reclaim_in_flight = false;
    }

    pub fn is_reclaimable(&self, instance: &str, now: SystemTime) -> bool {
        if self
            .policy
            .protected_instance_ids
            .iter()
            .any(|protected| protected == instance)
        {
            return false;
        }
        let timeout_minutes = self.policy.idle_timeout_minutes.max(1);
        let timeout = Duration::from_secs(timeout_minutes as u64 * 60);
        let records: Vec<_> = self
            .activities
            .iter()
            .filter(|item| item.instance == instance)
            .collect();
        !records.is_empty()
            && records
                .iter()
                .all(|item| now.duration_since(item.record.at).unwrap_or_default() >= timeout)
    }
}

pub fn parse_activity_kind(value: &str) -> Result<ActivityKind, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "user_window" | "userwindow" => Ok(ActivityKind::UserWindow),
        "adb" => Ok(ActivityKind::Adb),
        "stream" => Ok(ActivityKind::Stream),
        "recording" => Ok(ActivityKind::Recording),
        "transfer" => Ok(ActivityKind::Transfer),
        "automation" => Ok(ActivityKind::Automation),
        other => Err(format!("unknown runtime activity kind: {other:?}")),
    }
}

/// Package names are passed to an ADB shell command. Keep this validation in
/// the runtime boundary as well as the generic device service so a future
/// caller cannot bypass the shell-safety check by using the hibernation path.
pub fn is_valid_android_package(package: &str) -> bool {
    let package = package.trim();
    !package.is_empty()
        && package.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_start_is_queued_while_the_same_vm_is_booting() {
        let mut scheduler = SchedulerState::default();
        assert_eq!(
            scheduler.request_start("node1", "r13"),
            StartDecision::Starting
        );
        assert_eq!(
            scheduler.request_start("node1", "r1"),
            StartDecision::Queued
        );
        assert_eq!(
            scheduler.finish_start("node1", "r13", true),
            StartDecision::Ready
        );
        assert_eq!(
            scheduler.promote_next_start(),
            Some(("node1".to_string(), "r1".to_string()))
        );
        assert!(scheduler.is_starting("node1", "r1"));
    }

    #[test]
    fn queued_starts_are_promoted_in_fifo_order_after_the_previous_start_finishes() {
        let mut scheduler = SchedulerState::with_policy(LifecyclePolicy {
            max_parallel_starts: 1,
            ..LifecyclePolicy::default()
        });
        assert_eq!(
            scheduler.request_start("node1", "r13"),
            StartDecision::Starting
        );
        assert_eq!(
            scheduler.request_start("node1", "r1"),
            StartDecision::Queued
        );
        assert_eq!(
            scheduler.request_start("node1", "r2"),
            StartDecision::Queued
        );

        assert_eq!(
            scheduler.finish_start("node1", "r13", true),
            StartDecision::Ready
        );
        assert_eq!(
            scheduler.promote_next_start(),
            Some(("node1".to_string(), "r1".to_string()))
        );
        assert!(scheduler.is_starting("node1", "r1"));
        assert!(!scheduler.is_starting("node1", "r2"));
    }

    #[test]
    fn duplicate_start_requests_are_not_added_to_the_queue() {
        let mut scheduler = SchedulerState::default();
        assert_eq!(
            scheduler.request_start("node1", "r13"),
            StartDecision::Starting
        );
        assert!(!scheduler.has_other_start("node1", "r13"));
        assert!(matches!(
            scheduler.request_start("node1", "r13"),
            StartDecision::Failed(_)
        ));
        assert_eq!(
            scheduler.request_start("node1", "r1"),
            StartDecision::Queued
        );
        assert!(scheduler.has_other_start("node1", "r1"));
        assert!(matches!(
            scheduler.request_start("node1", "r1"),
            StartDecision::Failed(_)
        ));
        assert!(scheduler.cancel_queued_start("node1", "r1"));
        assert!(!scheduler.is_queued("node1", "r1"));
    }

    #[test]
    fn failed_start_also_releases_the_next_queued_request() {
        let mut scheduler = SchedulerState::default();
        assert_eq!(
            scheduler.request_start("node1", "r13"),
            StartDecision::Starting
        );
        assert_eq!(
            scheduler.request_start("node1", "r1"),
            StartDecision::Queued
        );
        assert!(matches!(
            scheduler.finish_start("node1", "r13", false),
            StartDecision::Failed(_)
        ));
        assert_eq!(
            scheduler.promote_next_start(),
            Some(("node1".to_string(), "r1".to_string()))
        );
    }

    #[test]
    fn active_stream_prevents_idle_reclamation() {
        let mut scheduler = SchedulerState::with_idle_minutes(30);
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(3_600);
        scheduler.mark_activity(
            "r13",
            ActivityKind::Stream,
            now - Duration::from_secs(31 * 60),
        );
        scheduler.mark_activity(
            "r13",
            ActivityKind::UserWindow,
            now - Duration::from_secs(2 * 60),
        );
        assert!(!scheduler.is_reclaimable("r13", now));
    }

    #[test]
    fn zero_idle_timeout_uses_one_minute_floor() {
        let mut scheduler = SchedulerState::with_idle_minutes(0);
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(3_600);
        scheduler.mark_activity(
            "r13",
            ActivityKind::UserWindow,
            now - Duration::from_secs(59),
        );
        assert!(!scheduler.is_reclaimable("r13", now));

        scheduler.mark_activity(
            "r13",
            ActivityKind::UserWindow,
            now - Duration::from_secs(60),
        );
        assert!(scheduler.is_reclaimable("r13", now));
    }

    #[test]
    fn reclaimable_instances_are_unique_and_skip_protected_instances() {
        let mut scheduler = SchedulerState::with_policy(LifecyclePolicy {
            idle_timeout_minutes: 30,
            protected_instance_ids: vec!["r2".into()],
            ..LifecyclePolicy::default()
        });
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(3_600);
        scheduler.mark_activity(
            "r1",
            ActivityKind::UserWindow,
            now - Duration::from_secs(31 * 60),
        );
        scheduler.mark_activity("r1", ActivityKind::Adb, now - Duration::from_secs(32 * 60));
        scheduler.mark_activity(
            "r2",
            ActivityKind::UserWindow,
            now - Duration::from_secs(31 * 60),
        );
        assert_eq!(scheduler.reclaimable_instances(now), vec!["r1".to_string()]);
    }

    #[test]
    fn reclaim_slot_serializes_automatic_pressure_reclaims() {
        let mut scheduler = SchedulerState::default();
        assert!(scheduler.begin_reclaim());
        assert!(!scheduler.begin_reclaim());
        scheduler.finish_reclaim();
        assert!(scheduler.begin_reclaim());
    }

    #[test]
    fn app_hibernation_package_validation_rejects_shell_fragments() {
        assert!(is_valid_android_package("com.xingin.xhs"));
        assert!(is_valid_android_package("com.example.app_2"));
        assert!(!is_valid_android_package("com..xhs"));
        assert!(!is_valid_android_package("com.xingin.xhs;id"));
        assert!(!is_valid_android_package("com/xingin/xhs"));
    }

    #[test]
    fn lifecycle_policy_defaults_to_memory_first_but_preserves_explicit_warm_setting() {
        assert!(!LifecyclePolicy::default().keep_vm_warm);

        let missing: LifecyclePolicy = serde_json::from_str(
            r#"{"idleTimeoutMinutes":30,"maxParallelStarts":1,"protectedInstanceIds":[]}"#,
        )
        .unwrap();
        assert!(!missing.keep_vm_warm);

        let explicit: LifecyclePolicy = serde_json::from_str(
            r#"{"idleTimeoutMinutes":30,"keepVmWarm":true,"maxParallelStarts":1,"protectedInstanceIds":[]}"#,
        )
        .unwrap();
        assert!(explicit.keep_vm_warm);
    }
}
