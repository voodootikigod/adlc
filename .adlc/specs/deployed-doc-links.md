# T-01M6MX13GCQYV7VGD9VRQHE35V — Deployed plugin markdown: link ADLC repo docs by absolute GitHub URL

Tier: ordinary. `scripts/router/**` and plugin markdown are not trust-root paths; the trust-root plugin paths are `plugins/adlc-opencode/lib`, the hook directories and `rails-checker.mjs`. Depends on: T-01M6MX48CNWXSXRSQ7R9Y5GVHW (skill-rot R4).

Gate 1: spec approved by Rafael Belliard on 2026-11-05. Not recorded in the manifest: the approval entry must be signed, and this branch has no signing key for this repository.

## Intent

A file a plugin deploys must not point at a file only this repository has. Its links should work wherever the file is read: a consumer's `.opencode/skills/`, `.cursor/`, the Claude Code plugin cache, or a skills.sh install.

## Evidence

- **The OpenCode deploy copies verbatim.** `npx @adlc/opencode init` (and `/adlc-init`) copies `plugins/adlc-opencode/skill/adlc.md` to `.opencode/skills/adlc/SKILL.md`, in `deploySkills` in `plugins/adlc-opencode/lib/scaffold.mjs`.
- **That file points at repo-only paths.** Its "Rail enforcement in this harness" section names `docs/ci/rails-guard.yml` and links `../../../docs/integrations/opencode.md`. Neither path exists in a consumer, and in mm-js `adlc skill-rot .opencode/skills` reports both as stale.
- **Only four relative links exist in deployed files.** Scan: `git ls-files 'plugins/**/*.md' 'plugins/**/*.mdc' 'skills/**/*.md'`, minus `README.md`, `CHANGELOG.md` and `test/`. All four escape their plugin directory:

  | file | link |
  | --- | --- |
  | `plugins/adlc-opencode/skill/adlc.md:50` | `../../../docs/integrations/opencode.md` |
  | `plugins/adlc-cursor/rules/adlc.mdc:69` | `../../../docs/integrations/cursor.md` |
  | `plugins/adlc-cursor/agents/prosecutor.md:84` | `../../../docs/review-lenses/text-scanning-gates.md` |
  | `plugins/adlc-claude-code/agents/prosecutor.md:82` | `../../../docs/review-lenses/text-scanning-gates.md` |

