//! Mail on a grid (v1 grid/mail.js): a message to a user's secret address starts work on their box, and the reply
//! goes back by email. Off unless grid.json has `mail` (and `channels`: mail is held like any channel's message).
//! `mime.rs` reads and writes messages, `ses.rs` is SES over SNS, `service.rs` the grid's side, `crate::dkim` the
//! signature it checks itself.

pub mod mime;
pub mod ses;

/// ms since the epoch of an ISO 8601 UTC time (`2024-01-02T03:04:05.000Z`).
#[allow(clippy::many_single_char_names, reason = "the civil-date algorithm's own names")]
pub fn iso_ms(iso: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let ms = iso.get(19..).and_then(|r| r.strip_prefix('.')).map_or(0, |f| f.chars().take_while(char::is_ascii_digit).take(3).collect::<String>().parse::<i64>().unwrap_or(0));
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(((era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + mi * 60 + s) * 1000 + ms)
}

pub mod service;

const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// (y, m, d, h, mi, s) of ms since the epoch, UTC.
#[allow(clippy::many_single_char_names, reason = "the civil-date algorithm's own names")]
fn civil(ms: i64) -> (i64, i64, i64, i64, i64, i64) {
    let s = ms.div_euclid(1000);
    let (days, secs) = (s.div_euclid(86_400), s.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d, secs / 3600, secs % 3600 / 60, secs % 60)
}

/// ISO 8601 UTC of ms since the epoch.
#[allow(clippy::many_single_char_names, reason = "a date's own parts")]
pub fn iso_of(ms: i64) -> String {
    let (y, m, d, h, mi, s) = civil(ms);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{:03}Z", ms.rem_euclid(1000))
}

/// RFC 5322's date of ms since the epoch (`Tue, 02 Jan 2024 03:04:05 +0000`).
#[allow(clippy::many_single_char_names, reason = "a date's own parts")]
pub fn rfc5322(ms: i64) -> String {
    let (y, m, d, h, mi, s) = civil(ms);
    let wd = DAYS[usize::try_from(ms.div_euclid(86_400_000).rem_euclid(7)).unwrap_or(0)];
    let mon = MONTHS[usize::try_from(m - 1).unwrap_or(0)];
    format!("{wd}, {d:02} {mon} {y} {h:02}:{mi:02}:{s:02} +0000")
}

/// A message's `Date:` (RFC 5322, a zone as ±hhmm or a name) → ISO 8601 UTC, '' when it can't be read.
#[allow(clippy::many_single_char_names, reason = "a date's own parts")]
pub fn date_iso(date: &str) -> String {
    let t: Vec<&str> = date.split(|c: char| c.is_whitespace() || c == ',').filter(|w| !w.is_empty()).collect();
    let t: Vec<&str> = if t.first().is_some_and(|w| w.chars().all(char::is_alphabetic)) { t[1..].to_vec() } else { t };
    let (Some(d), Some(mon), Some(y), Some(time)) = (t.first().and_then(|d| d.parse::<i64>().ok()), t.get(1).and_then(|m| MONTHS.iter().position(|x| x.eq_ignore_ascii_case(m))), t.get(2).and_then(|y| y.parse::<i64>().ok()), t.get(3)) else { return String::new() };
    let hms: Vec<i64> = time.split(':').filter_map(|p| p.parse().ok()).collect();
    let (h, mi, s) = (hms.first().copied().unwrap_or(0), hms.get(1).copied().unwrap_or(0), hms.get(2).copied().unwrap_or(0));
    let zone = t.get(4).map_or(0, |z| match (z.strip_prefix('+').map(|r| (1, r)).or_else(|| z.strip_prefix('-').map(|r| (-1, r))), z) {
        (Some((sign, r)), _) if r.len() == 4 => sign * (r[..2].parse::<i64>().unwrap_or(0) * 60 + r[2..].parse::<i64>().unwrap_or(0)),
        _ => 0,
    });
    let y = if y < 100 { y + if y < 50 { 2000 } else { 1900 } } else { y };
    let iso = format!("{y:04}-{:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z", mon + 1);
    iso_ms(&iso).map_or_else(String::new, |ms| iso_of(ms - zone * 60_000))
}

#[cfg(test)]
mod date_tests {
    use super::*;

    #[test]
    fn a_messages_date_is_read_in_its_own_zone_and_written_in_utc() {
        assert_eq!(date_iso("Tue, 2 Jan 2024 05:04:05 +0200"), "2024-01-02T03:04:05.000Z");
        assert_eq!(date_iso("2 Jan 2024 03:04:05 GMT"), "2024-01-02T03:04:05.000Z");
        assert_eq!(date_iso("soon"), "");
        assert_eq!(rfc5322(1_704_164_645_000), "Tue, 02 Jan 2024 03:04:05 +0000");
        assert_eq!(iso_ms(&iso_of(1_704_164_645_123)), Some(1_704_164_645_123));
        assert_eq!(service::stamp(1_704_164_645_000), "20240102T030405Z");
    }
}
