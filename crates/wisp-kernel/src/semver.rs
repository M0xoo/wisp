//! A small semver: exact versions and the ranges manifests use (`^1`, `~1.2`, `>=1.2.0 <2`, `1.x`, `*`,
//! `a || b`). npm's rules for 0.x carets and pre-releases; nothing else, so no dependency.
use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Pre {
    Num(u64),
    Str(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pre: Vec<Pre>,
}

impl Version {
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let s = s.strip_prefix('v').unwrap_or(s);
        let s = s
            .split_once('+')
            .map_or(s, |(v, build)| if ident_ok(build) { v } else { "" });
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (s, None),
        };
        let mut it = core.split('.');
        let (major, minor, patch) = (num(it.next()?)?, num(it.next()?)?, num(it.next()?)?);
        if it.next().is_some() {
            return None;
        }
        let pre = match pre {
            Some(p) => parse_pre(p)?,
            None => Vec::new(),
        };
        Some(Self {
            major,
            minor,
            patch,
            pre,
        })
    }

    const fn plain(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
            pre: Vec::new(),
        }
    }

    pub fn is_pre(&self) -> bool {
        !self.pre.is_empty()
    }
}

fn ident_ok(s: &str) -> bool {
    !s.is_empty()
        && s.split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn parse_pre(p: &str) -> Option<Vec<Pre>> {
    if !ident_ok(p) {
        return None;
    }
    Some(
        p.split('.')
            .map(|x| {
                x.parse::<u64>()
                    .map_or_else(|_| Pre::Str(x.to_owned()), Pre::Num)
            })
            .collect(),
    )
}

/// A version number: digits, no leading zero.
fn num(s: &str) -> Option<u64> {
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    s.parse().ok()
}

fn cmp_pre(a: &[Pre], b: &[Pre]) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        // a release sorts after its pre-releases
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    for (x, y) in a.iter().zip(b) {
        let o = match (x, y) {
            (Pre::Num(x), Pre::Num(y)) => x.cmp(y),
            (Pre::Num(_), Pre::Str(_)) => Ordering::Less,
            (Pre::Str(_), Pre::Num(_)) => Ordering::Greater,
            (Pre::Str(x), Pre::Str(y)) => x.cmp(y),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    a.len().cmp(&b.len())
}

impl Ord for Version {
    fn cmp(&self, o: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(o.major, o.minor, o.patch))
            .then_with(|| cmp_pre(&self.pre, &o.pre))
    }
}
impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Ge,
    Lt,
    Gt,
    Le,
    Eq,
}

#[derive(Debug, Clone)]
struct Comparator {
    op: Op,
    v: Version,
}

impl Comparator {
    fn test(&self, v: &Version) -> bool {
        let o = v.cmp(&self.v);
        match self.op {
            Op::Ge => o != Ordering::Less,
            Op::Lt => o == Ordering::Less,
            Op::Gt => o == Ordering::Greater,
            Op::Le => o != Ordering::Greater,
            Op::Eq => o == Ordering::Equal,
        }
    }
}

/// A parsed range: OR-sets of AND-ed comparators.
#[derive(Debug, Clone)]
pub struct Range(Vec<Vec<Comparator>>);

fn wild(s: Option<&str>) -> bool {
    matches!(s, None | Some("x" | "X" | "*"))
}

const OPS: [(&str, &str); 7] = [
    (">=", ">="),
    ("<=", "<="),
    (">", ">"),
    ("<", "<"),
    ("=", "="),
    ("^", "^"),
    ("~", "~"),
];

fn split_op(t: &str) -> (&str, &str) {
    for (p, op) in OPS {
        if let Some(rest) = t.strip_prefix(p) {
            return (op, rest);
        }
    }
    ("", t)
}

/// One term ('^1.2', '>=1', '1.x') as comparators.
#[allow(clippy::many_single_char_names)]
fn term(t: &str) -> Option<Vec<Comparator>> {
    let (op, rest) = split_op(t);
    let rest = rest.strip_prefix('v').unwrap_or(rest);
    let (core, pre) = match rest.split_once('-') {
        Some((c, p)) => (c, Some(parse_pre(p)?)),
        None => (rest, None),
    };
    let mut parts = core.split('.');
    let (ma, mi, pa) = (parts.next(), parts.next(), parts.next());
    if parts.next().is_some() {
        return None;
    }
    let part = |s: Option<&str>| -> Option<u64> { if wild(s) { Some(0) } else { num(s?) } };
    if wild(ma) {
        return Some(if op == "<" || op == ">" {
            vec![Comparator {
                op: Op::Lt,
                v: Version::plain(0, 0, 0),
            }]
        } else {
            Vec::new()
        });
    }
    let (m, n, p) = (part(ma)?, part(mi)?, part(pa)?);
    let full = !wild(mi) && !wild(pa);
    let low = Version {
        pre: pre.unwrap_or_default(),
        ..Version::plain(m, n, p)
    };
    // the first version past this partial: '1' → 2.0.0, '1.2' → 1.3.0
    let next = if wild(mi) {
        Version::plain(m + 1, 0, 0)
    } else if wild(pa) {
        Version::plain(m, n + 1, 0)
    } else {
        Version::plain(m, n, p + 1)
    };
    let c = |op, v| Comparator { op, v };
    Some(match op {
        "^" => {
            let up = if m > 0 || wild(mi) {
                Version::plain(m + 1, 0, 0)
            } else if n > 0 || wild(pa) {
                Version::plain(0, n + 1, 0)
            } else {
                Version::plain(0, 0, p + 1)
            };
            vec![c(Op::Ge, low), c(Op::Lt, up)]
        }
        "~" => vec![
            c(Op::Ge, low),
            c(
                Op::Lt,
                if wild(mi) {
                    Version::plain(m + 1, 0, 0)
                } else {
                    Version::plain(m, n + 1, 0)
                },
            ),
        ],
        ">=" => vec![c(Op::Ge, low)],
        "<" => vec![c(Op::Lt, low)],
        ">" => vec![if full {
            c(Op::Gt, low)
        } else {
            c(Op::Ge, next)
        }],
        "<=" => vec![if full {
            c(Op::Le, low)
        } else {
            c(Op::Lt, next)
        }],
        _ => {
            if full {
                vec![c(Op::Eq, low)]
            } else {
                vec![c(Op::Ge, low), c(Op::Lt, next)]
            }
        }
    })
}

