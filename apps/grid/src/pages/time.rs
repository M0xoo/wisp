//! Times as pages say them. No clock here: the page is handed `now_ms`.

/// v1's `ago`: "just now", "5 min ago", "3 h ago", then the day (UTC). Times are epoch ms.
pub(super) fn ago(t: Option<i64>, now_ms: i64) -> String {
    let Some(t) = t.filter(|t| *t != 0) else {
        return "never".into();
    };
    let s = js_round((now_ms - t) as f64 / 1000.0);
    if s < 60.0 {
        "just now".into()
    } else if s < 3600.0 {
        format!("{} min ago", js_round(s / 60.0))
    } else if s < 86400.0 {
        format!("{} h ago", js_round(s / 3600.0))
    } else {
        let (y, m, d, ..) = civil(t);
        format!("{y:04}-{m:02}-{d:02}")
    }
}

/// `new Date(t).toLocaleString()` as Node prints it on the grid's server (en-US, UTC):
/// `11/8/2026, 3:04:05 PM`, with ICU's narrow no-break space before AM/PM.
pub(super) fn locale_string(t: i64) -> String {
    let (y, m, d, hh, mm, ss) = civil(t);
    let (h12, half) = match hh {
        0 => (12, "AM"),
        1..=11 => (hh, "AM"),
        12 => (12, "PM"),
        _ => (hh - 12, "PM"),
    };
    format!("{m}/{d}/{y}, {h12}:{mm:02}:{ss:02}\u{202f}{half}")
}

/// Math.round: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Epoch ms to (year, month, day, hour, minute, second) in UTC (Howard Hinnant's days_from_civil,
/// inverted).
fn civil(t: i64) -> (i64, i64, i64, i64, i64, i64) {
    let secs = t.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_000_000_000; // 2026-10-25T09:33:20Z

    #[test]
    fn ago_reads_like_v1() {
        assert_eq!(ago(None, NOW), "never");
        assert_eq!(ago(Some(0), NOW), "never");
        assert_eq!(ago(Some(NOW - 59_000), NOW), "just now");
        assert_eq!(ago(Some(NOW + 5_000), NOW), "just now");
        assert_eq!(ago(Some(NOW - 90_000), NOW), "2 min ago");
        assert_eq!(ago(Some(NOW - 3 * 3_600_000), NOW), "3 h ago");
        assert_eq!(ago(Some(NOW - 2 * 86_400_000), NOW), "2026-10-23");
    }

    #[test]
    fn dates_are_utc_like_node_on_the_server() {
        assert_eq!(civil(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil(NOW), (2026, 10, 25, 9, 33, 20));
        assert_eq!(locale_string(NOW), "10/25/2026, 9:33:20\u{202f}AM");
        assert_eq!(locale_string(NOW + 4 * 3_600_000), "10/25/2026, 1:33:20\u{202f}PM");
        assert_eq!(locale_string(951_782_400_000), "2/29/2000, 12:00:00\u{202f}AM");
    }
}
