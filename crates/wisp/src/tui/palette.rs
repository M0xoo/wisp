//! The command palette (Ctrl-K or `:`) and the pickers (`@`, `/`): a fuzzy match over items of every kind (tasks,
//! views, catalogue commands, settings, crew, machines, My Stuff, files).

/// What choosing an item does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    OpenTask(String),
    View(String),
    /// a catalogue command: the composer gets `/<id> `
    Command(String),
    /// an `@` mention or a path, put in the composer
    Insert(String),
    Setting(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub label: String,
    /// what kind it is, shown dim at the right (task, view, command, setting, crew, file…)
    pub kind: String,
    pub pick: Pick,
}

/// A fuzzy score: every query char in order, word starts and contiguous runs better, gaps worse; None when it
/// doesn't match. Each place the first char occurs is tried as the start.
pub fn score(query: &str, label: &str) -> Option<i64> {
    let q: Vec<char> = query.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    if q.is_empty() {
        return Some(0);
    }
    let l: Vec<char> = label.to_lowercase().chars().collect();
    (0..l.len()).filter(|i| l[*i] == q[0]).filter_map(|start| from(&q, &l, start)).max()
}

fn from(q: &[char], l: &[char], start: usize) -> Option<i64> {
    let mut at = start;
    let mut score = -i64::try_from(start).unwrap_or(0) / 4;
    let mut last: Option<usize> = None;
    for c in q {
        let i = (at..l.len()).find(|i| l[*i] == *c)?;
        score += 10;
        if last.is_some_and(|p| p + 1 == i) {
            score += 15;
        }
        if i == 0 || !l[i - 1].is_alphanumeric() {
            score += 8;
        }
        score -= i64::try_from(i - at).unwrap_or(0);
        last = Some(i);
        at = i + 1;
    }
    Some(score)
}

/// The best matches, best first (ties keep their order).
pub fn filter<'a>(items: &'a [Item], query: &str, max: usize) -> Vec<&'a Item> {
    let mut v: Vec<(i64, usize, &Item)> =
        items.iter().enumerate().filter_map(|(i, it)| score(query, &it.label).map(|s| (s, i, it))).collect();
    v.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    v.into_iter().take(max).map(|x| x.2).collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Palette {
    pub title: String,
    pub query: String,
    pub items: Vec<Item>,
    pub sel: usize,
}

impl Palette {
    pub fn new(title: &str, items: Vec<Item>) -> Self {
        Self { title: title.into(), items, ..Self::default() }
    }
    pub fn shown(&self) -> Vec<&Item> {
        filter(&self.items, &self.query, 50)
    }
    pub fn chosen(&self) -> Option<Item> {
        self.shown().get(self.sel).map(|i| (*i).clone())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn it(label: &str) -> Item {
        Item { label: label.into(), kind: "x".into(), pick: Pick::View(label.into()) }
    }

    #[test]
    fn fuzzy_finds_in_order_and_ranks_word_starts() {
        assert!(score("fl", "Fix the login").is_some());
        assert!(score("lf", "Fix the login").is_none(), "in order");
        let items = vec![it("settings"), it("ship it"), it("show stuff")];
        let got: Vec<&str> = filter(&items, "st", 5).iter().map(|i| i.label.as_str()).collect();
        assert_eq!(got[0], "show stuff", "a word start wins: {got:?}");
        assert_eq!(filter(&items, "", 5).len(), 3);
        let p = Palette { query: "ship".into(), ..Palette::new("x", items) };
        assert_eq!(p.chosen().unwrap().label, "ship it");
    }
}
