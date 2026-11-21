# semantle-duel

Plain Node (no build): `src/server.js` serves `public/index.html` and the duel API; duels are JSON files in
`DATA_DIR` (a Fly volume in production). `npm run dev` runs it locally with `.env`.

## Workflow

- Work comes from Linear, team **SMI**, project **Semantle Duel** (in-app feedback lands there as `[FEEDBACK] …`).
- One branch and PR per issue, named after the issue: use Linear's branch name (`briantsmiley42/smi-123-…`).
- Commit subjects and PR titles start with the issue ID in brackets, as in Nertz: `[SMI-123] What changed`.
  Linear's GitHub integration links them and marks the issue done on merge.
- Don't merge unless asked.
- **Merging never deploys.** Deploy only when asked: `fly deploy --remote-only` from an up-to-date `main`.
  Duels survive a deploy (they're on the volume); open pages need a reload to get new client code.
