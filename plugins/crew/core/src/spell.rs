
use serde_json::Value;
use wisp_crew_api::Member;

/// A spell's new definition reached its member (v1 crew-share.js:300-309): a change to what they do
/// (brief, kit, schedule, what starts them, mode) pauses them and keeps the oldest unseen definition
/// for the diff; any other change (a role, a face) just applies. Returns whether it paused them.
pub fn spell_changed(m: &mut Member, def: &Value, now: i64) -> bool {
    let Some(spell) = m.spell.as_mut() else { return false };
    let old = std::mem::replace(&mut spell.def, def.clone());
    let reviewed = wisp_crew_api::REVIEWED.iter().any(|f| old.get(f) != def.get(f));
    if reviewed {
        m.paused = true;
        if m.changed.is_none() {
            m.changed = Some(wisp_crew_api::Changed { from: old, at: now });
        }
    }
    reviewed
}
