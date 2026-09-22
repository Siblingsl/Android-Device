//! Per-device grouping tags ("设备分组/标签").
//!
//! Simplified model (deliberate): tags ARE the groups — there is no separate
//! group registry to create first. `AppSettings.device_tags` stores
//! `deviceId|serial → [tag, …]` in the normal settings.json; a device with an
//! empty tag list is simply "ungrouped" and its record is removed.
//!
//! Honest status split:
//! - ✅ unit-tested pure functions: tag normalization (trim / length / dedupe /
//!   order preserving) and record merging (set + clear, empty record removal).
//! - ⚠️ runtime: `set_tags` goes through the existing settings save path
//!   (settings.json write + launch-item side effects) — unverified here.

use std::collections::BTreeMap;

use crate::services::settings;

/// Max length of one tag name; the UI input mirrors this cap.
pub const MAX_TAG_LEN: usize = 24;

/// Pure: normalize one raw tag. Returns `None` for blank input; otherwise the
/// trimmed name truncated to [`MAX_TAG_LEN`] chars.
pub fn normalize_tag(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_TAG_LEN).collect())
}

/// Pure: normalize a whole tag list — blank entries dropped, duplicates
/// removed, input order preserved (so the UI keeps the user's ordering).
pub fn normalize_tags(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for tag in raw {
        if let Some(tag) = normalize_tag(tag) {
            if !out.contains(&tag) {
                out.push(tag);
            }
        }
    }
    out
}

/// Pure: merge one device's tag list into the record. An empty normalized list
/// clears the record entirely (the device becomes "ungrouped"); every other
/// device's record is preserved.
pub fn merge_tag_record(
    existing: Option<&BTreeMap<String, Vec<String>>>,
    device_id: &str,
    tags: &[String],
) -> BTreeMap<String, Vec<String>> {
    let mut map = existing.cloned().unwrap_or_default();
    let normalized = normalize_tags(tags);
    if normalized.is_empty() {
        map.remove(device_id);
    } else {
        map.insert(device_id.to_string(), normalized);
    }
    map
}

/// Pure: every distinct tag currently in use, alphabetically (BTreeMap key
/// order is not enough — the tag list inside each record needs collapsing).
pub fn all_tags(map: Option<&BTreeMap<String, Vec<String>>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tags in map.into_iter().flat_map(|m| m.values()) {
        for tag in tags {
            if !out.contains(tag) {
                out.push(tag.clone());
            }
        }
    }
    out.sort();
    out
}

/// Read the current tag record from settings.json.
pub fn get_tags() -> BTreeMap<String, Vec<String>> {
    settings::get().device_tags.unwrap_or_default()
}

/// Persist one device's tags through the regular settings save path.
pub fn set_tags(
    device_id: &str,
    tags: Vec<String>,
) -> Result<BTreeMap<String, Vec<String>>, String> {
    let id = device_id.trim();
    if id.is_empty() {
        return Err("设备标识不能为空".into());
    }
    let mut current = settings::get();
    let merged = merge_tag_record(current.device_tags.as_ref(), id, &tags);
    current.device_tags = if merged.is_empty() {
        None
    } else {
        Some(merged.clone())
    };
    settings::update(current)?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(id, tags)| (id.to_string(), tags.iter().map(|t| t.to_string()).collect()))
            .collect()
    }

    #[test]
    fn normalize_tag_trims_caps_and_rejects_blank() {
        assert_eq!(normalize_tag("  vip  ").as_deref(), Some("vip"));
        assert_eq!(normalize_tag(""), None);
        assert_eq!(normalize_tag("   \t "), None);
        let long = normalize_tag(&"x".repeat(40)).unwrap();
        assert_eq!(long.chars().count(), MAX_TAG_LEN);
    }

    #[test]
    fn normalize_tags_dedupes_and_keeps_order() {
        let out = normalize_tags(&["beta".into(), " alpha ".into(), "beta".into(), "  ".into()]);
        assert_eq!(out, vec!["beta".to_string(), "alpha".to_string()]);
    }

    #[test]
    fn merge_sets_replaces_and_clears_without_touching_other_devices() {
        let base = record(&[("dev-a", &["vip"]), ("dev-b", &["farm"])]);

        let set = merge_tag_record(Some(&base), "dev-c", &["新机".into()]);
        assert_eq!(set["dev-c"], vec!["新机".to_string()]);
        assert_eq!(set["dev-a"], vec!["vip".to_string()]);
        assert_eq!(set.len(), 3);

        let replaced = merge_tag_record(Some(&base), "dev-a", &["vip".into(), "farm".into()]);
        assert_eq!(replaced["dev-a"].len(), 2);

        // Empty list clears the record; the other device stays.
        let cleared = merge_tag_record(Some(&base), "dev-a", &[]);
        assert!(!cleared.contains_key("dev-a"));
        assert!(cleared.contains_key("dev-b"));

        // A blank-only list is the same as clearing.
        let blanked = merge_tag_record(Some(&base), "dev-a", &["   ".into()]);
        assert!(!blanked.contains_key("dev-a"));
    }

    #[test]
    fn merge_from_none_creates_a_fresh_record() {
        let map = merge_tag_record(None, "dev-a", &["vip".into()]);
        assert_eq!(map.len(), 1);
        assert!(merge_tag_record(None, "dev-a", &[]).is_empty());
    }

    #[test]
    fn all_tags_is_deduplicated_and_sorted() {
        let map = record(&[("dev-a", &["vip", "farm"]), ("dev-b", &["farm", "alpha"])]);
        assert_eq!(
            all_tags(Some(&map)),
            vec!["alpha".to_string(), "farm".to_string(), "vip".to_string()]
        );
        assert!(all_tags(None).is_empty());
    }
}
