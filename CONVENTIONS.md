# AIDLC Tool Conventions — READ BEFORE BUILDING

Every tool in `packages/` follows these rules. They are the contract that
makes 17 independently built tools feel like one product.

## Layout

```
packages/<name>/
├── package.json        # see template below
├── bin/<name>.mjs      # CLI entry — thin: parse args, call lib, exit
├── lib/*.mjs           # logic — pure functions wherever possible
├── test/*.test.mjs     # node:test — MUST pass offline (no network, no API keys)
└── README.md           # what it does, usage, exit codes, ADLC phase it serves
```

package.json template:

```json
{
  "name": "@aidlc/<name>",
  "version": "0.1.0",
  "type": "module",
  "bin": { "<name>": "./bin/<name>.mjs" },
  "scripts": { "test": "node --test test/*.test.mjs" },
  "engines": { "node": ">=18" },
  "license": "MIT"
}
```

## Hard rules

1. **Zero runtime dependencies.** Node 18+ built-ins and `@aidlc/core` only.
   Import core via relative path: `import { … } from '../../core/index.mjs'`.
2. **Core is frozen.** Never edit anything under `packages/core/`. If core
   lacks something, implement locally in your `lib/` and note the gap in
   your README under "Core gaps".
3. **Scope discipline.** Write ONLY inside your own `packages/<name>/`.
   Never touch other packages, ADLC.md, root files, or `.aidlc/`.
4. **Exit codes:** 0 = gate passes · 1 = operational error (bad input,
   missing binary, network) · 2 = gate fails. Use `pass/gateFail/opError`
   from core. CI gating depends on this.
5. **`--prompt-only` on every LLM-backed tool.** Print the exact prompt(s)
   and exit 0 — the tool must be usable with zero API keys (paste into any
   harness). Use `promptOnly()` from core.
6. **`--json` flag** on every tool: machine-readable output for
   orchestrators (in addition to default human-readable output).
7. **Tests run offline and leave no trace.** Test pure logic with fixtures;
   use `mkdtempSync` temp dirs (and init scratch git repos inside them when
   git behavior is under test); always clean up. NEVER call LLM providers
   in tests.
8. **Never mutate the user's working tree without a flag.** Tools that
   write (e.g. `--write`, `--append`) default to dry-run reporting.
   Mutation-testing tools must restore files in a `finally` block and
   refuse to run on a dirty tree.
9. **Error handling:** no silent swallowing. Operational failures →
   `opError` with a clear message. Partial data (e.g. skipped ledger
   lines) → surface in output.
10. **File size:** keep files under 400 lines; split `lib/` by concern.
11. **README is part of the tool.** Usage examples, every flag, exit code
    semantics, which ADLC phase (P0–P7 / D1–D3) it serves, and its
    relationship to sibling tools.

## Shared data (read via core, never reinvent)

- Tickets: `.aidlc/tickets.json` — `loadTickets()` from core. Schema in
  `packages/core/lib/tickets.mjs` header.
- Ledgers: `.aidlc/<name>.jsonl` — `appendEntry/readEntries`. Well-known:
  `manifest` (gate entries), `findings` (prosecution findings:
  `{ ts, tool, file, line, category, severity, desc, verdict }`).
- Foundation rails: tickets may carry `rails` paths — these are read-only
  to builders; tools that check or enforce this read them from the ticket.

## CLI shape

```
<name> [verb] [--flags]
```

Common flags where applicable: `--base <ref>` (git base, default HEAD),
`--tickets <path>` (default .aidlc/tickets.json), `--json`, `--prompt-only`,
`--n <int>` (fan width), `--tier cheap|mid|frontier`.
