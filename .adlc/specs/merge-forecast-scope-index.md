# Spec — merge-forecast: match each ticket's scope once per run

**Approval (P1):** approved by Rafael Belliard on 2026-11-07, as written at
that point (after P5 round 1). The P1 gate ran late: the build started from
his task brief before he had seen this spec. Edits after the approval (P5
rounds 2 and 3) correct wording, state the `repoFiles` and rail-coverage
limits, describe the literal `Set`, and strengthen criterion 5; none changes
the design.

**Phase:** P1 contract for a behavior-preserving speed-up of
`merge-forecast` (D2). No output changes. Single package:
`packages/merge-forecast`.

## Problem

`adlc merge-forecast --json` is the slowest deterministic gate in real use:
7.8 s wall (8.8 s user) on a 10-ticket, ~10,000-file repository, 36 s average
across real sessions, about 2.2 h in total over six weeks. A CPU profile
(`NODE_OPTIONS=--cpu-prof`) puts 77% of the time in `globMatch`
(`packages/core/lib/glob.mjs`).

`globMatch` itself is sound: it tokenises the pattern and runs an
O(tokens × path length) pass, with no backtracking. The cost is how often
merge-forecast calls it. Every signal recomputes the same expression,

```js
repoFiles.filter((f) => scope.some((g) => globMatch(g, f)))
```

for both tickets of every pair: `signalNamespaceRoutes`,
`signalMigrationCollision`, `signalGraphCoupling`, `signalCoChange` and
`importRadiusIntersects` (twice, once per direction) in
`lib/signals.mjs`, plus the zero-match validation in `lib/forecast.mjs`. Per
scored pair, each side's file set is recomputed up to 5 times: namespace
routes always; migrations unless the routes collide; import radius in the
first direction always, and in the second unless the first fires; co-change
with git history; graph coupling with graph data. A ticket in k pairs has it recomputed up to
5·k + 1 times, about 4·k in a repository with history. Each computation is
|files| × |scope| fresh `globMatch` calls, each of which re-tokenises its
pattern with a regex.

It is an algorithmic problem. No rewrite in another language is proposed.

## Design

A new module, `packages/merge-forecast/lib/scope-index.mjs`, with two
exports.

1. **`compileGlob(pattern)` → `(path) => boolean`.** Same answer as
   `globMatch(pattern, path)` for every pattern and every string path (the
   only paths merge-forecast has: `walkTree` output and resolved import
   specifiers). Tokenises once, with the same
   split `globMatch` uses (`/(\*\*\/|\*\*|\*)/`, empty parts dropped), then:
   - no wildcard token: `path === pattern`;
   - one literal followed by a single `**`, or `**` alone:
     `path.startsWith(literal)`;
   - anything else: cheap **necessary** conditions first (a leading literal
     token must prefix the path, a trailing literal token must suffix it, the
     path must be at least as long as all literal tokens together), and when
     they hold, the answer is `globMatch(pattern, path)` itself.

   The general case therefore never re-implements the matcher: core's
   `globMatch` stays the only definition of what a glob means, and the
   compiled form only skips calls whose answer is already known to be
   `false`. A non-string pattern is not compiled: its matcher calls
   `globMatch(pattern, path)` on every call, so it throws exactly where and
   when the old code threw.

