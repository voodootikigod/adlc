# @adlc/core — FROZEN CONTRACT

Shared library for all ADLC tools. **This package is frozen during tool
builds (rails).** Tools import from it; tools never modify it. If the API is
insufficient for your tool, work around it inside your own package and note
the gap in your README — do not edit core.

Import surface (from a tool at `packages/<name>/`):

```js
import { complete, fan, extractJson, detectProvider, resolveModel } from '../../core/index.mjs';
import { git, gitDiff, changedFiles, isDirty, isGitRepo, coChange, pairKey, churn } from '../../core/index.mjs';
import { parseArgs, pass, gateFail, opError, printJson, readStdin, promptOnly } from '../../core/index.mjs';
import { ADLC_DIR, appendEntry, readEntries, ledgerPath, sha256, hashFiles } from '../../core/index.mjs';
import { TICKETS_PATH, loadTickets, validateTicket, topoSort, computeFloat, globMatch, inScope, scopesOverlap } from '../../core/index.mjs';
import { mutate } from '../../core/index.mjs'; // mutate.generateMutants / applyMutant / changedLinesFromDiff / OPERATORS
```

## llm

- `detectProvider(env?)` → `{ name, apiKey, models } | null`. Order: anthropic, openai, gemini. Force with `ADLC_PROVIDER`.
- `resolveModel(provider, { tier, model }, env?)` → model id. Tiers: `cheap | mid | frontier`. Override via `ADLC_MODEL_CHEAP/MID/FRONTIER`.
- `complete({ tier, model, system, prompt, maxTokens })` → `Promise<string>`. Throws if no provider (tools must catch and offer `--prompt-only`).
- `fan(opts, n)` → `Promise<[{ ok, value | error }]>` — n independent stateless completions.
- `extractJson(text)` → parsed JSON value from messy model output. Throws if none.

## git

- `git(args[], opts?)` → stdout string (execFileSync; throws on non-zero).
- `isGitRepo(cwd?)`, `gitDiff(base?, cwd?)`, `changedFiles(base?, cwd?)`, `isDirty(cwd?)`.
- `coChange(limit?, cwd?)` → `{ pairCounts: {'a b': n}, fileCounts }` (logical coupling; commits touching >50 files skipped). Pair keys via `pairKey(a, b)` (sorted).
- `churn(limit?, cwd?)` → `{ file: commitCount }`.

## cli

- `parseArgs(config)` — node:util parseArgs with `allowPositionals: true` default.
- `pass(msg?)` exit 0 · `gateFail(msg, details?)` exit 2 · `opError(msg)` exit 1.
- `printJson(obj)`, `readStdin()`, `promptOnly(promptOrArray)` (print prompt(s), exit 0).

**Exit codes are the contract: 0 = gate passes, 1 = operational error, 2 = gate fails.**

## ledger (persistence at `.adlc/`)

- `appendEntry(name, entry, dir?)` → appends to `.adlc/<name>.jsonl`.
- `readEntries(name, dir?)` → `{ entries, skipped }` — malformed lines reported, never swallowed.
- `sha256(content)`, `hashFiles(paths)` → `{ path: hash | null }`.

Well-known ledger names: `manifest` (gate-manifest entries), `findings`
(prosecution findings: `{ ts, tool, file, line, category, severity, desc, verdict }`).

## tickets (`.adlc/tickets.json`)

Schema (see lib/tickets.mjs header): `{ id, title, body, scope[], rails[], edges[{to, contract}], duration, category, budget }`.

- `loadTickets(path?)` → `{ tickets, errors }` (validates ids, duplicate ids, unknown edges).
- `validateTicket(t)` → `errors[]`.
- `topoSort(tickets)` → `{ order, cycle | null }`. Edges mean "completes before edge.to".
- `computeFloat(tickets)` → `{ floats: {id: n}, criticalPath: [ids], makespan }` (CPM; duration default 1) or `{ error }` on cycle.
- `globMatch(pattern, path)` (`*`, `**`), `inScope(ticket, path)`, `scopesOverlap(a, b)` (conservative).

## mutate

- `mutate.OPERATORS` — invert-comparison, bool-flip, null-return, off-by-one, logic-swap.
- `mutate.generateMutants(content, { targetLines?, maxMutants? })` → `[{ line, operator, original, mutated }]` (skips comments/imports/console lines).
- `mutate.applyMutant(content, mutant)` → mutated content (throws if line content drifted).
- `mutate.changedLinesFromDiff(diffText)` → `{ file: Set<newSideLineNo> }`.
