//! Numbers as v1 wrote them. JavaScript prints a whole `f64` without a fraction (`105`, not `105.0`);
//! serde_json keeps the `.0`. The page reads either, but goldens and older clients compare text, so a
//! whole value goes out as an integer.

use serde::Serializer;

/// The largest integer an `f64` holds exactly (2^53).
const EXACT: f64 = 9_007_199_254_740_992.0;

#[allow(clippy::trivially_copy_pass_by_ref)] // serde's serialize_with passes a reference
pub fn f64<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.fract() == 0.0 && v.abs() < EXACT {
        #[allow(clippy::cast_possible_truncation)] // whole and under 2^53: exact
        return s.serialize_i64(*v as i64);
    }
    s.serialize_f64(*v)
}

#[allow(clippy::ref_option)] // serde's serialize_with passes a reference
pub fn opt<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(x) => f64(x, s),
        None => s.serialize_none(),
    }
}
