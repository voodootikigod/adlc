# Request: a decomposition compiler for P2

The ADLC specifies P2 Decompose (ticket DAG + edge contracts, gated by "coldstart
per ticket + merge-forecast certifies width"), and ships every *validator* of a
ticket DAG as a package — `coldstart`, `parallax --edge`, `model-router`,
`merge-forecast`. But nothing *authors* the DAG. There is no `decompose` verb in
the CLI registry. Tickets are written one at a time by hand via
`adlc ticket create --input`, and `autopilot` is strictly one issue → one ticket →
one fleet run with no fan-out.

This leaves a hole between P1 and P4: `adlc fleet` consumes a ticket DAG that
nothing in the toolkit produces.

Build the missing piece: a compiler that takes an approved spec (or prose plan)
and emits a validated ticket DAG into the canonical `.adlc/tickets/` store,
refusing to emit one that does not pass the gates.

Prior art is `antigravity-booster`'s `agb plan` (`lib/plan.mjs`), which does this
for a different runtime. Its shape: a deterministic structural stage (schema,
cycles, duplicate ids, edge targets, declared-scope overlap forecast) that loops
its own errors back into a re-conversion, then an LLM-gate stage (coldstart and
edge-parallax run concurrently, one feedback re-conversion, re-gate), then an
advisory premortem that never vetoes, then — on success only — projection into
the ticket store, `model-router` to overwrite tier guesses, and `merge-forecast`
to annotate fan-out width.

Constraints known at request time:

- It writes the canonical ticket store, which is a gated artifact. It likely
  belongs in the trust-root tier alongside `ticket-prune` and `ticket-sync`.
- ADLC D0 says the orchestrator must never consult a model about sequencing. A
  compiler has a model propose the DAG. Whether that is a D0 violation or a
  distinction D0 fails to draw is unresolved.
- `@adlc/*` packages carry zero runtime dependencies, exit 0/1/2, support
  `--prompt-only` on every LLM-backed path, and run offline in tests.
