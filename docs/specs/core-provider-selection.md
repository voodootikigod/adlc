# Spec — Per-invocation provider selection for model-calling tools (closes #63)

**Phase:** P1 lightweight record for a small, additive core+two-package build.

## Problem

Every model-calling `@adlc` package used `packages/core/lib/llm.mjs`'s single-provider
auto-detect, with per-invocation selection available only via env overrides
(`ADLC_PROVIDER`). `consensus-fix` and `gate-fuzzing` in particular fan **N samples of
the same auto-detected provider** (`fan(opts, n)` / `fanAdversary`), which is strictly
weaker than N candidates drawn from N distinct model families for the diversity reasons
ADR-0007 documents for `adversarial-review`.

## What changed

- `packages/core/lib/llm.mjs`: `detectProvider(env, forceProvider)` gained an optional
  per-invocation override (takes precedence over `ADLC_PROVIDER`, additive only);
  `complete(opts, env)` accepts `opts.provider`; new `fanProviders(opts, providerNames, env)`
  issues one `complete()` call per named provider instead of N resamples of one; new
  `PROVIDER_NAMES` export for CLI validation.
- `packages/consensus-fix`: `bin/consensus-fix.mjs` gained `--provider <name>` and
  `--providers <a,b,c>` (mutually exclusive); `lib/runner.mjs`'s `runConsensusFix` accepts
  `providerNames` and, when set, draws one candidate per named provider (fan width =
  `providerNames.length`, overriding `--n`) instead of N samples of one provider.
- `packages/gate-fuzzing`: `bin/gate-fuzzing.mjs` gained the same `--provider`/`--providers`
  flags; `lib/fan.mjs`'s `fanAdversary` accepts `provider` (force one provider for all
  resamples) and `providerNames` (one mutation-strategy instance per distinct provider).

Single-provider auto-detect remains the default in all three packages — this is additive
only, not a default-behavior change (ADR-0007's cost/latency default is untouched).

## Acceptance criteria

- **AC1** — `detectProvider(env, 'openai')` selects `openai` even when `ADLC_PROVIDER`/env
  order would otherwise pick a different provider; an unavailable or unknown override
  name returns `null` (fails closed), never throws or silently falls back.
- **AC2** — `fanProviders(opts, ['anthropic','openai','gemini'])` issues exactly one
  completion per named provider (never resamples one), and a provider missing its API key
  surfaces as a per-entry `{ ok: false }` result without aborting the others.
- **AC3** — `consensus-fix --providers a,b,c` draws one candidate per named provider
  (fan width = 3, `--n` ignored) and each survivor records which provider produced it;
  `--provider`/`--providers` are mutually exclusive and validated against known provider
  names before any LLM call; a missing API key for a requested provider fails closed with
  a clear operational error (exit 1), not a network attempt.
- **AC4** — `gate-fuzzing --providers a,b` fans mutation-strategy instances across the
  named providers (fan width = number of providers, `--n` ignored for width purposes);
  same validation/fail-closed behavior as AC3.
- **AC5** — Omitting `--provider`/`--providers` entirely is behavior-identical to before
  this change (single auto-detected provider, `--n` resamples) — verified by the existing
  test suites for all three packages passing unchanged.

## Verification commands

```bash
node --test packages/core/test/core.test.mjs
node --test packages/consensus-fix/test/runner.test.mjs packages/consensus-fix/test/bin.test.mjs
node --test packages/gate-fuzzing/test/fan.test.mjs packages/gate-fuzzing/test/bin.test.mjs

# full regression sweep for the three touched packages
node --test packages/core/test/*.test.mjs packages/consensus-fix/test/*.test.mjs packages/gate-fuzzing/test/*.test.mjs
```

All of the above pass with zero real API keys configured — provider-selection and
fan-across-providers behavior is exercised with an injected/mocked `completeFn`/`fetch`,
and the fail-closed paths are exercised by deliberately clearing provider API keys.
