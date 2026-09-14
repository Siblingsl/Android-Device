//! Geographic consistency check ("时间 / 地理一致性校验").
//!
//! A spoofed Xiaomi claiming Shanghai but sitting in `America/New_York` with a
//! US proxy exit is a trivially detectable contradiction. This module checks
//! that the profile's claimed geo identity agrees with what the *device* and
//! the *egress* actually say:
//!
//! - device side: `persist.sys.timezone` + `ro.product.locale` (plain
//!   getprops, one batched shell call);
//! - profile side: the optional `geo` block (`country` / `timezone` /
//!   `locale`) users set on a spoof profile;
//! - proxy side: `geo.proxyCountry` — **user-declared**, because the app
//!   deliberately does no GeoIP lookups (no external API dependency).
//!
//! The timezone→country mapping is a small built-in table of common zones
//! (`country_hint_for_timezone`); unknown zones simply skip that check instead
//! of guessing. Everything heavy lives in the pure `geo_consistency` function
//! so the verdicts are unit-testable.

use crate::models::{GeoCheck, GeoIssue, SpoofProfile};
use crate::services::{adb, spoof};

/// Common IANA timezones → ISO-3166 alpha-2 country hint. Deliberately small
/// and conservative: only zones whose country is unambiguous are listed.
const TIMEZONE_COUNTRY_HINTS: &[(&str, &str)] = &[
    ("Asia/Shanghai", "CN"),
    ("Asia/Urumqi", "CN"),
    ("Asia/Hong_Kong", "HK"),
    ("Asia/Macau", "MO"),
    ("Asia/Taipei", "TW"),
    ("Asia/Tokyo", "JP"),
    ("Asia/Seoul", "KR"),
    ("Asia/Singapore", "SG"),
    ("Asia/Kuala_Lumpur", "MY"),
    ("Asia/Bangkok", "TH"),
    ("Asia/Ho_Chi_Minh", "VN"),
    ("Asia/Manila", "PH"),
    ("Asia/Jakarta", "ID"),
    ("Asia/Kolkata", "IN"),
    ("Asia/Dubai", "AE"),
    ("Asia/Riyadh", "SA"),
    ("Asia/Qatar", "QA"),
    ("Europe/London", "GB"),
    ("Europe/Dublin", "IE"),
    ("Europe/Paris", "FR"),
    ("Europe/Berlin", "DE"),
    ("Europe/Rome", "IT"),
    ("Europe/Madrid", "ES"),
    ("Europe/Moscow", "RU"),
    ("Europe/Amsterdam", "NL"),
    ("America/New_York", "US"),
    ("America/Detroit", "US"),
    ("America/Chicago", "US"),
    ("America/Denver", "US"),
    ("America/Phoenix", "US"),
    ("America/Los_Angeles", "US"),
    ("America/Anchorage", "US"),
    ("America/Toronto", "CA"),
    ("America/Vancouver", "CA"),
    ("America/Mexico_City", "MX"),
    ("America/Sao_Paulo", "BR"),
    ("Australia/Sydney", "AU"),
    ("Australia/Melbourne", "AU"),
    ("Pacific/Auckland", "NZ"),
];

/// Country code a timezone implies, when the zone is in the built-in table.
pub fn country_hint_for_timezone(timezone: &str) -> Option<&'static str> {
    let tz = timezone.trim();
    if tz.is_empty() {
        return None;
    }
    TIMEZONE_COUNTRY_HINTS
        .iter()
        .find(|(zone, _)| *zone == tz)
        .map(|(_, code)| *code)
}

