---
name: add-migration
description: Use when a plugin needs a new table, column or index in the wisp v2 store, or changes the shape of rows or event bodies.
---

# Add a migration

1. Migrations live with their owner plugin (`host/src/migrations.ts`), numbered and forward-only. Never edit
   one that has shipped; add the next one.
2. Tables carry the plugin's prefix (`crew_member`, `chan_thread`). Kernel tables (`change`, `mutation`,
   `meta`, `blob`, `setting`, `plugin`) belong to `@wisp/store`; no plugin writes them directly.
3. STRICT tables, explicit types, `INTEGER PRIMARY KEY` or `TEXT` ids. Don't use `WITHOUT ROWID` for small rows.
4. Changing the shape of an event body bumps its `v`. Add an upcaster that reads the old shape; never
   rewrite history.
5. The store snapshots the database (`VACUUM INTO`) before upgrading. Test the migration on a database
   made by the previous version (`test/fixtures/`).
6. `.agents/bin/monoflow verify --affected`.
