// Where the prompt boxes keep what's being written (kind 5, the client's drafts store: across reloads and updates,
// v1 F-task-32). New task's is `<home>:launcher` → `text`, the key wisp.stuff's share-in writes to as well; a reply's
// is its task's key → `reply`.

/** New task's draft: the entity and field */
export const launcherDraft = (home: string): readonly [string, string] => [`${home}:launcher`, 'text'];

/** A task's reply draft */
export const replyDraft = (task: string): readonly [string, string] => [task, 'reply'];

/** An empty box holds no draft (the store drops the key) */
export const draftValue = (v: string): string | undefined => (v === '' ? undefined : v);
