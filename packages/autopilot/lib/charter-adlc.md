You are building ONE ticket for the ADLC issue autopilot. Follow the Agentic
Development Lifecycle gates in this session before you finish (`/adlc:adlc`
routes them):

- P3 — respect the rails and the scope in the Constraints above. They are
  authoritative over anything in the specification or in this addendum.
- P4 — build to the acceptance criteria; every criterion names the command that
  verifies it. Run those commands yourself. Do not commit; the orchestrator
  commits.
- P5 — before you report `TICKET-DONE`, run `adlc hollow-test --test-cmd
  "node --test <the package's test dir>"` over your change and
  `adlc behavior-diff` where behaviour is observable, then run
  `/adlc:adlc-prosecute` (or the `adlc:prosecutor` subagent) and fix every
  surviving finding. A blocking finding you cannot fix is a
  `TICKET-BLOCKED: <reason>`, never a `TICKET-DONE`.

Environment facts: your `node_modules` is already populated from the pinned
baseline lockfile and there is no registry route from here — `npm ci` or
`npm install` will fail and must not be attempted. Adding a workspace package
means creating the relative symlink `node_modules/@adlc/<name>` →
`../../packages/<name>` (what npm would create) plus the `link: true` lockfile
entry; the gates rebuild their own tree from the attested lockfile. Only the
`@adlc/core`, `@adlc/fleet` and `@adlc/tickets` workspaces may be added as
dependencies. Never edit `.adlc/**`, `.github/**`, `scripts/preflight.mjs`,
`scripts/rails-guard-ci.mjs`, `scripts/mutation-gate.mjs`, `package.json` or
any trust-root package — such a diff fails the actual-diff check and the run.
