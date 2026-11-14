//! One turn at a time per thread, side by side across threads (v1 conversation.js `Turns.queue`): the work behind
//! each ack waits for the thread's earlier work, so two quick messages in one thread are answered in order and a
//! button click waits for the message before it. A thread's queue is dropped once nothing waits on it.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

#[derive(Default)]
pub(crate) struct Turns {
    chains: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Turns {
    /// Runs `work` after the work already queued under `key` (tokio's mutex hands the turn over in order).
    pub(crate) async fn queue<T>(&self, key: &str, work: impl Future<Output = T>) -> T {
        let chain = self.chains.lock().unwrap_or_else(PoisonError::into_inner).entry(key.to_owned()).or_default().clone();
        let out = {
            let _turn = chain.lock().await;
            work.await
        };
        let mut chains = self.chains.lock().unwrap_or_else(PoisonError::into_inner);
        // this one and the map's: nobody else waits on the thread
        if Arc::strong_count(&chain) == 2 {
            chains.remove(key);
        }
        out
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.chains.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;

    /// v1 test/channel-slack.test.js "one at a time in a thread": the second message in a thread starts only after
    /// the first is answered, while another thread's runs alongside; nothing is kept once the threads are quiet.
    #[tokio::test]
    async fn one_turn_at_a_time_per_slack_thread_side_by_side_across_threads() {
        let turns = Arc::new(Turns::default());
        let log = Arc::new(Mutex::new(Vec::<&str>::new()));
        let step = |t: &Arc<Turns>, key: &'static str, name: &'static str, ms: u64| {
            let (t, log) = (t.clone(), log.clone());
            tokio::spawn(async move {
                t.queue(key, async {
                    log.lock().unwrap().push(name);
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    log.lock().unwrap().push(name);
                })
                .await;
            })
        };
        let a1 = step(&turns, "C1:1", "a1", 60);
        tokio::time::sleep(Duration::from_millis(5)).await;
        let a2 = step(&turns, "C1:1", "a2", 5);
        let b1 = step(&turns, "C1:9", "b1", 5);
        for h in [a1, a2, b1] {
            h.await.unwrap();
        }
        let log = log.lock().unwrap().clone();
        let at = |n: &str| log.iter().position(|x| *x == n).unwrap();
        let ends = |n: &str| log.iter().rposition(|x| *x == n).unwrap();
        assert!(ends("a1") < at("a2"), "the thread's second message waits for the first: {log:?}");
        assert!(ends("b1") < ends("a1"), "another thread doesn't wait: {log:?}");
        assert_eq!(turns.len(), 0);
    }
}
