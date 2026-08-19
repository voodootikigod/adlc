# release-audit workflow script

Build a runnable copy with `scripts/release-audit-workflow.mjs`, which prepends the
collected document as `INPUT_DOC` and emits a self-contained script. Hand that file
to the **Workflow** tool as `scriptPath`; no `args` are needed.

The script still accepts `args` when one is supplied, so it stays parameterised —
but embedding is the normal path, because `args` must be transcribed inline into the
tool call and the collected document is tens of kilobytes.

A workflow script has no filesystem and no `child_process` — it can only read
`args`. Every mechanical fact it needs is therefore collected by
`scripts/release-audit-collect.mjs` first. The subagents it spawns *do* have tools
and read the repository directly.

```javascript
export const meta = {
  name: 'release-audit',
  description: 'Per-artifact production-readiness audit of the @adlc suite before a release',
  phases: [
    { title: 'Audit', detail: 'one agent per shipped artifact, plus the suite-level agents' },
    { title: 'Verify', detail: 'a refute pass over every blocker candidate' },
  ],
}

// <<INPUT_DOC>>

// `args` when the Workflow tool is given one; otherwise the document the build
// step embedded above. Embedding is the normal path: `args` must be transcribed
// inline into the tool call, and the collected document is tens of kilobytes, so
// hand-copying it is both expensive and a transcription-error risk.
const input = (typeof args !== 'undefined' && args) || INPUT_DOC
const FILTERED = input.filtered === true

const FINDING = {
  type: 'object',
  additionalProperties: false,
  required: ['bucket', 'klass', 'title', 'body', 'file', 'line', 'evidence', 'consequence', 'recommendation', 'blocker_test'],
  properties: {
    bucket: { type: 'string', enum: ['BLOCKER', 'SHOULD-FIX', 'BACKLOG'] },
    klass: {
      type: 'string',
      enum: ['false-green', 'install-first-run', 'undeclared-breaking-change', 'trust-boundary',
             'secrets', 'data-loss', 'doc-claim', 'dependency', 'unclassified'],
    },
    title: { type: 'string' },
    body: { type: 'string' },
    file: { type: ['string', 'null'], description: 'repo-relative path, e.g. packages/core/lib/glob.mjs' },
    line: { type: ['integer', 'null'] },
    evidence: { type: 'string', description: 'VERBATIM quote from the cited file. Checked mechanically.' },
    consequence: { type: 'string', description: 'what the user experiences when this bites' },
    recommendation: { type: 'string' },
    blocker_test: {
      type: 'object',
      additionalProperties: false,
      required: ['user_hits_it', 'needs_another_release', 'worse_than_status_quo'],
      properties: {
        user_hits_it: { type: 'boolean' },
        needs_another_release: { type: 'boolean' },
        worse_than_status_quo: { type: 'boolean' },
      },
    },
  },
}

const REPORT = {
  type: 'object',
  additionalProperties: false,
  required: ['unit', 'files_examined', 'findings', 'issue_verdicts', 'notes'],
  properties: {
    unit: { type: 'string' },
    files_examined: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: FINDING },
    issue_verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'verdict', 'rationale'],
        properties: {
          number: { type: 'integer' },
          verdict: { type: 'string', enum: ['still-reproducible', 'already-fixed-close-it', 'real-but-not-blocking', 'cannot-determine'] },
          rationale: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'refutation'],
  properties: {
    refuted: { type: 'boolean' },
    refutation: { type: 'string' },
  },
}

const CLASSES = `
Hunt these, in this priority order. The first is this product's signature risk:
every package here is a GATE, and a gate's catastrophic failure is not a crash —
it is exiting 0 when it should exit 2.

1. FALSE-GREEN — the gate passes when it should fail, or fails OPEN on malformed,
   empty, or absent input. Includes: a check that silently skips its subject and
   reports success; a filter that drops malformed votes out of a denominator; an
   error path that returns "clean" instead of "could not check"; a budget/cap that
   makes the tool prosecute almost nothing while printing a success line.
