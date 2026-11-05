# T-01M6MX48CNWXSXRSQ7R9Y5GVHW — skill-rot: count an inline code span as a command claim only when it is shaped like an invocation

Tier: ordinary (`packages/skill-rot` is not a trust-root package). Blocks: T-01M6MX13GCQYV7VGD9VRQHE35V (deployed doc links), which relies on R4.

## Intent

`skill-rot` exists so a skill that tells an agent to run a command that is gone goes stale. Today it also goes stale on almost every name written in backticks, so a real finding is buried and the gate cannot be used. Narrow what counts as a command claim to what is shaped like an invocation. A skill that documents a removed CLI must still fail the gate.

## Evidence

Measured with the in-tree extractor and verifier at upstream/main 780c3400 (throwaway scripts, not committed).

| corpus | source | ok | stale |
| --- | --- | ---: | ---: |
| this repo, 30 tracked SKILL.md | inline spans | 131 | 167 |
| this repo | unlabelled fences | 10 | 42 |
| this repo | `bash`/`sh` fences | 80 | 2 |
| mm-js, 48 SKILL.md | inline spans | 167 | 905 |
| mm-js | all fences | 217 | 106 |

- **Inline false positives:** API and field names (`execute.before`, `advisoryHooks`, `followUp.implementationSkill`, `github.blobBaseUrl`); tool names (`edit`, `adversarial-review`); enum values and labels (`bug`, `pending`, `main`); model ids (`gpt-5.6-terra-high`, `claude-opus-4-8-thinking-high`); file names (`SKILL.md`, `untranslated-string-audit.profile.yml`); snake_case keys (`spec_hash`, `transcript_path`); quoted messages (`refname is ambiguous`); subcommand fragments (`compare before.json after.json`).
- **Fence false positives:** box-drawing router diagrams in unlabelled fences (`Vague request, no ticket yet? ───→ P0`); TypeScript, TSX and JavaScript in `ts`/`tsx`/`js` fences (`const`, `await`); prose in `text`/`md` fences.
- **The reported case:** the deployed OpenCode router (`plugins/adlc-opencode/skill/adlc.md`) is stale on `adversarial-review`, `execute.before`, `edit` and `advisoryHooks`. These are 4 of its 6 stale claims; the other two are the doc paths T-01M6MX13GCQYV7VGD9VRQHE35V fixes.

## Rules

- **R1. Command-shaped word.** A token matching `/^[a-z][a-z0-9_-]*$/`. A dot, an uppercase letter or any other character disqualifies it, which rules out file names, dotted keys, versions, camelCase, PascalCase and slash commands. `_` stays allowed for real binaries such as `pg_dump`.
- **R2. Inline span.** The path check runs first, unchanged. After it, the span is a command claim on its first token only when that token is command-shaped and one of these holds:
  - (a) It is a known launcher: `adlc npx npm pnpm yarn bun bunx node deno git gh docker make python python3 pip cargo go curl sh bash`.
  - (b) A later token is a flag (`/^--?[A-Za-z]/`).
  - (c) The span starts with `$ `, an explicit prompt. It is stripped before the first token is read.
