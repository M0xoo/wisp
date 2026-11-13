//! RFC 3339 timestamps (GitHub's) to ms since the epoch, without a clock or a date library: v1 used
//! `Date.parse(x) || null`, so anything unparseable is None.

/// `2026-10-28T09:01:05Z`, `2026-10-28T09:01:05.123Z`, `2026-10-28T11:01:05+02:00` → ms. None otherwise.
#[allow(clippy::many_single_char_names)] // y m d h mi s: the date's own fields
pub fn parse_ms(s: &str) -> Option<i64> {
    let b = s.trim().as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = b.get(from..to)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
        // milliseconds: the first three digits, padded
        let digits: String = s.trim()[start..i].chars().chain("000".chars()).take(3).collect();
        ms = digits.parse().ok()?;
    }
    let offset_min = match b.get(i) {
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if i + 6 == b.len() && b[i + 3] == b':' => {
            let m = num(i + 1, i + 3)? * 60 + num(i + 4, i + 6)?;
            if *sign == b'+' { m } else { -m }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + ms)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// ms since the epoch → `YYYY-MM-DDTHH:MM:SSZ` (for fixtures and tests).
pub fn format_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_stamps() {
        assert_eq!(parse_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ms("2026-10-28T09:01:05Z").zip(parse_ms("2026-10-28T09:00:00Z")).map(|(a, b)| a - b), Some(65_000));
        assert_eq!(parse_ms("2026-10-28T09:00:00.5Z"), parse_ms("2026-10-28T09:00:00Z").map(|x| x + 500));
        assert_eq!(parse_ms("2026-10-28T11:00:00+02:00"), parse_ms("2026-10-28T09:00:00Z"));
        assert_eq!(parse_ms("2000-03-01T00:00:00Z"), Some(951_868_800_000));
    }

    #[test]
    fn refuses_what_date_parse_would_not_read() {
        for bad in [
            "",
            "yesterday",
            "2026-13-01T00:00:00Z",
            "2026-10-28",
            "2026-10-28T09:00:00",
            "2026-10-28T09:00:00Zjunk",
            "2026-10-28T09:00:00.Z",
        ] {
            assert_eq!(parse_ms(bad), None, "{bad}");
        }
    }

    /// Property: format then parse is the identity on whole seconds across four centuries.
    #[test]
    fn round_trips() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..5000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let secs = i64::try_from(x % 12_000_000_000).unwrap_or(0) - 2_000_000_000;
            let ms = secs * 1000;
            assert_eq!(parse_ms(&format_ms(ms)), Some(ms), "{}", format_ms(ms));
        }
    }
}
