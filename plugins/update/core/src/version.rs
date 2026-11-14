//! Version order (v1 server/update.js `newer`): semver with prereleases. 0.38.0-beta.1 < 0.38.0-beta.2 <
//! 0.38.0-nightly.20261024.317 < 0.38.0. Numeric identifiers compare as numbers and sort before words;
//! build metadata (`+…`) is ignored; a leading `v` is dropped. Behaviour for behaviour with v1, quirks
//! included: a core part that isn't a number counts as 0.

use std::cmp::Ordering;

struct Parsed<'a> {
    core: [u64; 3],
    pre: Vec<&'a str>,
}

fn parse(v: &str) -> Parsed<'_> {
    let v = v.strip_prefix('v').unwrap_or(v);
    let v = v.split('+').next().unwrap_or("");
    let (core, pre) = v.split_once('-').map_or((v, ""), |(c, p)| (c, p));
    let mut nums = [0u64; 3];
    for (slot, part) in nums.iter_mut().zip(core.split('.')) {
        *slot = part.parse().unwrap_or(0);
    }
    Parsed { core: nums, pre: if pre.is_empty() && !v.contains('-') { Vec::new() } else { pre.split('.').collect() } }
}

fn numeric(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Compares two all-digit identifiers as numbers, without overflow: leading zeros are dropped first.
fn cmp_digits(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// `a` is a later version than `b`.
pub fn newer(a: &str, b: &str) -> bool {
    let (left, right) = (parse(a), parse(b));
    if left.core != right.core {
        return left.core > right.core;
    }
    if left.pre.is_empty() || right.pre.is_empty() {
        return left.pre.is_empty() && !right.pre.is_empty(); // a release beats its prereleases
    }
    for i in 0..left.pre.len().max(right.pre.len()) {
        let (mine, theirs) = (left.pre.get(i), right.pre.get(i));
        if mine == theirs {
            continue;
        }
        let (Some(mine), Some(theirs)) = (mine, theirs) else {
            return theirs.is_none(); // more identifiers sort later
        };
        return match (numeric(mine), numeric(theirs)) {
            (true, true) => cmp_digits(mine, theirs) == Ordering::Greater,
            (false, false) => mine > theirs,
            (is_num, _) => !is_num, // numbers sort before words
        };
    }
    false
}

/// The order `newer` defines, as an `Ordering` (versions that are neither newer are equal).
pub fn compare(a: &str, b: &str) -> Ordering {
    if newer(a, b) {
        Ordering::Greater
    } else if newer(b, a) {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

/// The newest of `versions`, skipping empty ones; the first wins a tie (v1's reduce).
pub fn newest<'a>(versions: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    versions.into_iter().filter(|v| !v.is_empty()).fold(None, |best, v| match best {
        Some(b) if !newer(v, b) => Some(b),
        _ => Some(v),
    })
}

/// The first `\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?` in `text` (the rolling nightly's title, "wisp 0.38.0-nightly.…").
pub fn find_version(text: &str) -> Option<&str> {
    let b = text.as_bytes();
    let digits = |mut i: usize| {
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        (i > s).then_some(i)
    };
    for start in 0..b.len() {
        if !b[start].is_ascii_digit() || (start > 0 && b[start - 1].is_ascii_digit()) {
            continue;
        }
        let Some(mut end) = digits(start) else {
            continue;
        };
        let mut ok = true;
        for _ in 0..2 {
            match (b.get(end), digits(end + 1)) {
                (Some(b'.'), Some(e)) => end = e,
                _ => ok = false,
            }
            if !ok {
                break;
            }
        }
        if !ok {
            continue;
        }
        if b.get(end) == Some(&b'-') {
            let rest = b[end + 1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'.' || **c == b'-').count();
            if rest > 0 {
                end += 1 + rest;
            }
        }
        return Some(&text[start..end]);
    }
    None
}
