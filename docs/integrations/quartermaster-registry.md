# `quartermaster.json` — the operator-local channel registry

> Schema reference and annotated example for the registry defined by
> [`docs/specs/operating-stack.md`](../specs/operating-stack.md) §4b.
> **This document is reference material. Dispatch never reads it** — the repo
> carries no registry, and a registry-shaped file found in a candidate tree is
> ignored with a notice (§4, §10).

Implemented by [`@adlc/quartermaster`](../../packages/quartermaster); consumed by
`@adlc/fleet` (`packages/fleet/lib/quartermaster.mjs`).

## Where the file lives

| Situation | Path used |
| --- | --- |
| `ADLC_QUARTERMASTER_REGISTRY` set to an absolute path outside the repo | that path |
| Not set | `$XDG_CONFIG_HOME/adlc/quartermaster.json`, else `~/.config/adlc/quartermaster.json` |
| Set to a **relative** path | loading **DISABLED** (loud notice), dispatch fails closed |
| Set to a path **inside the repo under review** | loading **DISABLED** (loud notice), dispatch fails closed |

Containment is decided on **real** paths (symlinks resolved), so a `/tmp` →
`/private/tmp` style link cannot make an in-repo path look external.

This mirrors how the `adversarial-review` CLI treats `ADVERSARIAL_REVIEW_CONFIG`:
a misconfigured path disables the feature rather than loading something the repo
under review could have written.

### Engagement

Fleet dispatch takes its `{adapter, model, transport}` from the registry when the
operator has one — `ADLC_QUARTERMASTER_REGISTRY` is set, **or** the default
home/XDG file exists. With neither, fleet keeps its pre-quartermaster behavior
(`--adapter` plus `--model`). Both signals are operator-local; a repo-committed
config can set neither, so this is not a repo-reachable downgrade.

> **Breaking change.** `fleet.model` in `.adlc/config.json` is now **ignored with a
> warning**, exactly like `fleet.adapter`. It was previously honoured as
> "non-executable data" — which was only safe by accident, because the
> `claude-code`, `codex`, and `opencode` adapters silently dropped it. Now that
> every adapter forces its model onto the command line, a repo-committed value
> would be a candidate tree choosing the model that builds and judges it. Use the
> operator-local `--model` flag instead.

Once engaged, every fail-closed rule applies: a disabled path, an absent file,
malformed JSON, or any validation failure aborts **before** dispatch. There are
no default channels.

## Threat model

The registry defends against the candidate tree **declaring** its own supply: a
repo cannot name its reviewer, repoint `frontier` at something cheap, or hint at
a channel, because there is no repo-side knob and an in-repo registry file is
ignored with a notice.