- **R3. Fenced block.** A block yields claims only when its info string is empty or its first word is a shell language: `sh bash zsh shell console shell-session terminal fish ksh`. Inside such a block, a line is a command claim only when its first token is command-shaped. Path handling of a line is unchanged.
- **R4. Linked code span.** A code span that is the entire text of a markdown link with an absolute `http(s)` target yields no claim, for example `` [`docs/x.md`](https://…) ``. The link says where the file lives, not that it exists here. A relative target is unchanged.
- **R5.** Script references (`npm run X`, `pnpm X`, `yarn X`) are unchanged.

Measured after the change with the real CLI: `skill-rot --json` to a file, before and after on the same trees.

| corpus | stale command claims | clean skills | stale skills |
| --- | --- | --- | --- |
| this repo (`skills plugins .claude/skills`, 30 skills) | 275 → 6 | 3 → 10 | 27 → 19 |
| mm-js `.agents/skills` (47 skills) | 1094 → 19 | 0 → 19 | 46 → 25 |

Path and script claims are unchanged: 32 and 1 here, 31 and 23 in mm-js. They are what keeps the remaining skills stale here, mostly repo-doc mentions that T-01M6MX13GCQYV7VGD9VRQHE35V lists.

The six left here are:
- `adversarial-review --prompt-only`: intended, since it is not on PATH;
- `ls-remote --symref`: a subcommand fragment;
- two shell-function lines.

In mm-js, the rest are subcommand fragments with flags (`check --table`), JavaScript in fences mislabelled `bash`, and Windows `winget`.

## Acceptance criteria

1. Name-shaped inline spans give no command claim. The cases: `execute.before`, `advisoryHooks`, `edit`, `write`, `adversarial-review`, `followUp.implementationSkill`, `typescript`, `node_modules`, `SKILL.md`, `github.blobBaseUrl`, `untranslated-string-audit.profile.yml`, `gpt-5.6-terra-high`, `claude-opus-4-8-thinking-high`, `spec_hash`, `PreToolUse`, `compare before.json after.json`, `refname is ambiguous`. Verify: `node --test packages/skill-rot/test/command-claims.test.mjs`
2. Invocation-shaped inline spans still give a command claim on their first token: `ls -la` → `ls`; `definitely-not-a-binary-xyz --flag` → `definitely-not-a-binary-xyz`; `npx adversarial-review` → `npx`; `git` → `git`; `$ removed-cli-xyz` → `removed-cli-xyz`; `pg_dump -Fc db` → `pg_dump`. Verify: `node --test packages/skill-rot/test/command-claims.test.mjs`
3. Fences give no claim from ` ```ts ` `const x = 1`, from ` ```json `, ` ```text ` or ` ```yaml ` lines, or from a box-drawing line in an unlabelled fence. They do give a claim from ` ```bash ` `removed-cli-xyz build`, from ` ```console ` `$ git status`, and from `git status` in an unlabelled fence. Verify: `node --test packages/skill-rot/test/command-claims.test.mjs`
4. `` [`docs/x.md`](https://github.com/o/r/blob/main/docs/x.md) `` gives no path claim. `` [`docs/x.md`](../docs/x.md) `` and a bare `` `docs/x.md` `` still do. Verify: `node --test packages/skill-rot/test/command-claims.test.mjs`
5. Real rot still fails the gate end to end. The real `bin/skill-rot.mjs`, run in a temp repo whose only skill documents `removed-cli-xyz --version` in a bash fence, exits 2 and names the command. A skill whose only spans are the names from AC 1 exits 0 as `[NO-CLAIMS]`. Verify: `node --test packages/skill-rot/test/command-claims.test.mjs`
6. The real `plugins/adlc-opencode/skill/adlc.md` yields no command claim named `adversarial-review`, `execute.before`, `edit`, `write` or `advisoryHooks`. Verify: `node --test packages/skill-rot/test/command-claims.test.mjs`
7. The existing suites stay green. A fixture that used a bare single word as a command changes only its input text; no assertion is removed or weakened. Verify: `node --test packages/skill-rot/test/*.test.mjs`, and `git diff "$(git merge-base origin/main HEAD)" -- packages/skill-rot/test | grep -E '^-\s*assert'` prints nothing.
8. The README and the docs-site page state R1–R4, the launcher list and the shell-language list. Verify: `grep -c -e 'command-shaped' -e 'shell-session' -e 'launcher' packages/skill-rot/README.md apps/docs/content/docs/toolkit/skill-rot.mdx` (each count > 0).
9. Full suite and PR gates green. Verify: `npm run preflight`

## Decisions

- **decided:** a bare single word is a name unless it is a launcher, over keeping single tokens. It is the largest false-positive class in both corpora, and the only way to remove `edit`, `adversarial-review`, `typescript` and the model ids (AC 1).
- **decided:** a flag, a launcher or an explicit `$ ` is what makes a span an invocation, over "two or more tokens". Measured: two-or-more still leaves `refname is ambiguous`, `commit or stash first`, `show <id>` and `ticket update` (15 stale here, 68 in mm-js) (AC 1, AC 2).
- **decided:** no "run `x`" prose cue. Measured: in mm-js it turns `lint`, `tc`, `knip` and `push` back into stale claims. "Run `lint`" usually means a package script, which script claims already cover (AC 1).
- **decided:** `$ ` is the explicit opt-in. A per-span opt-out marker is not added: it would be new syntax that renders visibly in every harness, and the measured corpora no longer need it. To keep a block out, label it `text` (AC 2, AC 3).
- **decided:** non-shell fences yield no claims at all, over scanning every fence. TypeScript and diagrams are the fence false positives, and the 80 `bash`/`sh` claims here are unaffected (AC 3).
- **decided:** a code span that is an absolute-URL link's whole text is not a claim. Linking a repo file by URL is how a skill says the file lives elsewhere; #1377 uses that form for `docs/interrogation-protocol.md` (AC 4).
- **decided:** fixtures that used bare single words (`` `ls` ``, `` Run `fake-tool-xyz` ``) change their input to an invocation (`ls -la`, `fake-tool-xyz --help`). Their assertions are untouched. The tests they belong to verify symlinks, zero-claim handling and exclusions, not what a command claim is (AC 7).

## Design alternatives

1. **Inline rule.**
   - Chosen: command-shaped first token, plus a launcher, a flag or `$ `.
   - Rejected: two or more tokens (see Decisions).
   - Rejected: dropping only dotted or camelCase first tokens. Measured: 111 stale left here, 573 in mm-js.
   - Rejected: inline spans never claim commands. It loses `definitely-not-a-binary-xyz --flag` and every inline invocation of a removed CLI.
2. **Opt-out.**
   - Chosen: none; `$ ` to opt in, a `text` label to keep a block out.
   - Rejected: an HTML-comment marker.
3. **Launcher list.**
   - Chosen: a fixed list in the extractor, documented in the README.
   - Rejected: a configurable list (new flag and config surface for a heuristic).

## Out of scope

- Shell continuation lines, and shell functions defined inside a block. Example: `claim <n>` in `.claude/skills/issue-lanes`, still stale.
- Whether `adlc <subcommand>` exists. Only the launcher is verified, as today.
- Script-reference scanning inside non-shell fences.
- The C10 wording in `ADLC.md`.
- `adversarial-review --prompt-only` and similar spans in other routers still claim `adversarial-review`. That is intended: those skills tell the reader to run it, and it is not on PATH unless installed.

---

## Change

- `packages/skill-rot/lib/extract-claims.mjs`:
  - `COMMAND_WORD_RE`, `LAUNCHERS` and `SHELL_FENCE_LANGS` constants.
  - `processInlineCode` applies R1/R2. The inline scan skips a span that is the whole text of an absolute-URL link (R4).
  - The fence scan reads the info string and skips non-shell fences (R3). `processCodeLine` requires a command-shaped first token.
- `packages/skill-rot/test/command-claims.test.mjs` (new): AC 1–6.
- Existing tests: input text only, per AC 7.
- `packages/skill-rot/README.md` and `apps/docs/content/docs/toolkit/skill-rot.mdx`: "What gets verified".
