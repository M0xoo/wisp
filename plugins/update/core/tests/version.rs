//! v1 test/update.test.js: version order, plus property tests (a seeded generator: no proptest in the
//! workspace) that `newer` is a strict total order on semver versions.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests may fail loudly
use std::cmp::Ordering;

use wisp_update_core::version::find_version;
use wisp_update_core::{compare, newer, newest};

#[test]
fn newer_compares_major_minor_patch_numerically() {
    assert!(newer("0.7.0", "0.6.0"));
    assert!(newer("0.10.0", "0.9.9"));
    assert!(newer("1.0.0", "0.99.99"));
    assert!(!newer("0.6.0", "0.6.0"));
    assert!(!newer("0.5.9", "0.6.0"));
    assert!(newer("v0.6.1", "0.6.0"));
}

#[test]
fn newer_orders_prereleases_the_semver_way() {
    let order = [
        "0.37.0",
        "0.38.0-beta.1",
        "0.38.0-beta.2",
        "0.38.0-beta.10",
        "0.38.0-nightly.20261024.317",
        "0.38.0-nightly.20261024.1200",
        "0.38.0-nightly.20261025.317",
        "0.38.0",
        "0.38.1-nightly.20261026.317",
    ];
    for (i, a) in order.iter().enumerate() {
        for (j, b) in order.iter().enumerate() {
            assert_eq!(newer(a, b), i > j, "{a} vs {b}");
        }
    }
    assert!(
        newer("1.0.0-alpha.1", "1.0.0-alpha"),
        "more identifiers sort later"
    );
    assert!(
        newer("1.0.0-alpha.beta", "1.0.0-alpha.1"),
        "words after numbers"
    );
    assert!(
        !newer("1.0.0+build.2", "1.0.0+build.1"),
        "build metadata doesn't count"
    );
    assert!(!newer("", "0.1.0"), "no version is never newer (v1: null)");
    assert!(newer("2.0.0", ""));
    assert!(
        newer("1.0.0-99999999999999999999999", "1.0.0-9"),
        "long numbers don't overflow"
    );
}

#[test]
fn newest_skips_empty_and_keeps_the_first_of_equals() {
    assert_eq!(
        newest(["", "0.37.0", "0.38.0-beta.1", "0.36.0"]),
        Some("0.38.0-beta.1")
    );
    assert_eq!(newest(["v1.0.0", "1.0.0"]), Some("v1.0.0"));
    assert_eq!(newest([""]), None);
}

#[test]
fn the_nightly_title_carries_its_version() {
    assert_eq!(
        find_version("wisp 99.1.0-nightly.20261024.317"),
        Some("99.1.0-nightly.20261024.317")
    );
    assert_eq!(find_version("wisp 1.2.3 (stable)"), Some("1.2.3"));
    assert_eq!(find_version("build 12.3 of 1.2.3-"), Some("1.2.3"));
    assert_eq!(find_version("no version"), None);
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// A semver version: no leading zeros (semver forbids them, and v1 compares "007" and "7" as equal-but-
/// unequal, which no release has ever used).
fn version(r: &mut Rng) -> String {
    let n = |r: &mut Rng| r.below(4).to_string();
    let mut v = format!("{}.{}.{}", n(r), n(r), n(r));
    if r.below(3) > 0 {
        let ids: Vec<String> = (0..=r.below(3))
            .map(|_| {
                if r.below(2) == 0 {
                    r.below(12).to_string()
                } else {
                    ["alpha", "beta", "nightly", "rc"][usize::try_from(r.below(4)).unwrap_or(0)]
                        .to_owned()
                }
            })
            .collect();
        v = format!("{v}-{}", ids.join("."));
    }
    if r.below(5) == 0 {
        v = format!("v{v}");
    }
    v
}

#[test]
fn property_newer_is_a_strict_total_order() {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let vs: Vec<String> = (0..60).map(|_| version(&mut r)).collect();
    for a in &vs {
        assert!(!newer(a, a), "irreflexive: {a}");
        for b in &vs {
            assert!(!(newer(a, b) && newer(b, a)), "asymmetric: {a} {b}");
            assert_eq!(compare(a, b), compare(b, a).reverse());
        }
    }
    // transitivity, and equal means same version apart from `v` and build metadata
    for a in &vs {
        for b in &vs {
            for c in vs.iter().take(30) {
                if compare(a, b) != Ordering::Less && compare(b, c) != Ordering::Less {
                    assert_ne!(compare(a, c), Ordering::Less, "{a} >= {b} >= {c}");
                }
            }
            if compare(a, b) == Ordering::Equal {
                assert_eq!(a.trim_start_matches('v'), b.trim_start_matches('v'));
            }
        }
    }
    let mut sorted = vs.clone();
    sorted.sort_by(|a, b| compare(a, b));
    assert!(sorted.windows(2).all(|w| !newer(&w[0], &w[1])));
}