impl Range {
    pub fn parse(range: &str) -> Option<Self> {
        if range.trim().is_empty() {
            return None;
        }
        let mut sets = Vec::new();
        for alt in range.split("||") {
            // '>= 1.2' is one term: glue an operator to the version after it
            let mut terms: Vec<String> = Vec::new();
            let mut glue = false;
            for w in alt.split_whitespace() {
                if glue {
                    if let Some(last) = terms.last_mut() {
                        last.push_str(w);
                    }
                } else {
                    terms.push(w.to_owned());
                }
                glue = split_op(w).1.is_empty();
            }
            if glue {
                return None;
            }
            let mut set = Vec::new();
            for t in if terms.is_empty() {
                vec!["*".to_owned()]
            } else {
                terms
            } {
                set.extend(term(&t)?);
            }
            sets.push(set);
        }
        Some(Self(sets))
    }

    /// A pre-release only matches a set naming a pre-release of the same major.minor.patch (npm's
    /// rule), so `^1` never picks `2.0.0-beta`.
    pub fn matches(&self, v: &Version) -> bool {
        self.0.iter().any(|set| {
            if !set.iter().all(|c| c.test(v)) {
                return false;
            }
            !v.is_pre()
                || set.iter().any(|c| {
                    c.v.is_pre() && (c.v.major, c.v.minor, c.v.patch) == (v.major, v.minor, v.patch)
                })
        })
    }
}

pub fn valid_version(v: &str) -> bool {
    Version::parse(v).is_some()
}

pub fn valid_range(r: &str) -> bool {
    Range::parse(r).is_some()
}

/// Does `version` satisfy `range`? Either one failing to parse is a no.
pub fn satisfies(version: &str, range: &str) -> bool {
    match (Version::parse(version), Range::parse(range)) {
        (Some(v), Some(r)) => r.matches(&v),
        _ => false,
    }
}

pub fn major_of(v: &str) -> Option<u64> {
    Version::parse(v).map(|v| v.major)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(valid_version("1.2.3"));
        assert!(valid_version("v1.2.3-beta.1+build"));
        assert!(!valid_version("1.2"));
        assert!(!valid_version("01.2.3"));
        assert!(!valid_version("1.2.3-"));
        assert!(Version::parse("1.0.0-alpha") < Version::parse("1.0.0-alpha.1"));
        assert!(Version::parse("1.0.0-alpha.1") < Version::parse("1.0.0-beta"));
        assert!(Version::parse("1.0.0-rc.1") < Version::parse("1.0.0"));
        assert!(Version::parse("1.0.0-2") < Version::parse("1.0.0-10"));
    }

    #[test]
    fn ranges() {
        let yes = [
            ("1.2.3", "^1"),
            ("1.9.0", "^1.2"),
            ("0.2.5", "^0.2"),
            ("0.0.3", "^0.0.3"),
            ("1.2.9", "~1.2"),
            ("1.5.0", ">=1.2.0 <2"),
            ("1.5.0", ">= 1.2.0 < 2"),
            ("1.4.0", "1.x"),
            ("3.0.0", "*"),
            ("2.0.0", "^1 || ^2"),
            ("1.2.3", "1.2.3"),
            ("1.2.3", "=1.2.3"),
            ("1.3.0", ">1.2"),
            ("1.2.9", "<=1.2"),
            ("2.0.0-beta.2", ">=2.0.0-beta.1"),
            ("1.0.0", ""),
            ("1.0.0", "1"),
        ];
        for (v, r) in yes {
            assert!(r.is_empty() || satisfies(v, r), "{v} should satisfy {r}");
        }
        let no = [
            ("2.0.0", "^1"),
            ("0.3.0", "^0.2"),
            ("0.0.4", "^0.0.3"),
            ("1.3.0", "~1.2"),
            ("2.0.0-beta", "^1"),
            ("2.0.0-beta", ">=1"),
            ("1.2.0", ">1.2"),
            ("1.3.0", "<=1.2"),
            ("1.2.4", "1.2.3"),
        ];
        for (v, r) in no {
            assert!(!satisfies(v, r), "{v} should not satisfy {r}");
        }
        assert!(!valid_range(""));
        assert!(!valid_range("^a.b"));
        assert!(!valid_range(">="));
        assert!(valid_range("^1"));
    }
}
