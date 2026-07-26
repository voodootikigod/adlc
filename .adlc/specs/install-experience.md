# Spec — Install experience: skills.sh distribution, one-command install, CTA placement

**Phase:** P1 contract for the three install-experience workstreams (I1–I3).
Time-to-first-gate is the metric this spec optimizes. Every decision below is
binding for the tickets that implement it.

**Tickets:** I1 (skills.sh catalog) is independent. I2 (universal installer) →
I3 (marketing CTA), because the marketing pages render the install command I2
defines; I3 MUST NOT publish a `curl | sh` string the installer does not yet
serve. I2 → I4 (agent-led onboarding) for the same reason, and I1 → I4 because
the guide describes the skills.sh channel.

## P1 review boundary

This file is the **P1 contract**. Approval ships the contract, not the I1–I4
implementations, so at P1 the artifacts described below may not exist in the
working tree yet.

That context is offered to a reviewer as information, **not as a constraint on
what a review may report**. An earlier draft stated that a missing
`install.sh` or `skills/` directory was "not a P1 no-ship reason" — a
cross-model review of PR #351 flagged that as repository text instructing
adversarial reviewers what cannot block approval, and it was right. Nothing in
this file limits what a reviewer may raise.

**Relates to:** [ADR-0009](../../docs/adr/0009-universal-install-via-plugins.md)
governs the `npx plugins add` recommendation. This spec does not overturn it;
I2 introduces a first-party installer that *calls* the same native paths, and
ADR-0010 records that decision separately.

## Problem

Three distinct frictions, all upstream of adoption:

1. **skills.sh invisibility.** `skills.sh` (`vercel-labs/skills`,
   `npx skills add <owner>/<repo>`) reaches ~70 harnesses and has **no
   submission process** — its FAQ states skills appear on the leaderboard
   automatically via anonymous telemetry when users run `npx skills add`.
   Listing is therefore install-driven, and the ADLC repo is unreachable:
   the CLI discovers `skills/<name>/SKILL.md`, `skills/<category>/<name>/SKILL.md`,
   `.claude/skills/`, and `.agents/skills/`, while all 24 ADLC `SKILL.md` files
   live under `plugins/adlc-<harness>/skills/`, which is not a discovered
   container. `npx skills add voodootikigod/adlc` finds nothing today.
2. **No single install command.** Adoption today is at minimum
   `npx plugins add voodootikigod/adlc` + `npm i -g @adlc/cli` + a per-repo
   init, and the `plugins` installer only reliably covers Claude Code. The other
   six harnesses each have a divergent native path, documented across six pages.
   There is no Windows story at all.
3. **Install CTA is buried.** `IntegrationDetailPage` orders its sections
   hero → surfaces → phase routing → rails → **install (last)**. The hero's
   right column renders a decorative file tree (`NativeBundle`). The
   `/integrations` index and the marketing homepage carry no install command at
   all — only a link.

## Goal

After I1–I3:

1. `npx skills add voodootikigod/adlc` installs a harness-neutral ADLC skill set
   into any of the ~70 harnesses the skills CLI supports, and that content
   cannot silently drift from the shipped per-harness plugin skills.
2. A single first-party command installs the gate toolkit and every harness
   integration present on the machine, on macOS, Linux, and (beta) Windows.
3. The install command is the first actionable thing a visitor sees on the
   homepage, the `/integrations` index, and every integration detail page.
4. A visitor already running a coding agent can paste one prompt and have the
   agent read a served guide and drive the whole install itself.

## Binding decisions (all tickets)

1. **The skills.sh channel is an on-ramp, not the recommended install.** A
   skills.sh install delivers **skills only** — no hooks, no MCP tools, no
   agents, no rails enforcement. Every surface that mentions it MUST say so.
   ADR-0009 Decision 4 (claim accuracy) applies unchanged: we document only the
   coverage a channel actually has.
2. **Top-level `skills/` is harness-neutral.** Its skills MUST NOT reference
   harness-specific invocation syntax (`/adlc:*`, `$adlc-*`, `/adlc-*`). They
   depend only on `adlc <tool>` being on PATH. The per-harness plugin skills
   under `plugins/*/skills/` remain the canonical experience for their harness.

   **Known divergence, deliberately deferred.** The repo already has a canonical
   phase-router generator (`scripts/router/router-model.mjs` →
   `gen-routers.mjs`, gated by the `router-drift` CI job) that renders all six
   harness routers from one source. `skills/adlc/SKILL.md` is hand-written and
   bypasses it, so it is guarded by the weaker bespoke check in
   `scripts/test/skills-catalog.test.mjs` instead of the real mechanism. A
   cross-model review flagged this and is right. It is not fixed here because
   adding a seventh target means the shared sections — which currently carry
   Claude-specific text that four harnesses override locally — need
   parameterising, and getting that wrong breaks the drift gate for six shipped
   routers. Tracked separately; recorded here so the divergence is visible
   rather than discovered.
