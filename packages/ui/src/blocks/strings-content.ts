// Copy of the content blocks (hero … terminal), in English (v1 web/js/blocks.js). Keys
// `block.<type>.*`; `block.content.*` for what several of them share.
export const CONTENT_STRINGS = {
  'block.content.showAll': 'Show all {n}',
  'block.content.added': 'Added',
  'block.content.modified': 'Modified',
  'block.content.deleted': 'Deleted',
  'block.content.renamed': 'Renamed',
  'block.content.openFile': 'Open in editor',

  'block.hero.title': 'Finished',
  'block.hero.done': 'Finished',
  'block.hero.partial': 'Partly done',
  'block.hero.blocked': 'Blocked',
  'block.hero.info': 'Report',

  'block.files.title': 'Files',
  'block.files.showDiff': 'Show diff',
  'block.files.hideDiff': 'Hide diff',

  'block.diff.missing': 'No captured edits for this file.',

  'block.code.label': 'code',

  // a .env file's values masked (v1 env-mask.js maskBar)
  'block.env.hidden': '{name}’s values are hidden',
  'block.env.shown': 'Showing {name}’s values',
  'block.env.reveal': 'Reveal',
  'block.env.hide': 'Hide',

  'block.compare.before': 'Before',
  'block.compare.after': 'After',

  'block.tests.green': 'All green',
  'block.tests.failing': '{n} failing',
  'block.tests.passed': 'passed',
  'block.tests.failed': 'failed',
  'block.tests.skipped': 'skipped',
  'block.tests.byWisp': 'Run by wisp',
  'block.tests.byWispWhy': 'wisp ran the project’s tests itself after the agent finished',
  'block.tests.rerun': 'Re-run',
  'block.tests.rerunWhat': 'Re-run {command}',

  'block.commits.title': 'Commits',
  'block.commits.file': '{n} file',
  'block.commits.files': '{n} files',

  'block.graph.state.conflict': 'conflicts',
  'block.graph.state.ready': 'ready',
  'block.graph.state.merged': 'merged',
  'block.graph.state.blocked': 'blocked',
  'block.graph.state.pending': 'checking',
  'block.graph.pr.open': 'Open',
  'block.graph.pr.draft': 'Draft',
  'block.graph.pr.merged': 'Merged',
  'block.graph.pr.closed': 'Closed',
  'block.graph.mergeInto': 'Merge into {into}',
  'block.graph.mergedInto': 'Merged into {into}',
  'block.graph.conflict': '{n} conflict',
  'block.graph.conflicts': '{n} conflicts',
  'block.graph.with': 'with {base}',
  'block.graph.ready': 'Ready to merge',
  'block.graph.blocked': 'Blocked',
  'block.graph.pending': 'Checks running',
  'block.graph.continue': 'Continue',
  'block.graph.ours': 'ours',
  'block.graph.theirs': 'theirs',
  'block.graph.base': 'base',

  'block.checklist.done': 'Done',
  'block.checklist.undone': 'Not done',

  'block.terminal.title': 'terminal',
  'block.terminal.exit': 'exit {code}',
  'block.terminal.run': 'Run',
  'block.terminal.runAgain': 'Run command again',
  'block.terminal.earlier': '{n} earlier lines',
} as const;
