//! The Org page layout (v1 routes/crew.js PUT /crew-layout): where you put each member, x from the
//! chart's middle and y from its top, in px. Members that exist only; rounded and clamped.

use serde_json::Value;
use wisp_crew_api::Member;
use wisp_crew_api::commands::{Layout, Point};

use crate::error::{Result, bad};

const FAR: f64 = 20_000.0;

#[allow(clippy::cast_possible_truncation)] // clamped to ±20 000 first
fn round(v: f64, lo: f64) -> i64 {
    v.clamp(lo, FAR).round() as i64
}

/// `{ [id]: { x, y } }` → the layout to keep, or v1's sentence saying what's wrong.
pub fn normalize_layout(raw: &Value, crew: &[Member]) -> Result<Layout> {
    let Some(obj) = raw.as_object() else { return Err(bad("layout must be { [member id]: { x, y } }.")) };
    let mut out = Layout::new();
    for m in crew {
        let Some(p) = obj.get(&m.id) else { continue };
        let num = |k: &str| p.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
        let (Some(x), Some(y)) = (num("x"), num("y")) else {
            return Err(bad(format!("Where {} sits needs a number x and y.", m.name)));
        };
        out.insert(m.id.clone(), Point { x: round(x, -FAR), y: round(y, 0.0) });
    }
    Ok(out)
}

/// The layout as read: only members still on the crew.
pub fn layout_of(saved: &Layout, crew: &[Member]) -> Layout {
    saved.iter().filter(|(id, _)| crew.iter().any(|m| &m.id == *id)).map(|(k, v)| (k.clone(), *v)).collect()
}
