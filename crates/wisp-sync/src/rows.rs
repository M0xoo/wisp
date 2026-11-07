//! The read side a host needs to answer `Output::WindowRequest`, kept here so every store adapter
//! pages the same way.

use wisp_protocol::Row;

/// A window page (plan §4.3): from `events` (ascending by seq), those with seq < `before_seq`,
/// newest first, at most `limit`. `done` is true when nothing older is left.
pub fn window_page(events: &[(u64, Row)], before_seq: u64, limit: u32) -> (Vec<Row>, bool) {
    let end = events.partition_point(|(seq, _)| *seq < before_seq);
    let n = usize::try_from(limit).unwrap_or(usize::MAX).min(end);
    let rows = events[end - n..end]
        .iter()
        .rev()
        .map(|(_, r)| r.clone())
        .collect();
    (rows, n == end)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pages_newest_first_below_before_seq() {
        let ev: Vec<(u64, Row)> = (1..=5)
            .map(|s| {
                (
                    s * 10,
                    Row {
                        e: "event".into(),
                        id: s.to_string(),
                        v: json!(s),
                    },
                )
            })
            .collect();
        let ids = |rows: &[Row]| rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        let (rows, done) = window_page(&ev, 45, 2);
        assert_eq!(
            (ids(&rows), done),
            (vec!["4".to_owned(), "3".to_owned()], false)
        );
        let (rows, done) = window_page(&ev, 25, 9);
        assert_eq!(
            (ids(&rows), done),
            (vec!["2".to_owned(), "1".to_owned()], true)
        );
        assert_eq!(window_page(&ev, 5, 3), (vec![], true));
        assert!(window_page(&ev, 10, 0).1);
    }
}
