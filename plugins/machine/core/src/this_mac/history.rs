//! A day of 1-minute points (v1 Machine.point): what the page's "last 24 h" and its sparklines read.
//! The host saves it every `SAVE_EVERY` points and on stop, so a restart keeps the day.

use std::collections::VecDeque;

use wisp_machine_api::this_mac::HistoryPoint;

use super::{HISTORY_MS, POINT_MS, SAVE_EVERY};

/// The most points a day holds.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // 1440
pub const MAX_POINTS: usize = (HISTORY_MS / POINT_MS) as usize;

#[derive(Debug, Clone, Default)]
pub struct History {
    points: VecDeque<HistoryPoint>,
    unsaved: u32,
}

impl History {
    /// What was saved, minus what's over 24 h old by `now`.
    pub fn load(saved: Vec<HistoryPoint>, now: i64) -> Self {
        let from = now - HISTORY_MS;
        let mut points: VecDeque<HistoryPoint> =
            saved.into_iter().filter(|p| p.at > from).collect();
        while points.len() > MAX_POINTS {
            points.pop_front();
        }
        Self { points, unsaved: 0 }
    }

    /// Adds a point taken at `p.at` and drops the ones 24 h older. True when it is time to save.
    pub fn push(&mut self, p: HistoryPoint) -> bool {
        let from = p.at - HISTORY_MS;
        self.points.push_back(p);
        while self.points.front().is_some_and(|x| x.at <= from) {
            self.points.pop_front();
        }
        self.unsaved += 1;
        self.unsaved >= SAVE_EVERY
    }

    /// Points not saved yet (the host saves on stop when there are any).
    pub fn unsaved(&self) -> u32 {
        self.unsaved
    }

    pub fn saved(&mut self) {
        self.unsaved = 0;
    }

    pub fn points(&self) -> Vec<HistoryPoint> {
        self.points.iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    pub fn last(&self) -> Option<&HistoryPoint> {
        self.points.back()
    }

    pub fn first(&self) -> Option<&HistoryPoint> {
        self.points.front()
    }
}