3. **Drift between `skills/` and `plugins/*/skills/` is caught at the level the
   test actually checks — and no further.** The committed test verifies two
   things: that every canonical gate the Claude Code router routes to is also
   routed by the neutral router, and that every `adlc <tool>` invocation in the
   catalog names a real registry tool with its required flags. It does **not**
   compare semantics — changed ordering, safety caveats, or exit-code prose can
   drift without failing, and `adlc-init`/`adlc-prosecute` have no native
   counterpart to diff against. Closing that gap needs shared structured routing
   data, which is out of scope here; this decision records the limit rather than
   letting "cannot silently drift" overstate it.
4. **The served installer is a supply-chain trust root and is treated as one.**
   `apps/docs/public/install.sh` and `install.ps1` are frozen rails. A test
   pins their content by checksum so a change to either is a deliberate,
   reviewed act rather than an incidental edit. ADR-0010 records the
   `curl | sh` decision.
5. **The installer never installs Node.** ADLC is Node ≥18 + npm. When the
   prerequisite is missing the installer explains and exits non-zero; it does
   not fetch or execute a Node installer.
6. **The installer only runs native paths for harnesses it detects.** No
   harness is installed speculatively, and the installer MUST NOT modify a
   harness's user-global configuration for a harness that is not present.
7. **~~Windows ships as beta, backed by CI~~ → Windows is not claimed at all.**
   This decision was written as a beta claim and then overturned by its own
   gate: a `windows-latest` run of the core suites passed 6 of 28. A "beta"
   label describes rough edges, not a platform where four fifths of the gates
   fail, so `install.ps1` came out before merge and every surface says Windows
   is unsupported and points at WSL. (`packages/fleet` is separately POSIX-only
   by design.) Restoring a Windows installer requires restoring a green
   `windows-latest` gate in the same change.
8. **Marketing renders install text verbatim from a single source.** The
   existing `integration-facts.mjs` remains the source of truth for per-harness
   install lines; the universal command gets one exported constant and every
   surface imports it. No install string is hand-typed into a page.

## I1 — skills.sh distribution

Add a top-level `skills/` catalog discoverable by the skills CLI, plus the
drift test that keeps it honest, plus documentation of what the channel does
and does not deliver.

### Acceptance criteria

- **AC1.1** A top-level `skills/` directory exists containing at least the
  phase-router skill at a path the skills CLI discovers.
  **VERIFY:** `node --test scripts/test/skills-catalog.test.mjs` — the
  frontmatter case asserts `skills/adlc/SKILL.md` exists and that every
  catalog skill opens with a `---` fence carrying non-empty `name` and
  `description` keys, with `name` matching its directory.
- **AC1.2** No skill under `skills/` contains harness-specific invocation
  syntax.
  **VERIFY:** `node --test scripts/test/skills-catalog.test.mjs` — the neutrality case
  greps every `skills/**/SKILL.md` for `/adlc:`, `$adlc-`, and `/adlc-` and
  asserts zero matches.
- **AC1.3** The neutral catalog cannot silently drift from the per-harness
  plugin skills.
  **VERIFY:** `node --test scripts/test/skills-catalog.test.mjs` — the drift case
  asserts every phase label `P0`–`P7` and every gate tool name in
  `plugins/adlc-claude-code/skills/adlc/SKILL.md` also appears in
  `skills/adlc/SKILL.md`; dropping a gate from either file fails the case.
- **AC1.4** `npx skills add` against the working tree resolves the catalog.
  **VERIFY:** `node scripts/skills-add-smoke.mjs .` exits 0 — it runs the real
  skills CLI against a throwaway HOME and asserts all three catalog skills land
  on disk, since the CLI exits 0 having installed nothing when it walks past a
  layout it does not recognize. Network-dependent, so it is a `scripts/` smoke
  rather than part of the offline unit suite.
- **AC1.5** The channel's limits are documented where it is recommended.
  **VERIFY:** `node --test scripts/test/skills-catalog.test.mjs` — the honesty case
  asserts every file that names `skills.sh` also contains the phrase
  `skills only` within the same section and never claims hooks, MCP, or rails
  coverage for that channel.

## I2 — Universal installer

### Acceptance criteria

