//! A plugin's read-then-write of its own ext slot on a task (`runtime.setExt`), as one compare-and-set: the slot
//! is read, the caller decides, and the write goes only while the slot still holds what was read (`expect`). If
//! another write landed in between (an event's handler, a second command, another task's round), the slot is
//! read again and the caller decides again, so a value computed from a stale copy never lands. Two real CI flakes
//! came from the plain read-then-write (wisp.goal's judging round, wisp.history's offer vs save).

use serde_json::{Map, Value};
use wisp_kernel::{Call, Code, Ctx, Result, WireError};

use crate::commands::{ExtExpect, Get, IdArgs, SetExt, SetExtArgs};
use crate::model::Session;

/// How many times [`update_ext`] reads again after another write landed between its read and its write.
pub const RACES: usize = 8;

/// `plugin`'s slot on task `id`, read then written in one compare-and-set. `next(slot, task)` decides from what the
/// slot holds now (`Null`: empty; the whole task for anything else it needs): `Ok(None)` writes nothing, `Err`
/// refuses (both end the update). Called again on each conflict, so it must decide from its arguments, not from a
/// copy it took before. `Ok(Some(v))`: `v` was written.
///
/// # Errors
/// What `runtime.get` / `runtime.setExt` or `next` refuse with; `conflict` after [`RACES`] writes in a row.
pub async fn update_ext<F>(ctx: &Ctx, call: &Call, id: &str, plugin: &str, mut next: F) -> Result<Option<Value>>
where
    F: FnMut(&Value, &Session) -> Result<Option<Value>> + Send,
{
    for _ in 0..RACES {
        let task = ctx.run::<Get>(call, IdArgs { id: id.into() }).await?;
        let slot = task.ext_of(plugin).clone();
        let Some(value) = next(&slot, &task)? else { return Ok(None) };
        let a = SetExtArgs { id: id.into(), plugin: plugin.into(), value: value.clone(), expect: Some(ExtExpect { value: slot }) };
        match ctx.run::<SetExt>(call, a).await {
            Ok(_) => return Ok(Some(value)),
            Err(e) if e.code == Code::Conflict => {}
            Err(e) => return Err(e),
        }
    }
    Err(WireError::conflict(format!("{id}'s {plugin} slot kept changing ({RACES} writes in a row)")))
}

/// `slot` (an object, or `{}`) with `extra`'s keys set over it: what a merge into a slot writes.
pub fn merged(slot: &Value, extra: &Value) -> Value {
    let mut v = Some(slot.clone()).filter(Value::is_object).unwrap_or_else(|| Value::Object(Map::new()));
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    v
}