Since [#395](https://github.com/voodootikigod/adlc/issues/395) it is also defended
against candidate-authored code **executing** as the operator, which is the other
half of the problem and used to be an open one. The repo's own `fleet.gate`
commands are added to the worker's permission allowlist and the builder charter
tells the worker to run them, so a gate command is ordinary candidate code — and
it used to run with the operator's filesystem privileges, able to rewrite this
file with a schema-valid document that redirected the next run's supply.

Two changes close that path (spec [§7.3](../specs/fleet-orchestration.md)):

- **The model plane is filesystem-sandboxed.** Network egress stays open — the
  worker must reach its provider — but its **writes** are bounded to the ticket's
  worktree plus the specific state directories the configured harness declares.
  This file is not among them, and neither is `~/.claude/settings.json`, nor any
  other operator-writable state.
- **The worker is not told where this file is.** `ADLC_QUARTERMASTER_REGISTRY`,
  and every other ambient `ADLC_*` variable, is withheld from the model-plane
  environment. Dispatch resolves the seat before the worker starts, so the worker
  never needed the path.

### What is still open

- **Reads are not bounded on the model plane.** The worker can read what the
  operator can read, and it has network egress, so a *read*-and-exfiltrate path
  remains. Bounding reads means enumerating where each harness keeps auth on each
  platform — a macOS Keychain item is not even a file — and is deliberately not
  attempted here. Running a fleet over a repo you do not trust is still outside
  the design's assumptions.
- **The write grant is a per-harness allow-list.** It is fail-closed (an
  unlisted path is denied, so an omission surfaces as a harness erroring, never
  as a silent hole), but a harness whose layout changes may need
  `--model-plane-writable <path>` until its adapter declaration catches up.
- **Resume re-plans from this file.** `runLive` rebinds remaining tickets to the
  registry as it is at resume time. That is defensible on its own — an operator
  who fixed a broken registry expects the fix to apply — and with the write path
  closed it is no longer a hazard. Hardening it further (recording
  `registryDigest` and requiring acknowledgement on a changed digest) is
  attestation-schema-v2 work, spec §9 item 4.

## `transport` selects the credential — with an asymmetric guarantee

`transport` constrains **validation** (rule 3's distinct fallback transports,
rule 4's closed taxonomy, §6's gateway family-collapse), is **reported** in the
dry-run plan and the §8a spend carrier, and **selects the credential context the
worker is dispatched with**.

Each adapter declares which transport CLASSES it can serve — the prefix, not the
full string, since the suffix names *your* account. A seat bound to a class its
adapter does not declare is **rejected at load** (rule 2), because such a seat
would run on whatever ambient auth the host carries while every record claimed
the declared transport.

| class | what dispatch does |
| --- | --- |
| `subscription:` | **every provider API key is withheld** from the worker, so the harness has no metered path available and must use its own session |
| `api:` | the adapter's declared credential variable is supplied |
| `gateway:` | only the adapter's declared gateway credential is supplied; the **endpoint lives in the harness's own provider config**, never in this file |

### The guarantee is asymmetric — read this before trusting a label

**Withholding a credential is provable.** A `subscription:` seat that never
receives a provider key *cannot* have been metered: absence is a fact about the
worker's environment, not a claim about harness behaviour. This is the direction
that protects a subscriptions-first operator from paying metered rates for
capacity they already bought.

**Supplying one is not.** A harness handed an API key may still prefer a stored
session, so an `api:` seat's label describes what was *offered*, never what
served the call.

Accordingly, a recorded dispatch carries `transportStatus: "selected"` — this
credential context was chosen for the call. `"attested"` is reserved for the
*attest* half (the harness reporting which transport actually served it), which
is **not built yet** and is tracked in
[#396](https://github.com/voodootikigod/adlc/issues/396). Until it exists, treat
an `api:` or `gateway:` label as intent plus a credential grant, and only a
`subscription:` label as a guarantee — of the negative kind.

This mirrors §4c's split for `model` (force it onto the command line, attest what
resolved) and T152's `usageStatus` for token counters, which exists because shape
validation cannot prove a provider reported anything.

### Scope: reviewer-group members are validated, not dispatched

The serving rule above applies to reviewer-group members at **load** — §6's quorum
discounting reads the transport prefix, so a member bound to a class its adapter
cannot serve is rejected exactly like a channel seat.

It does **not** extend to review *execution*. Fleet never dispatches a reviewer
member through an adapter: cross-model prosecution spawns the `adversarial-review`
binary once, and that tool selects its own provider. So a reviewer member's
transport constrains validation and quorum accounting, not the credentials the
review subprocess runs with. Tightening that subprocess's environment is a
property of the prosecution path rather than of seat dispatch, and is tracked in
[#446](https://github.com/voodootikigod/adlc/issues/446).

### Local and open-weights providers

A local model server is *mediated* in §4b's sense, so it is expressed as
`gateway:<name>` — e.g. `gateway:ollama-local` — with **no schema change**. The
endpoint and credential live in the harness's own provider configuration; this
file only names the transport.

One consequence is intended: §6 collapses every member sharing a `gateway:*`
transport into a single family for quorum, so a local seat can never count as an
independent cross-model reviewer. Build channels are unaffected (§6 only governs
reviewer groups), and for a trust-root review that conservatism is correct.

## Annotated example

```jsonc
{
  // Only version 3 is understood. A newer file fails closed rather than being
  // read with unknown semantics.
  "version": 3,

  // Exactly these four channel names, no more and no fewer. Adding a channel is
  // a spec revision (§4a), not a config edit — so a registry can never invent a
  // route the routing contract (§5) never sanctioned.
  "channels": {
    // CONCRETE model IDs, not `default`. §4c round-11: an alias may only be bound
    // to an adapter that attests what actually ran, and none do yet (spec §9.3) —
    // so an alias channel is rejected at load. See "Why not `default`?" below.
    "frontier":         { "adapter": "claude-code", "model": "claude-opus-5",     "transport": "subscription:anthropic-max", "provider": "anthropic" },

    // `frontier-metered` is the fallback for `frontier`. Its transport MUST
    // differ — the fallback edge exists only to change transport (rule 3).
    "frontier-metered": { "adapter": "claude-code", "model": "claude-opus-5",     "transport": "api:anthropic-batch",        "provider": "anthropic" },

    // `rateWindow` is optional and observed-only (spec §11 q2): a coarse hint
    // about the gateway's quota window, never a pre-flight probe.
    "mid":              { "adapter": "opencode",    "model": "opencode-go/glm-5.2",          "transport": "gateway:opencode-go",        "provider": "zai",      "rateWindow": "5h" },
    "cheap":            { "adapter": "opencode",    "model": "opencode-go/deepseek-v4-flash","transport": "gateway:opencode-go",        "provider": "deepseek", "rateWindow": "5h" }
  },

  // Reviewer groups (§6). Members carry CONCRETE model IDs — never an alias.
  "reviewerGroups": {
    "cross-model-routine": {
      "quorum": 1,
      "members": [
        { "adapter": "opencode", "model": "opencode-go/qwen3.7-plus", "transport": "gateway:opencode-go", "provider": "alibaba" }
      ]
    },
    "cross-model-trust-root": {
      // Quorum >= 2, and because every member behind one gateway counts as ONE
      // family, at least one member must be on subscription:*/api:* and mark
      // itself `directAuth`.
      "quorum": 2,
      "members": [
        { "adapter": "opencode", "model": "opencode-go/kimi-k3",    "transport": "gateway:opencode-go",       "provider": "moonshot" },
        { "adapter": "codex",    "model": "gpt-5.3-codex",    "transport": "subscription:chatgpt-plus", "provider": "openai", "directAuth": true }
      ]
    }
  },

  // (adapter, concrete model) → normalized provider. Phase-2 author binding
  // resolves an ATTESTED concrete model through this table ONLY (rule 7).
  "modelProviders": {
    "claude-code": { "claude-opus-5": "anthropic", "claude-sonnet-5": "anthropic", "claude-haiku-4-5": "anthropic" },
    "codex":       { "gpt-5.3-codex": "openai" },
    "opencode":    { "opencode-go/glm-5.2": "zai", "opencode-go/deepseek-v4-flash": "deepseek", "opencode-go/qwen3.7-plus": "alibaba", "opencode-go/kimi-k3": "moonshot" }
  }
}
```

> The example is annotated with `//` comments for readability. The real file is
> strict JSON — comments are a parse error.

## Field reference

### Channel entry

| Field | Required | Notes |
| --- | --- | --- |
| `adapter` | yes | Must name a module in `packages/fleet/lib/adapters/` |
| `model` | yes | Concrete model ID, or an alias the adapter declares (see rule 7) |
| `transport` | yes | `subscription:*`, `api:*`, or `gateway:*` — closed taxonomy |
| `provider` | yes | Normalized provider string |
| `rateWindow` | no | `"5h"`-shaped: a positive count of `m`/`h`/`d` |

### Reviewer-group member

Same as a channel entry, minus `rateWindow`, plus:

| Field | Required | Notes |
| --- | --- | --- |
| `directAuth` | on non-gateway members | `true` exactly when the transport is `subscription:*`/`api:*`. A gateway member claiming it is rejected. |

There is **no** `command`, `args`, `argv`, `exec`, `bin`, `flags`, `env`, or any
other argv-shaped field anywhere in this schema, at any depth. Execution shape
lives in the adapter modules; the registry is data.

## Validation rules (all enforced at load, all fail closed)

| Rule | What it rejects |
| --- | --- |
| 1 — closed channel names | An unknown channel/group name, or a missing one. Unknown keys are errors, not extensions. |
| 2 — adapter allowlist | An `adapter` with no module in `packages/fleet/lib/adapters/`; any command/argv-shaped key anywhere. |
| 6 (§4c) — an alias needs an attesting adapter | A channel binding a run-time alias (including `default`) to an adapter that does not report `resolvedModel`. No adapter attests yet (spec §9.3), so **every alias channel is currently rejected** — use concrete model IDs. |
| 2 (§4c) — the adapter must force its model | A seat naming a model on an adapter that cannot pass an explicit model to its harness. It would run the harness default while the plan, the usage records, and any attestation claimed the registry's model. Adapters that do not declare `forcesModel` are treated as unable to force it. `model: "default"` is exempt — asking for the ambient default is honest. |
| 3 — distinct fallback transports | `frontier` and `frontier-metered` sharing a `transport` — the fallback would be unsatisfiable by construction. |
| 4 — closed transport taxonomy | Any transport whose prefix is not exactly `subscription:`, `api:`, or `gateway:` (e.g. `proxy:shared`, or a bare `opencode-go`). The prefix is load-bearing for §6 gateway discounting, so an unrecognized one is rejected rather than treated as non-gateway. Also covers the `directAuth` requirement on non-gateway members. |
| 5 — fail closed | Missing registry, disabled path, missing required field, wrong schema version, unsatisfiable quorum. No defaults, ever. |
| 6 — no mutable aliases for reviewer members | A member `model` matching **any** alias its adapter declares — not merely the literal `"default"`. Reviewer identity must be a concrete model ID. |
| 7 — concrete-model provider mapping | A `modelProviders` value that is not a normalized provider string; an entry for an unknown adapter; a **concrete seat model absent from the table**, or **mapped to a provider that contradicts the seat's own `provider`** (worse than missing — binding would resolve the author into the wrong family and could admit a same-family reviewer §6 excludes); an **alias-based build channel whose adapter maps no models**. |
| §6 — quorum counts families, not seats | A group whose members cannot supply its `quorum` in *independent* families. Members sharing one `gateway:*` transport collapse to a single family, and direct members on the same provider are one family, so e.g. quorum 3 over two shared-gateway seats plus one direct seat is unsatisfiable by construction. |

Every violation is reported at once — fixing one does not merely reveal the next.

### What rule 7 does NOT check

Concrete models are fully checked — present in the table, and agreeing with the
seat's declared provider. **Aliases are not**, and cannot be: a harness alias like
`claude-code`'s `default` tracks whatever "latest" means today, so its resolution
set is not enumerable at load time. For an alias, rule 7 verifies only that the
adapter has **some** mapping; the spec's own reference registry relies on the
operator listing the models they expect.

So for aliases the load-time check catches the total omission, not a partial one. The backstop
for a partial table is phase-2 author binding failing closed on an unmapped
attested model — by design, *after* the work is spent. If you want that failure
moved earlier, use concrete model IDs instead of an alias, which is exactly what
§4b rule 7 recommends for channels whose alias resolutions are not enumerable.

### Normalized provider strings

A provider value must already be in the normal form the attestation verifier
compares in: NFKC-folded, all whitespace stripped, lower-case. `"openai"` is
valid; `"OpenAI"`, `"open ai"`, and `"anthropic "` are rejected rather than
silently folded, so the operator sees the typo.

The authority is `normalizeProvider` in `packages/prosecute/lib/cross-model.mjs`;
`packages/quartermaster/test/provider-normalization.test.mjs` pins the two
implementations together so they cannot drift.

### Why not `default`?

`model: "default"` means "let the harness resolve it" — but *the harness resolves
it from state the candidate can influence*. Claude Code, for one, reads a
project-committed `.claude/settings.json` `model` field when no `--model` is
passed, so a repo could choose the model behind a channel the operator believes
they selected, and nothing downstream would look wrong.

§4c round-11 closes this: an alias may only be bound to an adapter that attests
the concrete model it actually ran. Since no adapter attests yet (spec §9.3),
**every alias-based channel is rejected at load**, and the spec's stated
alternative applies — use a concrete model ID. The reference registry above does.

When §9.3 lands and adapters surface `resolvedModel`, alias channels become
available again for attesting adapters, and rule 7's alias-coverage requirement
starts doing real work.

### Model IDs are the HARNESS's names, not the vendor's

A `model` must be spelled exactly as the harness spells it, because §4c forces it
onto the command line verbatim. For a gateway transport that means the
**gateway's** namespace, which is usually *not* the upstream vendor's name.

OpenCode Go namespaces every model it brokers under `opencode-go/`:

| Upstream family | What you might write | What the harness accepts |
| --- | --- | --- |
| Z.ai GLM | ~~`zai/glm-5.2`~~ | `opencode-go/glm-5.2` |
| DeepSeek | ~~`deepseek/v4-flash`~~ | `opencode-go/deepseek-v4-flash` |
| Moonshot Kimi | ~~`moonshot/kimi-k3`~~ | `opencode-go/kimi-k3` |
| Alibaba Qwen | ~~`qwen/qwen3.7-coder`~~ | `opencode-go/qwen3.7-plus` |

A vendor-style ID validates fine at load — nothing here can know which strings a
remote gateway accepts — and then fails at dispatch. List the real ones with:

```sh
opencode models
```

Note also that OpenCode Go and OpenCode Zen are **separate** products with
separate credentials, billing, and namespaces (`opencode-go/*` vs `opencode/*`).
A model ID from one is not valid on the other, and an empty balance on one does
not affect the other.

### `provider` is an operator assertion, and a gateway cannot confirm it

Because the gateway flattens everything into its own namespace,
`opencode-go/glm-5.2` does not reveal that the upstream family is Z.ai. So the
`provider` field — and the `modelProviders` mapping — are things **you** assert;
nothing validates them against the gateway.

This is not a gap so much as the reason §6 exists in the shape it does: all
members sharing a `gateway:*` transport collapse to a single family for quorum,
*precisely* because a mediated channel cannot prove the diversity it declares.
Keep the vendor family in `provider` (it is the honest intent, and phase-2
author binding needs it), but do not read a passing load as confirmation that
the gateway agrees.

### The alias contract is adapter-owned

Each adapter module exports the alias set its harness resolves at run time:

| Adapter | Declared aliases | Model flag | `forcesModel` | `attestsResolvedModel` |
| --- | --- | --- | --- | --- |
| `claude-code` | `default`, `fable`, `opus`, `sonnet`, `haiku`, `opusplan` | `--model` | yes | **no** (§9.3) |
| `codex` | `default` | `-m` | yes | **no** (§9.3) |
| `opencode` | `default` | `-m` | yes | **no** (§9.3) |
| `agy` | `default` | `--model` | yes | **no** (§9.3) |
| `pi`, `cursor`, `copilot` | `default` | — | **no** | **no** |

Because nothing attests yet, `pi`, `cursor`, and `copilot` can serve no channel
at all today: a concrete model is refused (they cannot force it) and an alias is
refused (they cannot attest it). That is the fail-closed intersection, not an
oversight.

An adapter with `forcesModel: false` may only be bound to a seat whose model is
the `default` sentinel; naming a model on it is rejected (see the rule table).

`claude --help` documents `--model` as taking "an alias for the latest model
(e.g. 'fable', 'opus', or 'sonnet') or a model's full name", so that alias set is
open-ended by construction and the declared list is deliberately over-inclusive:
listing a name that turns out to be concrete only costs a reviewer seat an
explicit model ID, while a mutable alias missing from the list would let reviewer
identity drift under the attestation.

`default` is the registry's own sentinel meaning "let the harness resolve" — it
is the one value **not** forced onto the command line.

## Checking a registry

`fleet run --dry-run` prints the resolved plan without dispatching anything:

```
  quartermaster registry: /Users/you/.config/adlc/quartermaster.json
  T900     job=build.critical-path channel=frontier adapter=opencode model=operator/frontier-model transport=subscription:anthropic-max
           argv: opencode ["run","-m","operator/frontier-model","<prompt>"]
```

The argv is produced by the adapter's own `dispatch` under a capture-only exec,
so the dry-run cannot claim one command line while the live run uses another.
Notices (an ignored in-repo file, a disabled path) go to stderr.

`--dry-run --json` carries the same information under a `quartermaster` key
(`engaged`, `registryPath`, and a `seats` array with each ticket's job, channel,
adapter, model, transport, provider, and rendered argv) alongside the scheduler
plan. It runs the identical validation path, so a disabled or invalid registry
exits non-zero and emits **no** success document — automation using the JSON
format as a pre-dispatch check is never told a run is fine when the live run
would fail closed.

## Related

- Spec: [`docs/specs/operating-stack.md`](../specs/operating-stack.md) §4–§6, §12
- Routing contract: §5 (`routeJob` — build classes are derived, never trusted from the caller's label)
- Harness details: [`claude-code.md`](./claude-code.md), [`codex.md`](./codex.md), [`opencode.md`](./opencode.md)
