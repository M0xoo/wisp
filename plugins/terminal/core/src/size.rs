//! Terminal sizes as v1 read them from a page: clamped (cols 20..500, rows 5..200), 100 × 30 when
//! missing, nonsense keeps the size it had. Route bodies are loose JSON (`"120"`, `null`, `""`), so
//! the reading of a value is JavaScript's `Number()` where v1 relied on it.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub lo: u16,
    pub hi: u16,
    pub default: u16,
}

pub const COLS: Bounds = Bounds { lo: 20, hi: 500, default: 100 };
pub const ROWS: Bounds = Bounds { lo: 5, hi: 200, default: 30 };

/// `n` rounded into `b`, or `or` when `n` is no number.
pub fn clamp(n: Option<f64>, b: Bounds, or: u16) -> u16 {
    match n {
        Some(n) if n.is_finite() => {
            let r = n.round().clamp(f64::from(b.lo), f64::from(b.hi));
            // in lo..=hi, so it fits
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let v = r as u16;
            v
        }
        _ => or,
    }
}

/// A JSON value as a number, as v1 read it: numbers, and strings that are one (`"120"`). `null`, `""`
/// and the rest are none (v1's `Number(null)` was 0, clamped to the smallest terminal: a bug the TS
/// port fixed).
pub fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// JavaScript truthiness, for v1's `if (body.cols && body.rows)`.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamped_rounded_and_defaulted() {
        assert_eq!((clamp(Some(9999.0), COLS, 1), clamp(Some(1.0), ROWS, 1)), (500, 5));
        assert_eq!(clamp(Some(119.6), COLS, 1), 120);
        assert_eq!(clamp(None, COLS, COLS.default), 100, "no size: 100 × 30");
        assert_eq!(clamp(Some(f64::NAN), ROWS, 33), 33, "nonsense keeps the size");
        assert_eq!(clamp(Some(-4.0), COLS, 1), 20);
    }

    #[test]
    fn numbers_from_loose_json() {
        assert_eq!(number(&json!(90)), Some(90.0));
        assert_eq!(number(&json!(" 120 ")), Some(120.0));
        assert_eq!(number(&json!("wide")), None);
        assert_eq!(number(&json!(null)), None);
        assert_eq!(number(&json!("")), None);
        assert!(truthy(Some(&json!(80))) && truthy(Some(&json!("80"))));
        assert!(!truthy(Some(&json!(0))) && !truthy(Some(&json!(""))) && !truthy(None) && !truthy(Some(&json!(null))));
    }

    /// Property: whatever a page sends, the size is inside the bounds.
    #[test]
    fn always_in_bounds() {
        let mut rng = crate::testrand::Rng::new(3);
        for _ in 0..2000 {
            #[allow(clippy::cast_precision_loss)]
            let n = (rng.next() as f64 / 1e12) - 5000.0;
            for b in [COLS, ROWS] {
                let v = clamp(Some(n), b, b.default);
                assert!((b.lo..=b.hi).contains(&v), "{n} → {v}");
            }
        }
    }
}
