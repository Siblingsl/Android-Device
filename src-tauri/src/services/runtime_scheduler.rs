use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::resource_monitor::MemoryPressure;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LifecyclePolicy {
    pub idle_timeout_minutes: u32,
    pub keep_vm_warm: bool,
    pub max_parallel_starts: u32,
    pub protected_instance_ids: Vec<String>,
}

impl Default for LifecyclePolicy {
    fn default() -> Self {
        Self {
            idle_timeout_minutes: 30,
            keep_vm_warm: true,
            max_parallel_starts: 1,
            protected_instance_ids: Vec::new(),
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

#[derive(Debug, Clone)]
struct ActivityRecord {
    kind: ActivityKind,
    at: SystemTime,
}

#[derive(Debug, Clone)]
pub struct SchedulerState {
    policy: LifecyclePolicy,
    starts_in_flight: u32,
    starting_vms: Vec<String>,
    activities: Vec<ActivityRecordWithInstance>,
}

#[derive(Debug, Clone)]
struct ActivityRecordWithInstance {
    instance: String,
    record: ActivityRecord,
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
            starting_vms: Vec::new(),
            activities: Vec::new(),
        }
    }

    pub fn update_policy(&mut self, mut policy: LifecyclePolicy) {
        policy.max_parallel_starts = policy.max_parallel_starts.max(1);
        self.policy = policy;
    }

    pub fn request_start(&mut self, vm: &str, _instance: &str) -> StartDecision {
        if self.starts_in_flight >= self.policy.max_parallel_starts
            || self.starting_vms.iter().any(|name| name == vm)
        {
            return StartDecision::Queued;
        }
        self.starts_in_flight += 1;
        self.starting_vms.push(vm.to_string());
        StartDecision::Starting
    }

    pub fn finish_start(&mut self, vm: &str, success: bool) -> StartDecision {
        self.starts_in_flight = self.starts_in_flight.saturating_sub(1);
        self.starting_vms.retain(|name| name != vm);
        if success {
            StartDecision::Ready
        } else {
            StartDecision::Failed(format!("start failed for VM {vm}"))
        }
    }

    pub fn mark_activity(&mut self, instance: &str, kind: ActivityKind, at: SystemTime) {
        self.activities.retain(|item| item.instance != instance || item.record.kind != kind);
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

    pub fn is_reclaimable(&self, instance: &str, now: SystemTime) -> bool {
        if self
            .policy
            .protected_instance_ids
            .iter()
            .any(|protected| protected == instance)
        {
            return false;
        }
        let timeout = Duration::from_secs(self.policy.idle_timeout_minutes as u64 * 60);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_start_is_queued_while_the_same_vm_is_booting() {
        let mut scheduler = SchedulerState::default();
        assert_eq!(scheduler.request_start("node1", "r13"), StartDecision::Starting);
        assert_eq!(scheduler.request_start("node1", "r1"), StartDecision::Queued);
        assert_eq!(scheduler.finish_start("node1", true), StartDecision::Ready);
        assert_eq!(scheduler.request_start("node1", "r1"), StartDecision::Starting);
    }

    #[test]
    fn active_stream_prevents_idle_reclamation() {
        let mut scheduler = SchedulerState::with_idle_minutes(30);
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(3_600);
        scheduler.mark_activity("r13", ActivityKind::Stream, now - Duration::from_secs(31 * 60));
        scheduler.mark_activity("r13", ActivityKind::UserWindow, now - Duration::from_secs(2 * 60));
        assert!(!scheduler.is_reclaimable("r13", now));
    }
}
