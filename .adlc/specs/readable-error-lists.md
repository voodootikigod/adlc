# Print one error reason per line

Tier: bounded. A display change to human-readable error text in seven packages.

## Problem

Some error paths join a list of reasons with `"; "` on one line. With several reasons the
line gets very long: `gate-manifest record spec-approval` with bad data prints one line of
1000 characters with 9 reasons. `adlc accept` with no arguments prints 160 characters.
`spec-lint` on a spec with no criteria prints one 197-character line.

Other paths already print a heading, then one reason per line indented with two spaces:
`coldstart` ("ticket file errors:"), `adlc run` ("evidence rejected:") and
`review-calibration` ("plants file problems:"). This change copies that format.

## Behaviour

1. `@adlc/core` exports `reasonList(heading, reasons)` from `packages/core/lib/text.mjs`,
   declared in `packages/core/index.d.ts` as
   `export function reasonList(heading: string, reasons: readonly string[]): string;`.
   - No reasons: returns `heading`.
   - One reason: returns `${heading} ${reason}` (one line).
   - Two or more: returns `heading`, then each reason on its own line, prefixed with two
     spaces (`'  '`), joined with `\n`. No trailing newline.
   - Reason text is never changed, split or reworded.
2. Call sites (human-readable output only):
   - `packages/runner/bin/adlc.mjs`, `adlc accept` failure:
     `opError(reasonList('P6 acceptance refused:', result.errors))`.
   - `packages/runner/bin/adlc.mjs`, `adlc run` operational errors:
     `opError(reasonList(`adlc ${phase}: cannot check evidence:`, result.errors))`.
   - `packages/gate-manifest/bin/gate-manifest.mjs`, spec-approval refusal:
     `opError(reasonList('spec-approval record refused:', errors))`.
   - `packages/flail-detector/bin/flail-detector.mjs`, could-not-analyze:
     `reasonList('flail-detector: could not analyze —', reasons)`.
   - `packages/parallax/bin/parallax.mjs`, the four `warnings:` lines:
     `console.error('\n' + reasonList('warnings:', errors))`.
   - `packages/hollow-test/bin/hollow-test.mjs`, diff-derived zero mutants:
     `reasonList('diff-derived file(s) produced zero mutants —', parts)`. One part: the
     message is byte-identical to today (`— <part>. The changed code …`). Several parts:
     the closing sentence `The changed code was never actually verified; refusing to report
     a pass.` goes on its own line after the list.
3. `packages/spec-lint/bin/spec-lint.mjs`, no acceptance criteria: the message becomes three
   lines:

   ```text
   spec-lint: no acceptance criteria found.
   State at least one criterion under a recognized heading (Acceptance Criteria / Requirements).
   Give each criterion a verification method. Zero criteria fails the gate.
   ```

4. Unchanged: `--json` output, exit codes, `--prompt-only` prompts, the `join('; ')` calls
   under `packages/*/lib`, and the wording of every reason.

## Acceptance Criteria

- AC1 `reasonList`: no reasons returns the heading; one reason stays on the heading line;
  two or more reasons print one per line with a two-space indent; reason text is unchanged.
  verify: `node --test packages/core/test/reason-list.test.mjs`
- AC2 `adlc accept` with no arguments exits 1; stderr line 1 is
  `error: P6 acceptance refused:`, every other line starts with two spaces and contains no
  `; `. verify: `node --test packages/runner/test/reason-lines.test.mjs`
- AC3 `gate-manifest record spec-approval` with `--data '{}'` exits 1; stderr line 1 is
  `error: spec-approval record refused:`, then one indented reason per line, no `; `
  joining them. verify: `node --test packages/gate-manifest/test/reason-lines.test.mjs`
- AC4 `spec-lint` on a spec with no criteria exits 2 and prints the three lines above;
  every stderr line has at most 120 characters.
  verify: `node --test packages/spec-lint/test/no-criteria-lines.test.mjs`
- AC5 Each test in AC2 to AC4 fails on `main` (`455524c4`) and passes on the branch.
  verify: run each test file against a checkout of `main` with the new test file copied in,
  and observe a failing assertion.
- AC6 Existing suites stay green.
  verify: `npm test`
- AC7 Every CI gate is green locally. verify: `npm run preflight` exits 0

## Out of scope

`--json` output and exit codes; `--prompt-only` prompts; the 23 `join('; ')` calls under
`packages/*/lib`; the wording of each reason; reason lines that are still longer than
120 characters (fixing them changes reason text); a readability check in `test-kit`.

## Premortem (failure causes folded in)

1. An existing test pins the old `; `-joined text exactly. Checked: existing tests use
   `assert.match` on fragments (`p2 requires --ticket`, `could not analyze — `,
   `produced zero mutants`), which still match. AC6 confirms.
2. `mutation-gate` finds changed lines in flail-detector, parallax or hollow-test with no
   test that notices a mutant. Run `npm run preflight` (AC7); add a `runBin` test for any
   surviving mutant.
3. The Cursor MCP bundle inlines core and drifts after a core export is added. Rebuild with
   `node scripts/build-cursor-mcp.mjs` if `plugins/adlc-cursor` tests report drift.
4. `packages/gate-manifest/` is an enforcement package (`packages/prosecute/lib/tier.mjs`),
   so the PR is trust-root tier and the `cross-model-gate` check stays red until a
   maintainer records a signed cross-model attestation. Say so in the PR.
5. The hollow-test closing sentence lands on the last reason line, or the single-part
   message changes. AC6 runs `packages/hollow-test/test/diff-zero-mutants.test.mjs`.
6. `console.error('\nwarnings:', x)` and `console.error('\n' + reasonList('warnings:', [x]))`
   differ. They do not: both print a blank line, then `warnings: x`.

## Approved assumptions

- One reason prints `${heading} ${reason}` on one line. flail-detector, parallax and
  hollow-test stay byte-identical; `adlc accept`, `adlc run` (operational) and the
  spec-approval refusal gain their heading in front of the single reason.
- `scripts/test/skills-catalog.test.mjs` reads `X is required` with `(?:^|;|\s)`; an
  indented line still matches because the indent is whitespace.
