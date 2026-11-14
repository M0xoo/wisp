---
name: change-a-contract
description: Use before changing anything other code or other machines depend on in wisp v2 - @wisp/kernel's contract, @wisp/protocol, a plugin's api package, an extension point, a data-part name, or a golden.
---

# Change a contract

1. `.agents/bin/monoflow graph impact <file>` lists every package the change reaches. Read their uses.
2. **Additive changes are free:** a new optional field, command, event, topic or extension point.
3. **Breaking changes are versioned:**
   - protocol: bump `PROTO`, keep the window (`proto_max-2`), and refresh the snapshot with
     `node tools/check/protocol-snapshot.ts --write`;
   - extension point or service: a new major is a new id (`git.service@2`); providers may expose both
     while consumers move;
   - `data-part` names and manifest fields: never renamed. Add a new name and map the old one in the
     compatibility table.
4. Update every consumer in the same PR (monoflow's impact list). Then `monoflow verify --affected`.
5. A changed golden (`test/goldens/`) is called out in the PR description, with why.
