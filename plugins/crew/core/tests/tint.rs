//! The task panel's tint (v1 crewEditor `bg`): their glow, none, or a crew colour.
#![allow(clippy::unwrap_used)]

use wisp_crew_core::member::bg_of;

#[test]
fn a_members_tint_is_their_glow_none_or_a_crew_colour_and_anything_else_keeps_theirs() {
    assert_eq!(bg_of(Some(""), Some("teal")), ""); // back to their glow
    assert_eq!(bg_of(Some("none"), None), "none");
    assert_eq!(bg_of(Some("violet"), None), "violet");
    assert_eq!(bg_of(Some("#ff00ff"), Some("teal")), "teal"); // not a crew colour: what they had
    assert_eq!(bg_of(None, Some("amber")), "amber"); // an edit that leaves it out keeps it
    assert_eq!(bg_of(None, None), "");
}
