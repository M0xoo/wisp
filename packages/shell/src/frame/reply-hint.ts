// What the reply box under a task says while the task asks you (v1 composer.js placeholder): one box answers, so a
// question reads "Answer <name>…" and a live approval "Or say what to do instead (denies it)…" (runtime's
// approval_decision: typed words that aren't a yes or no deny the call and go to the agent). Pure.

/** the i18n key for the reply box's placeholder */
export function replyPlaceholderKey(row: { readonly state?: string; readonly body?: Readonly<Record<string, unknown>> } | undefined): string {
  const ext = row?.body?.['ext'] as Record<string, unknown> | undefined;
  const ask = (ext?.['wisp.runtime'] as { ask?: unknown } | undefined)?.ask;
  if (!ask || typeof ask !== 'object') return 'shell.task.reply';
  return (ask as { permission?: unknown }).permission ? 'shell.task.replyDenies' : 'shell.task.replyAnswer';
}
