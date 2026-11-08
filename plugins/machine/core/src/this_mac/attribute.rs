//! Whose each process is (v1 Machine.#attribute). Every run is spawned with `WISP_TASK=<task>` and its
//! tree is everything under the runner's child pid. A pid once seen in a tree keeps its task, so a
//! process reparented to pid 1 is still known; the env tag (macOS `ps -E`, Linux `/proc/<pid>/environ`)
//! finds it on ones wisp never saw. wisp itself, what it started outside a run (Preview, the panel's
//! shells) and what started it are never a task's, never left behind and never stopped.
//!
//! size-ok: one attribution pass over the process table and its tests

use std::collections::{BTreeMap, HashMap, HashSet};

use wisp_machine_api::this_mac::{Leftover, LeftoverGroup, LiveRun};

use super::parse::{Proc, command_key};
use super::{LEFT_MS, Platform, SAME_SINCE_MS, round1};

/// Whose a pid is, and when that process started (a reused pid is another process).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    pub task: String,
    pub since: i64,
}

/// What attribution keeps between ticks: the tags, and on Linux each process's environ, read once.
#[derive(Debug, Clone)]
pub struct Attributor {
    pub platform: Platform,
    /// wisp's own pid
    pub me: u32,
    /// `<home>/worktrees/`, as the platform compares paths
    wt_dir: String,
    pub tags: HashMap<u32, Tag>,
    /// Linux: pid → (its start, the tag its environ had)
    pub environ: HashMap<u32, (i64, Option<String>)>,
}

/// One tick's answer: the snapshot with each process placed.
#[derive(Debug, Clone, Default)]
pub struct Placed {
    pub procs: Vec<Proc>,
    pub index: HashMap<u32, usize>,
    /// task → the pids of its tree, for the runs going now
    pub trees: BTreeMap<String, HashSet<u32>>,
    /// what started wisp (never stopped from here)
    pub ancestors: HashSet<u32>,
    /// left behind, before the 2-minute age check
    pub left: HashSet<u32>,
}

impl Placed {
    pub fn get(&self, pid: u32) -> Option<&Proc> {
        self.index.get(&pid).and_then(|i| self.procs.get(*i))
    }

    /// The pids whose memory the page shows: the runs' trees, what's left behind, and wisp.
    pub fn shown(&self, me: u32) -> Vec<u32> {
        let mut out: Vec<u32> = self
            .trees
            .values()
            .flatten()
            .chain(&self.left)
            .copied()
            .chain(std::iter::once(me))
            .filter(|p| self.index.contains_key(p))
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// macOS: `phys_footprint` in place of RSS where it read. True when any did.
    pub fn apply_footprints(&mut self, got: &HashMap<u32, u64>) -> bool {
        let mut any = false;
        for (pid, bytes) in got {
            if let Some(i) = self.index.get(pid)
                && let Some(p) = self.procs.get_mut(*i)
                && *bytes > 0
            {
                p.rss = *bytes;
                any = true;
            }
        }
        any
    }

    pub fn in_tree(&self, pid: u32) -> bool {
        self.trees.values().any(|s| s.contains(&pid))
    }
}

fn descendants(root: u32, kids: &HashMap<u32, Vec<u32>>) -> HashSet<u32> {
    let mut out = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if out.insert(pid)
            && let Some(k) = kids.get(&pid)
        {
            stack.extend(k);
        }
    }
    out
}

/// `(^|/)(launchd|systemd|init)\b`: a parent that adopts orphans.
fn adopter(command: &str) -> bool {
    ["launchd", "systemd", "init"].iter().any(|name| {
        command.match_indices(name).any(|(i, _)| {
            let before = command[..i].chars().next_back().is_none_or(|c| c == '/');
            let after = command[i + name.len()..]
                .chars()
                .next()
                .is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
            before && after
        })
    })
}

impl Attributor {
    pub fn new(platform: Platform, me: u32, home: &str) -> Self {
        let sep = if platform == Platform::Windows {
            '\\'
        } else {
            '/'
        };
        let base = home.trim_end_matches(['/', '\\']);
        let dir = if base.is_empty() {
            format!("worktrees{sep}")
        } else {
            format!("{base}{sep}worktrees{sep}")
        };
        let wt_dir = path_key(platform, &dir);
        Self {
            platform,
            me,
            wt_dir,
            tags: HashMap::new(),
            environ: HashMap::new(),
        }
    }