2. INSTALL / FIRST-RUN — what breaks for someone running \`npm i\` and the bin:
   a "files" allowlist that omits a file the package imports, a bin path that is
   not published, a missing shebang, an engines floor that does not match the
   syntax used, Windows path handling in code that ships to Windows.
3. UNDECLARED BREAKING CHANGE — a flag, exit code, output schema, or public export
   that changed since the baseline tag without a major bump. The suite releases in
   LOCKSTEP at one shared version, so a breaking change in any package ships to
   everyone.
4. TRUST BOUNDARY — hooks and resolvers that execute repository-controlled code
   with the ambient environment; anything that would let a reviewed repository
   influence the tool reviewing it; signing-key handling.
5. SECRETS — a key, token, or signing material that can reach a log, an error
   message, a manifest, or the findings ledger.
6. DATA LOSS — destructive writes to the ticket store, the manifest chain, or a
   handoff file; a non-atomic rewrite that can truncate on interrupt.
7. DOC-CLAIM — a README or help text that documents behaviour the code does not
   have. Users act on documented behaviour, so a false claim is a real defect.
8. DEPENDENCY — an unpinned, unused, or runtime dependency in a package whose
   whole premise is zero runtime dependencies.
`

const BLOCKER_TEST = `
MOST FINDINGS ARE NOT BLOCKERS. Bucket a finding BLOCKER only when all three are
true, and assert each one explicitly in blocker_test:

  user_hits_it            — someone running \`npm i @adlc/<pkg>@${input.version}\`
                            actually encounters it. Not "could in theory".
  needs_another_release   — it cannot be fixed after the fact; correcting it
                            requires cutting a new release.
  worse_than_status_quo   — it is worse than what ${input.since || 'the last release'}
                            already shipped. A long-standing wart that is no worse
                            than last release is SHOULD-FIX, not a blocker.

If any of the three is false, the bucket is SHOULD-FIX (ship, eyes open) or
BACKLOG (file it, move on). A report where everything is a BLOCKER is a report
nobody can act on, and will be treated as noise.
`

const HONESTY = `
files_examined must list every file you actually read. It is checked. An empty
list is treated as a hollow report — "I found nothing" from an agent that read
nothing is not a clean bill of health, and it forces the whole audit to NO-GO.

evidence must be a VERBATIM quote from the file named in \`file\`. It is verified
mechanically against the real file; a finding whose quote is not there is demoted
out of BLOCKER regardless of how right it sounds. Quote the code, do not
paraphrase it.

If you cannot determine something, say so in notes. "Could not check" must never
be reported as "verified".
`

function issueBlock(issues) {
  if (!issues || issues.length === 0) return 'No open GitHub issues routed to this artifact.\n'
  const lines = issues.map((i) =>
    `- #${i.number} [${(i.labels || []).join(', ') || 'no labels'}] ${i.title}\n  ${i.url}\n  routed via ${i.routedVia}`)
  return `Open GitHub issues routed here. For EACH, return an issue_verdicts entry saying whether it
still reproduces in the code as it stands, is already fixed and should be closed, is real
but not release-blocking, or cannot be determined. Read the code before answering.

${lines.join('\n')}
`
}

function churnBlock(c) {
  if (!c) return 'No churn data.\n'
  if (c.unconsultable) return `Churn since ${c.since || 'baseline'} could not be read: ${c.unconsultable}\n`
  if (c.commits === 0) return `Unchanged since ${c.since}. Audit it anyway — a landmine that shipped three releases ago is still a landmine.\n`
  return `Changed since ${c.since}: ${c.commits} commit(s) across ${c.filesChanged} file(s). Weight these, but audit the whole artifact.
${(c.subjects || []).map((s) => `  ${s}`).join('\n')}
`
}

function unitPrompt(u) {
  const hookNote = u.kind === 'plugin' ? `
THIS IS A HOST PLUGIN, so it carries the hook surface — code that returns
allow/deny decisions for tool calls, with the ambient environment in scope. That
is where false-green is catastrophic: a hook that fails OPEN silently disables a
gate for an entire session, and a hook that fails CLOSED wrongly can deny every
mutating tool call. Read every hook entrypoint. Check what happens on malformed
input, absent input, a wrapper timeout, and a projection that contains fewer
fields than the tests supply.
` : ''

  return `You are auditing ONE shipped artifact of the @adlc suite for production readiness
before release ${input.version}.

ARTIFACT: ${u.name} (${u.id})
  directory:  ${u.dir}
  version:    ${u.version}
  published:  ${u.published ? 'yes' : 'no'}${u.manifest ? ` (via ${u.manifest}, NOT npm)` : ''}
  bin:        ${JSON.stringify(u.bin)}
  files field:${JSON.stringify(u.filesField)}
  deps:       ${JSON.stringify(u.dependencies)}
  engines:    ${JSON.stringify(u.engines)}
  has tests:  ${u.hasTests ? 'yes' : 'NO — note this'}
  ${u.fileCount} files, ${Math.round(u.bytes / 1024)} KB
${hookNote}
${churnBlock(u.churn)}
${issueBlock(u.issues)}
Read the artifact directly with your tools — source, tests, README, package.json.
Do not audit from this prompt alone; it is an index, not the code.
${CLASSES}
${BLOCKER_TEST}
${HONESTY}
Return the structured report. unit must be exactly "${u.id}".`
}