- **AC2.1** `install.sh` is POSIX `sh` (no bashisms) and passes a syntax check.
  **VERIFY:** `sh -n apps/docs/public/install.sh` exits 0, and
  `node --test scripts/test/install-sh.test.mjs` asserts that same `sh -n`
  result plus the absence of the common bashisms (`[[`, `local`, arrays).
- **AC2.2** The installer exits non-zero with an actionable message when Node
  is absent or below 18, and installs nothing.
  **VERIFY:** `node --test scripts/test/install-sh.test.mjs` — the no-node case
  runs the script with a `PATH` containing no `node` and asserts exit status ≥ 1, stderr naming Node 18, and no `npm` invocation
  recorded by the stubbed command log.
- **AC2.3** The installer installs `@adlc/cli` and then runs the native install
  for exactly the harnesses present, and none of the absent ones.
  **VERIFY:** `node --test scripts/test/install-sh.test.mjs` — the detection case
  executes the script against a stub `PATH` exposing a chosen subset of harness binaries, capturing every command through a logging
  shim; it asserts the log contains `npm install -g @adlc/cli`, contains the
  native command for each stubbed harness, and contains no command naming any
  harness that was not stubbed.
- **AC2.4** Re-running the installer on an already-installed machine is safe.
  **VERIFY:** `node --test scripts/test/install-sh.test.mjs` — the idempotence case
  runs the script twice against the same stub environment and asserts the
  second run exits 0 with a command log byte-equal to the first.
- **AC2.5** ~~`install.ps1` exists, is labeled beta, and parses.~~
  **WITHDRAWN — the gate that was meant to back this killed it.** A
  `windows-latest` run of the core gate suites passed **6 of 28**: the shared
  bin-resolution path builds `D:\D:\…` from an already-absolute Windows path.
  No `.ps1` is served.
  **VERIFY:** `node --test scripts/test/install-sh.test.mjs` — the tripwire case
  asserts no `.ps1` exists under `apps/docs/public/`, so restoring one requires
  restoring a green `windows-latest` gate in the same change.
- **AC2.6** ~~Core gates pass on Windows.~~
  **WITHDRAWN — measured false.** Evidence: PR #351, job `windows-core (22)`,
  6/28 package suites passing. Tracked as follow-on work; Windows adopters are
  pointed at WSL. The withdrawal itself is what now needs verifying, so that a
  Windows claim cannot creep back without its gate.
  **VERIFY:** `node --test scripts/test/install-sh.test.mjs` — the tripwire and
  platform-limits cases together assert no `.ps1` is served and that every
  surface offering the installer states Windows is unsupported.
- **AC2.7** The served installers are content-pinned.
  **VERIFY:** `node --test scripts/test/install-sh.test.mjs` — the digest case
  recomputes the SHA-256 of
  `apps/docs/public/install.sh` and `install.ps1` and compares against a
  checked-in digest file; editing either script without updating the digest
  fails `npm test`.
- **AC2.8** The `curl | sh` decision is recorded.
  **VERIFY:** `docs/adr/0010-first-party-curl-installer.md` exists with
  `**Status:** **Accepted.**` and cross-references ADR-0009.
- **AC2.9** Windows limits are stated, not implied.
  **VERIFY:** `node --test scripts/test/install-sh.test.mjs` — the platform-limits
  case asserts every surface offering the installer states Windows is
  unsupported, rather than staying silent and letting an adopter discover 22
  failing suites.

## I3 — Install CTA placement

### Acceptance criteria

The docs suite asserts over component **source order**, matching the existing
`codex-docs-current.test.mjs` convention; it does not render React.

- **AC3.1** Each integration detail page places its install block inside the
  hero, above the surfaces section.
  **VERIFY:** `node --test apps/docs/test/install-cta.test.mjs` — the hero-order
  case asserts, in `integration-detail.tsx`, that the `<IntegrationCard` usage
  index is greater than the `MarketingSection` hero opening index and less than
  the `surfacesSection` usage index.
- **AC3.2** The `NativeBundle` file tree still renders, relocated below the
  hero.
  **VERIFY:** `node --test apps/docs/test/install-cta.test.mjs` — the bundle
  case asserts `<NativeBundle` still appears in `integration-detail.tsx` and at
  a source index greater than the `<IntegrationCard` index.
- **AC3.3** The full install section remains at the bottom with its operate
  commands and resource nav.
  **VERIFY:** `node --test apps/docs/test/install-cta.test.mjs` — the tail case
  asserts `installSection`, `<OperatingCommands`, and `<ResourceNav` all still
  appear and that `<ResourceNav` is the last of the three.
- **AC3.4** The `/integrations` index leads with the universal install command.
  **VERIFY:** `node --test apps/docs/test/install-cta.test.mjs` — the index case
  asserts the `UNIVERSAL_INSTALL` import is used in
  `app/(home)/integrations/page.tsx` at a source index less than the
  `INTEGRATIONS.map(` index.