    /// Linux: the pids whose `/proc/<pid>/environ` to read before `place` (once per process).
    pub fn environ_wanted(&self, procs: &[Proc]) -> Vec<u32> {
        if self.platform != Platform::Linux {
            return Vec::new();
        }
        let fresh = |p: &Proc| {
            self.environ
                .get(&p.pid)
                .is_some_and(|(since, _)| (since - p.since).abs() < SAME_SINCE_MS)
        };
        procs
            .iter()
            .filter(|p| {
                p.rss > 0
                    && p.pid > 1
                    && p.pid != self.me
                    && !self.tags.contains_key(&p.pid)
                    && !fresh(p)
            })
            .map(|p| p.pid)
            .collect()
    }

    pub fn set_environ(&mut self, pid: u32, since: i64, task: Option<String>) {
        self.environ.insert(pid, (since, task));
    }

    /// Every task id a process names (its tag, its env, its environ): the host checks which exist.
    pub fn named_tasks(&self, procs: &[Proc]) -> HashSet<String> {
        let mut out: HashSet<String> = self.tags.values().map(|t| t.task.clone()).collect();
        out.extend(procs.iter().filter_map(|p| p.task.clone()));
        out.extend(self.environ.values().filter_map(|(_, t)| t.clone()));
        out
    }

    /// Places every process. `known(task)`: the task exists.
    pub fn place(
        &mut self,
        procs: Vec<Proc>,
        runs: &[LiveRun],
        known: &dyn Fn(&str) -> bool,
    ) -> Placed {
        let index: HashMap<u32, usize> =
            procs.iter().enumerate().map(|(i, p)| (p.pid, i)).collect();
        let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
        for p in procs.iter().filter(|p| p.pid != p.ppid) {
            kids.entry(p.ppid).or_default().push(p.pid);
        }
        let get = |pid: u32| index.get(&pid).and_then(|i| procs.get(*i));
        let same = |pid: u32, since: i64| {
            get(pid).is_some_and(|p| (p.since - since).abs() < SAME_SINCE_MS)
        };
        self.tags.retain(|pid, t| same(*pid, t.since));
        self.environ.retain(|pid, (since, _)| same(*pid, *since));
        let mut trees: BTreeMap<String, HashSet<u32>> = BTreeMap::new();
        for r in runs
            .iter()
            .filter(|r| r.pid != 0 && index.contains_key(&r.pid))
        {
            let set = descendants(r.pid, &kids);
            for pid in &set {
                if let Some(p) = get(*pid) {
                    self.tags.insert(
                        *pid,
                        Tag {
                            task: r.task.clone(),
                            since: p.since,
                        },
                    );
                }
            }
            trees.entry(r.task.clone()).or_default().extend(set);
        }
        let in_runs: HashSet<u32> = trees.values().flatten().copied().collect();
        let own: HashSet<u32> = descendants(self.me, &kids)
            .into_iter()
            .filter(|p| !in_runs.contains(p))
            .collect();
        let mut ancestors = HashSet::new();
        let mut at = get(self.me).map(|p| p.ppid);
        while let Some(p) = at.filter(|p| *p > 0 && ancestors.len() < 64) {
            if !ancestors.insert(p) {
                break;
            }
            at = get(p).map(|x| x.ppid);
        }
        let ours = |pid: u32| pid <= 1 || own.contains(&pid) || ancestors.contains(&pid);
        self.tag_from_env(&procs, &in_runs, &ours, known);
        // A tagged process reparented away while its task still runs is still the task's.
        for (pid, t) in &self.tags {
            if !ours(*pid)
                && let Some(tree) = trees.get_mut(&t.task)
            {
                tree.insert(*pid);
            }
        }
        let in_tree: HashSet<u32> = trees.values().flatten().copied().collect();
        let left = self.left_behind(&procs, &kids, &in_tree, &ours);
        Placed {
            procs,
            index,
            trees,
            ancestors,
            left,
        }
    }

    fn tag_from_env(
        &mut self,
        procs: &[Proc],
        in_runs: &HashSet<u32>,
        ours: &dyn Fn(u32) -> bool,
        known: &dyn Fn(&str) -> bool,
    ) {
        for p in procs {
            if in_runs.contains(&p.pid) || ours(p.pid) || self.tags.contains_key(&p.pid) {
                continue;
            }
            let task = p
                .task
                .clone()
                .or_else(|| self.environ.get(&p.pid).and_then(|(_, t)| t.clone()));
            if let Some(task) = task.filter(|t| known(t)) {
                self.tags.insert(
                    p.pid,
                    Tag {
                        task,
                        since: p.since,
                    },
                );
            }
        }
    }

