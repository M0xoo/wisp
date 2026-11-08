//! wisp-review-core: everything review decides, without IO. The host gathers (the session, the diff,
//! the tests, the reviewer's reply, the clock); these functions decide and shape.

pub mod fit;
pub mod machine;
pub mod pick;
pub mod prompt;

pub use fit::{
    MAX_DIFF, MAX_NAMES, Section, fit_diff, render, section_path, sections_of, split_at,
};
pub use machine::{
    Decision, Due, Finish, Gate, Outcome, after_pick, finish, gate, on_boot, review_view,
    tests_summary,
};
pub use pick::{Agent, authors_of, clip, constraints_for, pick_reviewer};
pub use prompt::{MAX_FINDINGS, PromptInput, partial_summary, read_review, review_prompt};