- **AC3.5** The homepage hero carries the copy-able install command.
  **VERIFY:** `node --test apps/docs/test/install-cta.test.mjs` — the homepage
  case asserts `UNIVERSAL_INSTALL` is used in `app/(home)/page.tsx` at a source
  index less than the `The problem` kicker index.
- **AC3.6** No install string is duplicated as a literal in a page component.
  **VERIFY:** `node --test apps/docs/test/install-cta.test.mjs` — the
  single-source case reads the `UNIVERSAL_INSTALL` value from its module and
  asserts that literal appears in no file under `apps/docs/app/` or
  `apps/docs/components/` other than the module that defines it.

## I4 — Agent-led onboarding

A visitor already running a coding agent should be able to hand the whole
install to it. Two artifacts: a served `agent-guide.md` written *for the agent*,
and a paste-able prompt on the site that points at it.

The guide MUST be generated from `integration-facts.mjs`, not hand-written.
A hand-written guide is a seventh copy of the install commands and would rot
against the six that already exist — the same claim-accuracy obligation
ADR-0009 Decision 4 imposes.

### Acceptance criteria

- **AC4.1** `https://www.agenticlifecycle.ai/agent-guide.md` serves a plain-text
  guide addressed to an agent.
  **VERIFY:** `node --test apps/docs/test/agent-guide.test.mjs` — the generator
  case calls `buildAgentGuide()` and asserts a substantial body opening with the
  agent-addressed heading; the route case asserts `app/agent-guide.md/route.ts`
  exports `GET`, serves that generator, and sets `text/markdown`. The route is
  checked by source rather than imported because it is `.ts` and resolves
  through Next's `@/` alias, which Node cannot load outside a Next build; all
  the behavior lives in the `.mjs` generator, which IS executed.
- **AC4.2** The guide's install instructions are generated from
  `integration-facts.mjs`, never hand-typed.
  **VERIFY:** `node --test apps/docs/test/agent-guide.test.mjs` — the
  generation case asserts every `integration.install` line of every entry in
  `INTEGRATIONS` appears verbatim in the guide body.
- **AC4.3** The guide instructs the agent to detect the harness it is running
  in before choosing an install path.
  **VERIFY:** `node --test apps/docs/test/agent-guide.test.mjs` — the detection
  case asserts the body contains a "detect which harness you are running in"
  directive and names every `integration.slug`.
- **AC4.4** The guide constrains the agent against acting without consent.
  **VERIFY:** `node --test apps/docs/test/agent-guide.test.mjs` — the rules case
  asserts the body contains a "Rules for you" section that forbids running
  install commands before the human confirms.
- **AC4.5** The guide states the same limits the other surfaces do.
  **VERIFY:** `node --test apps/docs/test/agent-guide.test.mjs` — the honesty
  case asserts the body names the Node ≥18 prerequisite, states `adlc fleet` is
  POSIX-only, and describes the skills.sh channel as `skills only`.
- **AC4.6** The paste-able prompt appears on the site and points at the guide.
  **VERIFY:** `node --test apps/docs/test/agent-guide.test.mjs` — the prompt
  case asserts the `AGENT_PROMPT` constant is used on the `/integrations` index
  page and that its text contains the `agent-guide.md` URL.
- **AC4.7** The prompt text is defined once.
  **VERIFY:** `node --test apps/docs/test/agent-guide.test.mjs` — the
  single-source case asserts the `AGENT_PROMPT` literal appears in no file under
  `apps/docs/app/` or `apps/docs/components/` other than its defining module.
- **AC4.8** The guide is discoverable from the existing LLM surface.
  **VERIFY:** `node --test apps/docs/test/agent-guide.test.mjs` — the discovery
  case asserts `app/llms.txt/route.ts` emits a link to `agent-guide.md`.

## Out of scope

- Porting `packages/fleet` off `/bin/sh` for Windows parity. Tracked
  separately; I2 documents the exclusion rather than closing it.
- Publishing `@adlc/copilot` and `@adlc/herdr` to npm. The installer detects
  these harnesses and prints their current native path; it does not depend on
  unpublished packages.
- Applying to the skills.sh **curated** listing
  (`GET /api/v1/skills/curated`, "official first-party skills from technology
  makers"). That is an outreach action, not a code change; I1 makes the repo
  eligible by being installable.
- Adding herdr to the `INTEGRATIONS` marketing set. `plugins/adlc-herdr` is an
  observability surface, not an enforcement tier, and the capability matrix
  deliberately keeps seven harness columns.