    /// Tagged with a task that isn't running, or orphaned with a command under `<home>/worktrees`, and
    /// what those started.
    fn left_behind(
        &self,
        procs: &[Proc],
        kids: &HashMap<u32, Vec<u32>>,
        in_tree: &HashSet<u32>,
        ours: &dyn Fn(u32) -> bool,
    ) -> HashSet<u32> {
        let parent: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
        let orphan =
            |p: &Proc| p.ppid <= 1 || parent.get(&p.ppid).is_none_or(|pp| adopter(&pp.command));
        let mut left = HashSet::new();
        for p in procs {
            if in_tree.contains(&p.pid) || ours(p.pid) {
                continue;
            }
            if self.tags.contains_key(&p.pid)
                || (orphan(p) && path_key(self.platform, &p.command).contains(&self.wt_dir))
            {
                left.extend(
                    descendants(p.pid, kids)
                        .into_iter()
                        .filter(|d| !in_tree.contains(d) && !ours(*d)),
                );
            }
        }
        left
    }

    /// The task a pid is known by, if that task still exists.
    pub fn task_of(&self, pid: u32, known: &dyn Fn(&str) -> bool) -> Option<String> {
        self.tags
            .get(&pid)
            .map(|t| t.task.clone())
            .filter(|t| known(t))
    }

    /// The leftovers 2 min or older, heaviest first, and the same grouped by what started them.
    pub fn leftovers(
        &self,
        placed: &Placed,
        known: &dyn Fn(&str) -> bool,
        now: i64,
    ) -> (Vec<Leftover>, Vec<LeftoverGroup>) {
        let mut rows: Vec<Leftover> = placed
            .left
            .iter()
            .filter_map(|pid| placed.get(*pid))
            .filter(|p| now - p.since >= LEFT_MS)
            .map(|p| Leftover {
                pid: p.pid,
                command: p.command.clone(),
                rss: p.rss,
                cpu: round1(p.cpu),
                task: self.task_of(p.pid, known),
                since: p.since,
            })
            .collect();
        // heaviest first; the pid keeps the order the same tick to tick
        rows.sort_by(|a, b| b.rss.cmp(&a.rss).then(a.pid.cmp(&b.pid)));
        let groups = self.groups(placed, &rows, known);
        (rows, groups)
    }

    /// Grouped by each one's topmost left-behind ancestor and the task. A child with no task of its own
    /// takes its root's.
    fn groups(
        &self,
        placed: &Placed,
        rows: &[Leftover],
        known: &dyn Fn(&str) -> bool,
    ) -> Vec<LeftoverGroup> {
        let root_of = |pid: u32| {
            let mut r = placed.get(pid);
            for _ in 0..64 {
                match r.and_then(|x| {
                    placed
                        .left
                        .contains(&x.ppid)
                        .then(|| placed.get(x.ppid))
                        .flatten()
                }) {
                    Some(up) => r = Some(up),
                    None => break,
                }
            }
            r
        };
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, LeftoverGroup> = HashMap::new();
        for l in rows {
            let Some(root) = root_of(l.pid) else { continue };
            let task = self.task_of(root.pid, known).or_else(|| l.task.clone());
            let command = command_key(&root.command);
            let id = group_id(task.as_deref().unwrap_or_default(), &command);
            let g = groups.entry(id.clone()).or_insert_with(|| {
                order.push(id.clone());
                LeftoverGroup {
                    id,
                    command,
                    task,
                    count: 0,
                    rss: 0,
                    cpu: 0.0,
                    pids: Vec::new(),
                    commands: Vec::new(),
                    since: l.since,
                }
            });
            g.count += 1;
            g.rss += l.rss;
            g.cpu = round1(g.cpu + l.cpu);
            g.since = g.since.min(l.since);
            g.pids.push(l.pid);
            if g.commands.len() < 10 && !g.commands.contains(&l.command) {
                g.commands.push(l.command.clone());
            }
        }
        let mut out: Vec<LeftoverGroup> = order
            .into_iter()
            .filter_map(|id| groups.remove(&id))
            .collect();
        out.sort_by_key(|g| std::cmp::Reverse(g.rss));
        out
    }
}

/// The folder a command line names, as the platform compares paths: on Windows a command line may use
/// `/` or `\` and any case for the same folder (`C:/Users` and `c:\users`).
pub fn path_key(platform: Platform, s: &str) -> String {
    if platform == Platform::Windows {
        s.replace('\\', "/").to_lowercase()
    } else {
        s.to_owned()
    }
}

/// A group's id: 10 hex characters, the same for the same task and command on every tick (FNV-1a:
/// stable across builds, and a few groups at once never meet in 40 bits).
pub fn group_id(task: &str, command: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in task
        .bytes()
        .chain(std::iter::once(0))
        .chain(command.bytes())
    {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")[..10].to_owned()
}