/// The pure consistency check. Every comparison only runs when *both* sides
/// have data — missing data never fabricates an issue, it just skips.
///
/// Issues reported (stable codes):
/// - `timezoneMismatch`: device `persist.sys.timezone` ≠ profile `geo.timezone`;
/// - `timezoneCountryMismatch`: device timezone maps (built-in table) to a
///   country different from profile `geo.country`;
/// - `localeMismatch`: device `ro.product.locale` ≠ profile `geo.locale`;
/// - `proxyCountryMismatch`: declared proxy exit country ≠ profile `geo.country`;
/// - `noGeoData`: the profile has no `geo` block at all (nothing to verify).
pub fn geo_consistency(
    profile: Option<&SpoofProfile>,
    device_timezone: &str,
    device_locale: &str,
    proxy_country: Option<&str>,
) -> Vec<GeoIssue> {
    let Some(p) = profile else {
        return vec![GeoIssue {
            code: "noGeoData".into(),
            message: "未选择伪装档案，无法校验地理一致性".into(),
        }];
    };
    let Some(geo) = &p.geo else {
        return vec![GeoIssue {
            code: "noGeoData".into(),
            message: format!(
                "档案 {} 未配置 geo 字段（country/timezone/locale），无法校验地理一致性",
                p.id
            ),
        }];
    };

    let mut issues = Vec::new();
    let tz = device_timezone.trim();
    let locale = device_locale.trim();

    if !geo.timezone.trim().is_empty() && !tz.is_empty() && geo.timezone.trim() != tz {
        issues.push(GeoIssue {
            code: "timezoneMismatch".into(),
            message: format!(
                "设备时区 {} 与档案时区 {} 不一致（getprop persist.sys.timezone）",
                tz,
                geo.timezone.trim()
            ),
        });
    }

    if !geo.country.trim().is_empty() && !tz.is_empty() {
        if let Some(hint) = country_hint_for_timezone(tz) {
            if !geo.country.trim().eq_ignore_ascii_case(hint) {
                issues.push(GeoIssue {
                    code: "timezoneCountryMismatch".into(),
                    message: format!(
                        "设备时区 {} 隐含国家码 {}，与档案 country {} 不一致",
                        tz,
                        hint,
                        geo.country.trim().to_uppercase()
                    ),
                });
            }
        }
        // Unknown timezone → skip (no guessing without a GeoIP dependency).
    }

    if !geo.locale.trim().is_empty() && !locale.is_empty() && geo.locale.trim() != locale {
        issues.push(GeoIssue {
            code: "localeMismatch".into(),
            message: format!(
                "设备 locale {} 与档案 locale {} 不一致（getprop ro.product.locale）",
                locale,
                geo.locale.trim()
            ),
        });
    }

    if let Some(proxy) = proxy_country.map(str::trim).filter(|c| !c.is_empty()) {
        if !geo.country.trim().is_empty()
            && !proxy.eq_ignore_ascii_case(geo.country.trim())
        {
            issues.push(GeoIssue {
                code: "proxyCountryMismatch".into(),
                message: format!(
                    "代理出口国别 {} 与档案 country {} 不一致（proxyCountry 为用户声明值，应用内不做 GeoIP 查询）",
                    proxy,
                    geo.country.trim().to_uppercase()
                ),
            });
        }
    }

    issues
}