2. **`createScopeIndex(repoFiles)` → index.** A per-run memo over one file
   list:
   - `index.files(scope)` returns exactly
     `repoFiles.filter((f) => scope.some((g) => globMatch(g, f)))`:
     the same elements, in the same order, duplicates kept.
   - `index.filesNormalized(scope)` returns exactly the filter
     `importRadiusIntersects` uses today, which tests the
     backslash-normalized path but keeps the original string.
   - `index.matcher(scope)` returns a predicate answering
     `(scope ?? []).some((g) => globMatch(g, path))` for a path that need not
     be in `repoFiles` (the import-radius candidates). It is built once per
     scope content, and building it never throws: like the old
     `const bScope = b.scope ?? []`, any error comes when it is called.
     `index.matches(scope, path)` is `index.matcher(scope)(path)`.
   - Results are cached by scope **content** (the JSON of a scope made only
     of strings), so equal scopes share one entry and a second call returns
     the same array. Each view is filtered once per scope content, so a scope
     is filtered over the repository at most twice per run.
   - Inside one scope, literal globs (no `*`) go into a `Set`, the others
     through `compileGlob`. For a scope of strings this cannot change the
     answer: `some()` over globs that never throw does not depend on order.
   - A scope that is not an array, or holds a non-string, is never cached
     and never reordered: it takes the shared old expression
     `(scope ?? []).some(...)`, so it throws (or does not) in the same cases
     and with the same error type as before. `scope ?? []` is kept, so a
     falsy scope that is not `null` or `undefined` still throws. The
     message names `(scope ?? [])` where each signal used to name its own
     variable (`(a.scope ?? [])`, `bScope`): V8 builds it from the source
     text. `runForecast` reaches this path only for a non-empty array that
     holds a non-string (a non-array scope is marked unscoped first), and
     there it throws or returns exactly as before. The CLI never reaches it:
     `loadTickets` rejects a scope that is not an array of strings.
   - Holes in a sparse scope are skipped, as `some()` skips them.
   - `repoFiles` is an array of strings, as `walkTree` produces. For anything
     else, a direct caller may see a different error message.
   - The index treats `repoFiles` as a snapshot. It is created by
     `runForecast` from the array it builds itself and never mutates.
     Nothing is evicted, so an index lives for one forecast run.

**Wiring.**
- `runForecast` builds one index right after `walkTree`, uses it for the
  zero-match validation, and passes it to `pairScore` as
  `opts.scopeIndex`.
- `pairScore` hands `opts.scopeIndex` to every signal. Each exported
  signal takes the index as a new **optional last parameter** and, when it
  is absent, builds a throwaway index over the `repoFiles` it was given, so
  every existing caller and test keeps working unchanged.
- `importRadiusIntersects` uses `filesNormalized` for the importing side and
  one `matcher` for the resolved candidates, built before the loop (building
  it serialises the whole scope, so doing it per candidate would make a large
  scope cost time per import).
- New exported parameters are optional. A caller that already passed an
  extra argument in that position, or `scopeIndex: null`, now gets an
  error; no caller in this repository does.

**Not covered by a rail.** That `runForecast` shares ONE index across all
pairs, rather than letting `pairScore` build one per pair, changes no output
and has no injection point, so no test can see it. It is a speed property,
measured by criterion 8 and 9, not proven by a rail. Per-pair indexes would
still compile each scope once per pair, so the cost of losing the sharing is
small: P5 measured about 200 ms more user CPU on the benchmark corpus with
per-pair indexes, and no difference on the mentimeter/adlc run.

**Out of scope.**
- `packages/core/lib/glob.mjs` is not touched. It is generated source, copied
  verbatim into six harness hooks and packages that enforce rails, so a
  change there is a trust-root change. If another package wants a compiled
  matcher later, `compileGlob` can be promoted into core as its own change
  (CONVENTIONS.md rule 2).
- The co-change `git log` mining (`coChange` in core) is measured, not
  changed.
- Re-reading the import-radius source files per pair is measured, not
  changed.

## Acceptance criteria

Each criterion names its verification.

1. **The compiled matcher answers exactly as `globMatch`.** A differential
   test drives `compileGlob(p)(x)` and `globMatch(p, x)` over every
   generated pattern × path pair from a vocabulary that covers literals,
   `*`, `**`, `**/`, `?`, `[`, `.`, `/`, a backslash, the empty string and a
   line terminator, and asserts they agree on all of them. It also asserts
   that the corpus is large (more than 100,000 pairs) and has many matches
   (more than 1,000), so it cannot pass vacuously.
   *Verify:* `node --test packages/merge-forecast/test/scope-index.test.mjs`.
2. **The scope index returns exactly the old file sets.** For many generated
   scopes over a generated file list (with backslashes, duplicates and a
   comma in it), `index.files(scope)` deep-equals the old filter
   expression, `index.filesNormalized(scope)` deep-equals the old
   import-radius filter, and `index.matcher(scope)` and `index.matches`
   answer as the old `some()`. Both views of one scope, asked of one index in
   either order, still give their own answers.
   *Verify:* `node --test packages/merge-forecast/test/scope-index.test.mjs`.
