# semantle-duel

Plain Node (no build): `src/server.js` serves `public/index.html` and the duel API; duels are JSON files in
`DATA_DIR` (a Fly volume in production). `npm run dev` runs it locally with `.env`.

"random word" duels draw from `src/words.json`: Semantle's archive answers plus our own words filtered by
Claude Haiku. Rebuild it with `node --env-file=.env scripts/build-words.js` (needs `data/vectors` and
`ANTHROPIC_API_KEY`; caches in `data/words-cache`).

## Workflow

- Work comes from Linear, team **SMI**, project **Semantle Duel** (in-app feedback lands there as `[FEEDBACK] …`).
- One branch and PR per issue, named after the issue: use Linear's branch name (`briantsmiley42/smi-123-…`).
- Commit subjects and PR titles start with the issue ID in brackets, as in Nertz: `[SMI-123] What changed`.
  Linear's GitHub integration links them and marks the issue done on merge.
- Branch from `origin/staging`; PRs target `staging` (`gh pr create --base staging`). Never merge to `main` directly.
- Don't merge unless asked.
- Each open PR gets its own preview, `semantle-duel-pr-N.fly.dev`, with an empty volume and no feedback keys; a
  comment on the PR says where and which commit. Merging into `staging` deploys `semantle-duel-staging.fly.dev`;
  merging `staging` into `main` deploys production (`semantle-duel`). See `.github/workflows/`.
  Duels survive a deploy (they're on the volume); open pages need a reload to get new client code.
