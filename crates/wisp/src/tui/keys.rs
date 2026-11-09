//! The keymap: one table, which the keys are handled by and `?` shows (generated, so it can't drift).

/// Where a binding works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Where {
    Everywhere,
    List,
    Task,
    Composer,
    View,
}

impl Where {
    pub fn title(self) -> &'static str {
        match self {
            Self::Everywhere => "Everywhere",
            Self::List => "Tasks",
            Self::Task => "The task",
            Self::Composer => "Composer",
            Self::View => "Views",
        }
    }
}

pub const KEYS: &[(Where, &str, &str)] = &[
    (Where::Everywhere, "Ctrl-K  :", "command palette: tasks, views, commands, settings"),
    (Where::Everywhere, "?", "this help (j k scroll it on a small screen)"),
    (Where::Everywhere, "Tab  Shift-Tab", "next zone · in the composer: cycle mode plan → edits → auto"),
    (Where::Everywhere, "g then c a m s , h t", "go to crew, automations, machines, My Stuff, settings, history, tasks"),
    (Where::Everywhere, "[  ]", "narrow or widen the focused zone (or drag its border)"),
    (Where::Everywhere, "Ctrl-C  q", "quit (q outside the composer)"),
    (Where::List, "j k  ↑ ↓", "move"),
    (Where::List, "Enter  l", "open the task"),
    (Where::List, "n", "new task"),
    (Where::List, "i", "reply to the selected task"),
    (Where::List, "/", "search"),
    (Where::Task, "i  Enter", "write (the composer)"),
    (Where::Task, "j k", "move between steps"),
    (Where::Task, "o  Space", "open or close the step (a tool call, a diff)"),
    (Where::Task, "1-9", "answer the question with that choice"),
    (Where::Task, "y  a  n", "allow · always allow · deny a tool"),
    (Where::Task, "Esc", "interrupt the running turn"),
    (Where::Task, "d", "the changes pane (diffs) · again: close it"),
    (Where::Task, "s", "stop"),
    (Where::Task, "PgUp PgDn  G", "scroll · to the end (and follow)"),
    (Where::Composer, "Enter", "send (queued while a turn runs)"),
    (Where::Composer, "Alt-Enter  Ctrl-J", "new line"),
    (Where::Composer, "@", "mention a task, crew member, machine, My Stuff item or file"),
    (Where::Composer, "/", "a command (/btw, /fork, /ship, /goal, any catalogue command)"),
    (Where::Composer, "↑", "history, in an empty box"),
    (Where::Composer, "Ctrl-E", "edit in $EDITOR"),
    (Where::Composer, "Alt-↑  Alt-↓  Ctrl-S", "reorder the queued follow-up · send it now"),
    (Where::Composer, "Esc", "leave the composer (interrupts when it's empty and a turn runs)"),
    (Where::View, "j k", "move"),
    (Where::View, "a letter", "the row's action (shown in the view's footer)"),
    (Where::View, "r", "reload"),
];