const SUITE_SPECS = [
  {
    id: 'suite:drift',
    label: 'suite:drift',
    prompt: `You audit CROSS-ARTIFACT DRIFT for the @adlc suite before release ${input.version}.
No single-package agent can see what you are looking for.

1. GENERATED COPIES. The canonical glob matcher is packages/core/lib/glob.mjs and it is
   COPIED into several harness locations that must be regenerated, never hand-edited.
   Find every copy, diff each against the canonical source, and report any that differs.
   A drifted copy means a rail predicate behaves differently in one harness than another.
2. PLUGIN <-> PACKAGE CONTRACT. Plugins inline or mirror core logic. Find inlined copies
   and check them against the package they mirror.
3. SKILL MIRRORS. skills/* are mirrored into plugins/*/skills/*. Report any mirror whose
   content has diverged from its source.
4. VERSION SURFACES. plugins/adlc-claude-code has NO package.json — its version lives in
   plugins/adlc-claude-code/.claude-plugin/plugin.json. This exact artifact stranded at
   0.2.0 across three releases because a gate enumerated a different set of manifests than
   the bumper did. Check it BY NAME, plus every other .<host>-plugin/plugin.json and
   marketplace.json, against the current version ${input.currentVersion}.
${CLASSES}
${BLOCKER_TEST}
${HONESTY}
Return the structured report with unit exactly "suite:drift".`,
  },
  {
    id: 'suite:docs',
    label: 'suite:docs',
    prompt: `You audit DOCUMENTATION ACCURACY for the @adlc suite before release ${input.version}.
Users act on documented behaviour, so a doc that describes behaviour the code does not have
is a real defect, not a cosmetic one.

1. CHANGELOG.md — is there an entry for ${input.version}? Does it describe what actually
   landed since ${input.since}? Are breaking changes called out as breaking?
2. CLI HELP vs REALITY — for the documented gates, do the flags named in READMEs, docs/,
   and apps/docs actually exist in the code, with the documented defaults and exit codes?
   Every tool exits 0 = pass, 1 = operational error, 2 = gate fails; report any tool that
   violates that contract or documents it wrongly.
3. INSTALL INSTRUCTIONS — do the documented install paths match what the packages actually
   publish (bin names, package names, the toolkit version floor)?
4. README claims per package that contradict the code.
${CLASSES}
${BLOCKER_TEST}
${HONESTY}
Return the structured report with unit exactly "suite:docs".`,
  },
  {
    id: 'suite:supply',
    label: 'suite:supply',
    prompt: `You audit SUPPLY CHAIN AND RELEASE MECHANICS for release ${input.version}.

1. DEPENDENCIES — the shipped packages are meant to carry ZERO runtime dependencies apart
   from each other. Find any that does not hold. Check for unpinned ranges on internal
   @adlc/* deps, and for devDependencies imported by shipped code.
2. RELEASE WORKFLOW — read .github/workflows/publish.yml and .claude/release-profile.md.
   The profile documents a token exception: a real NPM_TOKEN is held by a single gated
   publish job for EVERY package, not only the first-time ones. Assess whether anything
   this release makes that exposure worse, and whether OIDC trusted publishing covers what
   it claims to.
3. PROVENANCE — every non-private target needs publishConfig.provenance and a
   repository.url resolving to github.com/voodootikigod/adlc, or npm's sigstore check 422s
   and aborts the lockstep publish PARTWAY THROUGH, leaving the suite half-published.
4. LOCKFILE / ENGINES consistency across the workspace.

The mechanical probes already run and reported:
  version drift:        ${JSON.stringify(input.probes.versionDrift || [])}
  publish metadata:     ${JSON.stringify(input.probes.publishMetadata || [])}
  host near-misses:     ${JSON.stringify(input.probes.hostDiscoveryNearMisses || [])}
Do not re-report those; look for what they cannot see.
${CLASSES}
${BLOCKER_TEST}
${HONESTY}
Return the structured report with unit exactly "suite:supply".`,
  },
]