3. **The index caches by content.** A second `files` or `filesNormalized`
   call with an equal scope (same content, different array) returns the
   identical array (`===`), and `matcher` the identical function; scopes
   that differ only in where a comma falls are different entries.
   *Verify:* `node --test packages/merge-forecast/test/scope-index.test.mjs`.
4. **Odd scopes keep their old failure behavior.** For a scope that is
   `null`, `undefined`, a string, a number, `''`, `0`, `false`, `NaN`, an
   array-like object, sparse, or an array holding a non-string before or
   after a glob that matches, every method throws or returns exactly as the
   old expression `(scope ?? []).some((g) => globMatch(g, f))` does, and
   `matcher()` never throws when built.
   *Verify:* `node --test packages/merge-forecast/test/scope-index.test.mjs`.
5. **Every signal uses the index it is given.** A spy index passed to each
   exported signal, and to `pairScore`, sees the lookups the signal makes.
   For each signal a case that FIRES (score above 0) gives the same score
   with the index as without it, and graph coupling keeps the direction of a
   one-sided `fileCoupling` entry.
   *Verify:* `node --test packages/merge-forecast/test/scope-index-wiring.test.mjs`.
6. **The forecast is unchanged.** On a fixture repository built in a temp
   dir, with a git history, that triggers every signal (scope overlap,
   namespace route, migration prefix, import radius in both directions,
   co-change, graph coupling via both `fileCoupling` and `edges`, an
   unscoped ticket and a zero-match ticket), `runForecast` returns a result
   deep-equal to a golden recorded with the code **before** this change, and
   `merge-forecast --json` prints a second golden byte for byte and exits 2.
   The CLI's stdout is captured through a file. On macOS with Node 18, a
   reader that does not drain a pipe fast enough loses the tail of it (a
   `spawnSync` reader got the first ~8 KB), because the CLI calls
   `process.exit` right after `printJson`. That bug is older than this
   change; an issue for it is drafted, to be filed separately.
   *Verify:* `node --test packages/merge-forecast/test/forecast-unchanged.test.mjs`.
7. **The existing suite still passes, on Node 18 and current.** *Verify:*
   `node --test packages/merge-forecast/test/*.test.mjs`.
8. **It is much faster, offline.**
   `node packages/merge-forecast/test/bench/scope-index.bench.mjs [--files N] [--forecast <path>] [--json]`
   builds a synthetic corpus (10,000 files by default, 10 tickets, one with
   108 globs), times the old per-pair filtering (counted conservatively: 3
   file sets per pair side, the case without git history or graph data)
   against the index, checks they agree, and times `runForecast` end to end.
   `--forecast <path>` also runs another implementation's `runForecast` on
   the same corpus and requires the same result. To get `origin/main`'s:
   `git archive origin/main packages/merge-forecast | tar -x -C <dir>`, then
   `ln -s $PWD/node_modules <dir>/node_modules`.
   *Verify:* `node packages/merge-forecast/test/bench/scope-index.bench.mjs --forecast <dir>/packages/merge-forecast/lib/forecast.mjs`
   exits 0.
9. **It is much faster on real data, with byte-identical output.** The
   reference repository is a checkout of `mentimeter/adlc` at commit
   `d01b1f6c` (10 active tickets, 9,967 files), where the 7.8 s was measured.
   Any repository with an `.adlc` ticket store and a git history works the
   same way. With `origin/main`'s merge-forecast extracted to `<dir>` as in
   criterion 8, run from that repository's root
   `node <dir>/packages/merge-forecast/bin/merge-forecast.mjs --json > before.json`
   and `node <this-worktree>/packages/merge-forecast/bin/merge-forecast.mjs --json > after.json`:
   both print the same bytes and exit with the same code.
   *Verify:* `shasum before.json after.json`, and `/usr/bin/time -p` for both runs.
10. **Every gate that blocks a PR passes.** *Verify:* `npm run preflight`.