- **The two routers are generated.** The router and the Cursor rule come from `scripts/router/router-model.mjs`, harness `rail-enforcement` sections, through `node scripts/router/gen-routers.mjs`. `scripts/test/router-drift.test.mjs` pins them byte for byte.
- **Existing absolute links all resolve.** Every absolute link in deployed files already points at `https://github.com/voodootikigod/adlc/blob/main/…`, and both targets exist: `docs/interrogation-protocol.md` ×8 (#820, PR #1377) and `docs/ci/rails-guard.yml` ×1.

## Acceptance criteria

1. In `scripts/router/router-model.mjs`, the `opencode` and `cursor` `rail-enforcement` sections link `docs/ci/rails-guard.yml` and their integration doc by `https://github.com/voodootikigod/adlc/blob/main/…`. The regenerated `plugins/adlc-opencode/skill/adlc.md` and `plugins/adlc-cursor/rules/adlc.mdc` match. Verify: `node scripts/router/gen-routers.mjs --check && node --test scripts/test/router-drift.test.mjs`
2. Both `agents/prosecutor.md` files link `docs/review-lenses/text-scanning-gates.md` by its absolute main URL. Verify: `node --test scripts/test/deployed-doc-links.test.mjs`
3. `scripts/test/deployed-doc-links.test.mjs` checks three things. (a) No tracked deployed markdown file has a relative link target outside its own `plugins/<p>/` or `skills/<s>/` directory, or one that names a missing file. Deployed markdown means `plugins/<p>/**` (except `README.md`, `CHANGELOG.md` and `test/`) and `skills/<s>/**`. (b) Every `https://github.com/voodootikigod/adlc/(blob|tree)/main/<path>` link in those files names a path that exists in this repo. (c) Both checks reject a fixture, so the test bites. Verify: `node --test scripts/test/deployed-doc-links.test.mjs`
4. `extractClaims` from `@adlc/skill-rot`, run over the real `plugins/adlc-opencode/skill/adlc.md`, gives no path claim starting with `docs/`. Verify: `node --test scripts/test/deployed-doc-links.test.mjs`
5. Deployment still copies verbatim, and the deployed copy equals the source. Verify: `node --test plugins/adlc-opencode/test/scaffold.test.mjs plugins/adlc-cursor/test/packaging.test.mjs`
6. Full suite and PR gates green. Verify: `npm run preflight`

## Decisions

- **decided:** absolute URLs pinned to `main`, over a release tag. This is the #820/#1377 precedent, which `plugins/adlc-cursor/test/packaging.test.mjs` already pins. A tag would need every release to rewrite the links, and nothing does that. The cost: a reader of an old install sees today's doc. AC 3b turns a moved or deleted doc into a red test here, so a link cannot rot silently (AC 1, AC 3).
- **decided:** fix the source, over rewriting in `scaffold.mjs`. `deploySkills` decides migration and de-duplication by comparing the deployed file with the source byte for byte: `readFileSync(outFile, 'utf8') === source`, and the same for the legacy copy. A rewrite would break that comparison. It would also fix only OpenCode, while Cursor, the Claude Code marketplace and skills.sh install by other paths (AC 5).
- **decided:** keep the code-span link text, as in `` [`docs/ci/rails-guard.yml`](https://…) `` followed by "in the ADLC repo", so the reader still sees the file name. skill-rot R4 keeps it from reading as a local path (AC 1, AC 4).
- **decided:** the guard test lives in `scripts/test/`, not in each plugin. It is one suite-wide rule over eight plugin directories and `skills/` (AC 3).

## Out of scope (list for a follow-up issue)

Bare code-span mentions of ADLC-repo files in other deployed markdown. A reader in a consumer repo cannot open them, and skill-rot reports them as stale paths. Measured over the same file set:

| path | mentioned in |
| --- | --- |
| `docs/interrogation-protocol.md` | claude-code, codex, copilot, cursor, gemini, opencode, pi, `skills/adlc` |
| `docs/ci/rails-guard.yml` | claude-code, copilot, cursor (commands and skills), gemini, the shared router prose, `skills/adlc`, `skills/adlc-init` |
| `docs/ci/adlc-maintenance.yml` | claude-code, codex, copilot, gemini, opencode `command/adlc-maintain.md`, `skills/adlc`, `skills/adlc-init` |
| `scripts/rails-guard-ci.mjs` | claude-code, copilot, cursor, gemini (the shared P5 trust-root prose) |
| `docs/specs/issue-autopilot-local.md`, `packages/prosecute/README.md`, `packages/prosecute/lib/tier.mjs` | claude-code |
| `docs/examples/p5-passes.json` (not in backticks) | codex, copilot, pi `adlc-prosecute` skills |

- `scripts/test/rails-guard-workflow-hashes.json`, which the shared P5 router prose lists as a trust-root file, **does not exist in this repo either**. It is stale here, not only in consumers.
- Also out of scope: a deploy-time rewrite, pinning to a release tag, plugin README links (READMEs are not deployed into consumer repos), and the shared `prose:phases` router text.

---

## Change

- `scripts/router/router-model.mjs`: the `opencode` and `cursor` `rail-enforcement` strings. The six routers are regenerated with `node scripts/router/gen-routers.mjs`; only two change.
- `plugins/adlc-cursor/agents/prosecutor.md` and `plugins/adlc-claude-code/agents/prosecutor.md`: one link each.
- `scripts/test/deployed-doc-links.test.mjs` (new): AC 2–4.