// The issue sweep is SHARDED. One agent asked to read the code behind ~63 issues
// will skim or report nothing examined; the collector therefore batches them and
// each batch gets its own agent. The shard ids must match what the synthesizer
// expects in expectedSuiteUnits(), or coverage fails closed on a phantom unit.
const SWEEP_BATCHES = input.issues?.sweepBatches || [[]]
const SWEEP_SPECS = SWEEP_BATCHES.map((batch, idx) => {
  const id = `suite:issues:${idx + 1}`
  return {
    id,
    label: id,
    prompt: `You are ISSUE SWEEP SHARD ${idx + 1} of ${SWEEP_BATCHES.length} for release ${input.version}.

These issues either belong to no single artifact, or are labelled P0-critical / P1-high /
security and therefore get a second read from you even if an artifact agent also saw them.
Nobody else is looking at this batch.

${batch.map((i) => `- #${i.number} [${(i.labels || []).join(', ') || 'no labels'}] ${i.title}\n  ${i.url}\n  ${i.routedTo ? `also routed to ${i.routedTo}` : `unrouted (${i.routedVia})`}`).join('\n') || '(this shard is empty — return an empty report)'}

For EVERY issue above, read the relevant code and return an issue_verdicts entry:
still-reproducible / already-fixed-close-it / real-but-not-blocking / cannot-determine.
Do not answer from the issue text alone — open the code it describes. An issue that was
quietly fixed months ago and never closed is a useful finding, and you are the only one
positioned to notice.

Then raise a finding for any issue that genuinely blocks release ${input.version}.

No milestone in this repo names a version, so no existing label tells you what must ship
before ${input.version}. Judge from the code and the issue, not from the backlog's triage.
${BLOCKER_TEST}
${HONESTY}
Return the structured report with unit exactly "${id}".`,
  }
})

// One work item per shipped artifact, plus the suite agents. A narrowed run
// (--packages) skips the suite agents, and the synthesizer caps such a run below GO.
const WORK = [
  ...input.units.map((u) => ({ id: u.id, label: u.id, prompt: unitPrompt(u) })),
  ...(FILTERED ? [] : [...SUITE_SPECS, ...SWEEP_SPECS]),
]

log(`auditing ${WORK.length} units for ${input.version} (baseline ${input.since || 'none'})`)

const reports = await pipeline(
  WORK,
  (spec) => agent(spec.prompt, { label: spec.label, phase: 'Audit', schema: REPORT }),

  // Refute pass, per unit, as soon as THAT unit finishes — no barrier. Only blocker
  // candidates pay for it, so the cost tracks how alarming the audit was, not how big
  // the suite is. A refuted finding is marked, never deleted: the synthesizer demotes
  // it to SHOULD-FIX so a human can still disagree with the refutation.
  async (report, spec) => {
    if (!report) return null
    const candidates = (report.findings || []).filter((f) => f.bucket === 'BLOCKER')
    if (candidates.length === 0) return report
    const verdicts = await parallel(candidates.map((f) => () =>
      agent(
        `A release audit of ${spec.id} claims this is a RELEASE BLOCKER for ${input.version}.
Your job is to REFUTE it. Read the actual code and find the reason it is not blocking:
the path is unreachable, the input cannot occur, a caller already guards it, the quoted
evidence does not mean what the claim says, or it is no worse than what ${input.since || 'the last release'}
already shipped.

CLAIM:      ${f.title}
CLASS:      ${f.klass}
WHERE:      ${f.file || '(no file)'}${f.line ? `:${f.line}` : ''}
EVIDENCE:   ${f.evidence}
BODY:       ${f.body}
CONSEQUENCE:${f.consequence}

Set refuted=true only if you can point at the specific reason it does not block, and say
what that reason is. If it genuinely blocks the release, set refuted=false and say why the
refutation attempt failed. Do not refuse to refute merely because the claim sounds serious.`,
        { label: `refute:${spec.id}`, phase: 'Verify', schema: VERDICT },
      )))
    const findings = candidates.map((f, i) => {
      const v = verdicts[i]
      return v ? { ...f, refuted: v.refuted === true, refutation: v.refutation } : f
    })
    const untouched = (report.findings || []).filter((f) => f.bucket !== 'BLOCKER')
    return { ...report, findings: [...findings, ...untouched] }
  },
)

const kept = reports.filter(Boolean)
log(`${kept.length}/${WORK.length} units reported`)
return { reports: kept }
```
