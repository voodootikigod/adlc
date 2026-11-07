# Spec — merge-forecast: match each ticket's scope once per run

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
`lib/signals.mjs`, plus the zero-match validation in `lib/forecast.mjs`. A
ticket in k pairs has its file set recomputed about 10·k times, and each
computation is |files| × |scope| fresh `globMatch` calls, each of which
re-tokenises its pattern with a regex.

It is an algorithmic problem. No rewrite in another language is proposed.

## Design

A new module, `packages/merge-forecast/lib/scope-index.mjs`, with two
exports.

1. **`compileGlob(pattern)` → `(path) => boolean`.** Same answer as
   `globMatch(pattern, path)` for every input. Tokenises once, with the same
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
   - `index.matches(scope, path)` answers
     `scope.some((g) => globMatch(g, path))` for a path that need not be in
     `repoFiles` (the import-radius candidates).
   - Results are cached by scope **content** (the JSON of a scope made only
     of strings), so equal scopes share one entry and a second call returns
     the same array.
   - A scope that is not an array, or holds a non-string, is never cached
     and never reordered: it takes the old expression verbatim, so it throws
     (or does not) exactly as before. `scope ?? []` is kept.
   - The index treats `repoFiles` as a snapshot. It is created by
     `runForecast` from the array it builds itself and never mutates.

**Wiring.**
- `runForecast` builds one index right after `walkTree`, uses it for the
  zero-match validation, and passes it to `pairScore` as
  `opts.scopeIndex`.
- `pairScore` hands `opts.scopeIndex` to every signal. Each exported
  signal takes the index as a new **optional last parameter** and, when it
  is absent, builds a throwaway index over the `repoFiles` it was given, so
  every existing caller and test keeps working unchanged.
- `importRadiusIntersects` uses `filesNormalized` for the importing side and
  `matches` for the resolved candidates.

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
   scopes over a generated file list (with backslashes and duplicates in it),
   `index.files(scope)` deep-equals the old filter expression and
   `index.filesNormalized(scope)` deep-equals the old import-radius filter.
   *Verify:* `node --test packages/merge-forecast/test/scope-index.test.mjs`.
3. **The index caches by content.** A second `files` call with an equal scope
   (same content, different array) returns the identical array (`===`).
   *Verify:* `node --test packages/merge-forecast/test/scope-index.test.mjs`.
4. **Odd scopes keep their old failure behavior.** A non-array scope, and a
   scope holding a non-string after a glob that does or does not match,
   throws or returns exactly as the old expression does.
   *Verify:* `node --test packages/merge-forecast/test/scope-index.test.mjs`.
5. **The forecast is unchanged.** On a fixture repository built in a temp
   dir, with a git history, that triggers every signal (scope overlap,
   namespace route, migration prefix, import radius, co-change, graph
   coupling via both `fileCoupling` and `edges`, an unscoped ticket and a
   zero-match ticket), `runForecast` returns a result deep-equal to a golden
   JSON recorded with the code **before** this change.
   *Verify:* `node --test packages/merge-forecast/test/forecast-unchanged.test.mjs`.
6. **The existing suite still passes.** *Verify:*
   `node --test packages/merge-forecast/test/*.test.mjs`.
7. **It is much faster, offline.** `node packages/merge-forecast/bench/scope-index.bench.mjs`
   builds a synthetic corpus (10,000 files, 10 tickets, one with 108 globs),
   times the old per-pair filtering against the index, checks they agree,
   and times `runForecast` end to end.
   *Verify:* run it on this branch and on `origin/main`.
8. **It is much faster on real data, with byte-identical output.** The
   reference repository is a checkout of `mentimeter/adlc` at commit
   `d01b1f6c` (10 active tickets, 9,967 files), where the 7.8 s was measured.
   Any repository with an `.adlc` ticket store and a git history works the
   same way. From its root, run
   `node <this-worktree>/packages/merge-forecast/bin/merge-forecast.mjs --json`
   with the `origin/main` code and with this branch's code: both print the
   same bytes and exit with the same code.
   *Verify:* `shasum` of both outputs, `/usr/bin/time -p` for both runs.
9. **Every gate that blocks a PR passes.** *Verify:* `npm run preflight`.