/// Runtime wrapper: read the device's timezone/locale in one batched getprop
/// call and run the pure check against the resolved profile.
pub fn geo_consistency_check(serial: &str, profile_id: &str) -> GeoCheck {
    let profile = spoof::profile_by_id(profile_id.trim());
    let out = adb::shell(
        serial,
        "echo tz=$(getprop persist.sys.timezone); echo loc=$(getprop ro.product.locale)",
    );
    let (mut device_timezone, mut device_locale) = (String::new(), String::new());
    if out.success {
        for line in out.stdout.lines() {
            if let Some(v) = line.trim().strip_prefix("tz=") {
                device_timezone = v.trim().to_string();
            } else if let Some(v) = line.trim().strip_prefix("loc=") {
                device_locale = v.trim().to_string();
            }
        }
    }
    let proxy_country = profile
        .as_ref()
        .and_then(|p| p.geo.as_ref())
        .and_then(|g| g.proxy_country.clone());
    let issues = geo_consistency(
        profile.as_ref(),
        &device_timezone,
        &device_locale,
        proxy_country.as_deref(),
    );
    GeoCheck {
        profile_id: profile.map(|p| p.id),
        consistent: issues.is_empty(),
        device_timezone,
        device_locale,
        issues,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_with_geo(geo: Option<crate::models::ProfileGeo>) -> SpoofProfile {
        let mut p = spoof::profile_by_id("redmi-k40-alioth").unwrap();
        p.geo = geo;
        p
    }

    fn geo(
        country: &str,
        timezone: &str,
        locale: &str,
        proxy: Option<&str>,
    ) -> crate::models::ProfileGeo {
        crate::models::ProfileGeo {
            country: country.into(),
            timezone: timezone.into(),
            locale: locale.into(),
            proxy_country: proxy.map(|s| s.into()),
        }
    }

    #[test]
    fn consistent_setup_reports_no_issues() {
        let p = profile_with_geo(Some(geo("CN", "Asia/Shanghai", "zh-CN", Some("CN"))));
        let issues = geo_consistency(Some(&p), "Asia/Shanghai", "zh-CN", Some("CN"));
        assert!(issues.is_empty(), "expected no issues: {issues:?}");
    }

    #[test]
    fn device_timezone_mismatch_is_reported() {
        let p = profile_with_geo(Some(geo("CN", "Asia/Shanghai", "zh-CN", None)));
        let issues = geo_consistency(Some(&p), "America/New_York", "zh-CN", None);
        assert_eq!(issues.len(), 2); // timezone mismatch + country mismatch
        assert!(issues.iter().any(|i| i.code == "timezoneMismatch"));
        assert!(issues.iter().any(|i| i.code == "timezoneCountryMismatch"));
        assert!(issues
            .iter()
            .all(|i| !i.message.is_empty()));
    }

    #[test]
    fn proxy_country_mismatch_is_reported_case_insensitively() {
        let p = profile_with_geo(Some(geo("CN", "Asia/Shanghai", "zh-CN", Some("US"))));
        let issues = geo_consistency(Some(&p), "Asia/Shanghai", "zh-CN", Some("us"));
        assert_eq!(issues.len(), 1, "us should mismatch CN even lowercased");
        assert_eq!(issues[0].code, "proxyCountryMismatch");
    }

    #[test]
    fn locale_mismatch_is_reported() {
        let p = profile_with_geo(Some(geo("CN", "Asia/Shanghai", "zh-CN", None)));
        let issues = geo_consistency(Some(&p), "Asia/Shanghai", "en-US", None);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "localeMismatch");
    }

    #[test]
    fn missing_geo_block_is_honest_no_geodata() {
        let p = profile_with_geo(None);
        let issues = geo_consistency(Some(&p), "Asia/Shanghai", "zh-CN", None);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "noGeoData");

        // No profile at all → the same honest answer.
        let issues = geo_consistency(None, "Asia/Shanghai", "zh-CN", None);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "noGeoData");
    }

    #[test]
    fn missing_device_values_skip_their_checks() {
        let p = profile_with_geo(Some(geo("CN", "Asia/Shanghai", "zh-CN", None)));
        // Device reports nothing (offline getprops) → nothing fabricated.
        let issues = geo_consistency(Some(&p), "", "", None);
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn unknown_timezone_skips_country_hint() {
        // Same timezone string (so no timezoneMismatch), country set, but the
        // zone is not in the built-in table — no hint, no issue, no guess.
        let p = profile_with_geo(Some(geo("CN", "Asia/Almaty", "zh-CN", None)));
        let issues = geo_consistency(Some(&p), "Asia/Almaty", "zh-CN", None);
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn country_hints_cover_the_documented_zones() {
        assert_eq!(country_hint_for_timezone("Asia/Shanghai"), Some("CN"));
        assert_eq!(country_hint_for_timezone("America/New_York"), Some("US"));
        assert_eq!(country_hint_for_timezone("Europe/London"), Some("GB"));
        assert_eq!(country_hint_for_timezone("Asia/Tokyo"), Some("JP"));
        assert_eq!(country_hint_for_timezone(""), None);
        assert_eq!(country_hint_for_timezone("Mars/Olympus"), None);
    }
}
