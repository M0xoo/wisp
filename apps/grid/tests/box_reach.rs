//! A box never gets a token for a laptop (ADR-0014: the grid's trust rules as data, v1 grid/route.js): which answer
//! a `Box` credential gets at a computer. A verified box (its running box's own secret) is refused by the trust table:
//! 403. A `Box <handle> <secret>` whose secret isn't the running box's proves nobody: 401, Sign in first
//! (`crates/wisp/tests/serve_grid.rs` sends one).
#![allow(clippy::unwrap_used)]

use wisp_grid::trust::{Credential, Reach, Verdict, may};

#[test]
fn a_verified_box_is_refused_at_any_computer_and_its_page_alike_grid_box_reach() {
    for reach in [Reach::Computer, Reach::GridTunnel, Reach::GridReport] {
        match may(Credential::Box, reach) {
            Verdict::No(why) => assert!(why.contains("Box secret") || why.contains("laptop"), "{why}"),
            Verdict::Ok => panic!("a box reached {reach:?}"),
        }
    }
    // its own grid reaches stay: its channels and mail replies
    assert!(matches!(may(Credential::Box, Reach::GridChannels), Verdict::Ok));
    // a device of the computer's own user does reach it (the 403 is the box's, not every caller's)
    assert!(matches!(may(Credential::Device, Reach::Computer), Verdict::Ok));
}
