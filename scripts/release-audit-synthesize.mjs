#!/usr/bin/env node
// release-audit-synthesize — Phase C of /release-audit: turn ~43 agent reports
// into one defensible GO / GO-WITH-RISK / NO-GO.
//
// WHY THE VERDICT IS COMPUTED HERE AND NOT BY A MODEL. The whole audit exists to
// surface release blockers, and the cheapest way to lose one is to hand 43
// structured reports to a summarizing agent and let it decide what was worth
// mentioning. Bucketing, grounding, dedup and the verdict are therefore plain
// arithmetic over the reports. A model may narrate this output; it is
// structurally unable to drop an item from it.
//
// THE THREE DEMOTION RULES, and why each demotes rather than deletes:
//   ungrounded — the finding's quoted evidence does not appear in the file it
//     cites, so the reasoning rests on text the agent did not read. Ported from
//     adversarial-review, which halves confidence for the same reason.
//   refuted    — a second agent, asked to break the finding, broke it.
//   hollow     — the unit report lists no files examined. "I found nothing" from
//     an agent that read nothing is not a clean bill of health.
// None of the three deletes a finding. A deleted finding is unreviewable; a
// demoted one still appears, with the demotion named, and a human can disagree.
//
// FAIL-CLOSED COVERAGE. A shipped artifact whose agent produced no report at all
// forces NO-GO. release.mjs states the rule this borrows: "could not check" must
// never render as "verified".
//
// Usage:
//   node scripts/release-audit-synthesize.mjs --input <collect.json>
//                                             --reports <workflow-output.json>
//                                             [--suite <npm-test-log>]
//                                             [--json <out.json>]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const BUCKETS = ['BLOCKER', 'SHOULD-FIX', 'BACKLOG'];

/**
 * The suite-level agents, which audit what no single-unit agent can see. Expected
 * in coverage exactly like a package: a missing suite report is an unaudited
 * surface, not a quiet omission.
 */
export const SUITE_UNITS = ['suite:drift', 'suite:docs', 'suite:supply'];

/**
 * Every suite-level unit this run must hear from: the three fixed agents plus one
 * issue-sweep shard per batch the collector produced. The shard count is data, not
 * a constant, because it tracks the size of the open backlog — and coverage has to
 * expect exactly the agents that were actually dispatched, or every run fails
 * closed for a reason nobody can find.
 */
export function expectedSuiteUnits(input) {
  const batches = input?.issues?.sweepBatches ?? [[]];
  return [...SUITE_UNITS, ...batches.map((_, i) => `suite:issues:${i + 1}`)];
}

/**
 * Probe problems that block a release outright, versus ones a bump would heal.
 *
 * publishMetadata and hostDiscoveryNearMisses block: a bad repository.url makes
 * npm's sigstore check 422 and aborts the lockstep publish PARTWAY THROUGH,
 * leaving the suite half-published; a near-miss host directory is invisible to
 * both the bumper and the drift gate, which is how a plugin sat at 0.2.0 for
 * three releases. versionDrift does not block, because this audit runs BEFORE
 * the bump and `release.mjs <version>` rewrites those versions by design.
 */
export const PROBE_SEVERITY = {
  publishMetadata: 'BLOCKER',
  hostDiscoveryNearMisses: 'BLOCKER',
  versionDrift: 'SHOULD-FIX',
};

/**
 * Whether a finding's three-part blocker test is fully asserted. Shared, because
 * dedup and demotion must agree on what counts as a supported severity claim — if
 * they disagree, one of them silently undoes the other.
 */
export function blockerTestAsserted(t) {
  return Boolean(t && t.user_hits_it === true && t.needs_another_release === true && t.worse_than_status_quo === true);
}

export function parseArgs(argv) {
  const out = { input: null, reports: null, suite: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') { out.input = argv[i + 1] ?? null; i += 1; continue; }
    if (a === '--reports') { out.reports = argv[i + 1] ?? null; i += 1; continue; }
    if (a === '--suite') { out.suite = argv[i + 1] ?? null; i += 1; continue; }
    if (a === '--json') { out.json = argv[i + 1] ?? null; i += 1; continue; }
  }
  return out;
}

/**
 * Read run-tests.mjs's own summary out of a captured log.
 *
 * Deliberately does NOT infer success from the absence of the word "FAILED":
 * a suite killed before it printed a summary would then read as green, which is
 * the exact hiding-a-failure-behind-a-failure bug run-tests.mjs was rewritten to
 * prevent. No summary line means `ran: false`.
 */
export function parseSuiteResult(text) {
  const s = String(text ?? '');
  const summary = /═+\s*(\d+)\/(\d+) segments passed/.exec(s);
  if (!summary) return { ran: false, green: false, passed: null, total: null, failed: [], reason: 'no summary line in suite log' };
  const passed = Number(summary[1]);
  const total = Number(summary[2]);
  const failed = [...s.matchAll(/^\s*FAILED\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
  return { ran: true, green: passed === total && failed.length === 0, passed, total, failed, reason: null };
}

/** Normalize whatever an agent returned into the finding shape the report uses. */
export function normalizeFinding(raw, unit) {
  const bucket = BUCKETS.includes(raw?.bucket) ? raw.bucket : 'BACKLOG';
  return {
    unit,
    bucket,
    originalBucket: bucket,
    klass: String(raw?.klass ?? raw?.category ?? 'unclassified'),
    title: String(raw?.title ?? '(untitled)'),
    body: String(raw?.body ?? ''),
    file: raw?.file ? String(raw.file) : null,
    line: Number.isFinite(raw?.line) ? raw.line : null,
    evidence: typeof raw?.evidence === 'string' ? raw.evidence : '',
    consequence: String(raw?.consequence ?? ''),
    recommendation: String(raw?.recommendation ?? ''),
    blockerTest: raw?.blocker_test ?? raw?.blockerTest ?? null,
    refuted: raw?.refuted === true,
    refutation: raw?.refutation ?? null,
    grounded: null,
    demotions: [],
  };
}

/**
 * Verify a finding's evidence actually occurs in the file it cites.
 *
 * Whitespace is normalized on both sides before comparing — an agent quoting
 * source through a JSON round-trip reliably differs in indentation, and failing
 * a true finding on leading spaces would train everyone to ignore the check.
 */
export function groundFinding(finding, { root = ROOT, readFile = readFileSync, exists = existsSync } = {}) {
  if (!finding.file) return { grounded: false, reason: 'no file cited' };
  if (!finding.evidence.trim()) return { grounded: false, reason: 'no evidence quoted' };
  // The cited path comes from a model, so it is untrusted input to a file read.
  // A finding is only ever about a file IN the repository; anything that resolves
  // outside it is malformed by definition, and reading it would turn a grounding
  // check into an arbitrary-file probe.
  const abs = resolve(root, finding.file);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) {
    return { grounded: false, reason: `cited path resolves outside the repository: ${finding.file}` };
  }
  if (!exists(abs)) return { grounded: false, reason: `cited file does not exist: ${finding.file}` };
  let source;
  try { source = readFile(abs, 'utf8'); } catch (err) { return { grounded: false, reason: `unreadable: ${err.message}` }; }
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  if (flat(source).includes(flat(finding.evidence))) return { grounded: true, reason: null };
  return { grounded: false, reason: 'quoted evidence does not appear in the cited file' };
}

/** Attach the grounding result to every finding, before anything merges them. */
export function groundAll(findings, { root = ROOT, readFile = readFileSync, exists = existsSync } = {}) {
  return findings.map((f) => {
    if (f.grounded !== null && f.grounded !== undefined) return f;
    const g = groundFinding(f, { root, readFile, exists });
    return { ...f, grounded: g.grounded, groundingReason: g.reason };
  });
}

/**
 * Collapse findings that name the same defect in the same place.
 *
 * Grounding runs BEFORE this, and the survivor prefers a grounded member. Two
 * agents can find the same defect and quote it differently — one verbatim, one
 * paraphrased. Merging them in arrival order let a paraphrase win, which demoted
 * a genuine blocker for a reason that had nothing to do with whether it was real.
 * Severity merges upward, evidence merges toward whichever copy checks out.
 */
export function dedupeFindings(findings) {
  const seen = new Map();
  for (const f of findings) {
    const key = [f.unit, f.file ?? '-', f.line ?? '-', f.title.toLowerCase().replace(/\W+/g, ' ').trim()].join('|');
    const prior = seen.get(key);
    if (!prior) { seen.set(key, { ...f, duplicates: 0 }); continue; }
    prior.duplicates += 1;
    // Keep the most severe reading of the same defect — and carry the reasoning
    // that JUSTIFIES that severity along with it. Raising the bucket while leaving
    // the lower-severity copy's supporting fields in place made applyDemotions
    // reject the very claim dedup had just accepted: one agent rating a defect
    // SHOULD-FIX was enough to demote another agent's fully-asserted BLOCKER for
    // the same defect. A real release blocker disappeared because two agents
    // agreed it existed.
    if (BUCKETS.indexOf(f.bucket) < BUCKETS.indexOf(prior.bucket)) {
      prior.bucket = f.bucket;
      prior.originalBucket = f.originalBucket;
      prior.klass = f.klass;
      prior.consequence = f.consequence;
      prior.recommendation = f.recommendation;
    }
    // The supporting assertion travels independently of the bucket: two agents can
    // both say BLOCKER while only one of them filled the test in.
    if (blockerTestAsserted(f.blockerTest) && !blockerTestAsserted(prior.blockerTest)) {
      prior.blockerTest = f.blockerTest;
    }
    // Keep the reading whose evidence actually checks out.
    if (prior.grounded !== true && f.grounded === true) {
      prior.grounded = true;
      prior.groundingReason = null;
      prior.evidence = f.evidence;
      prior.file = f.file;
      prior.line = f.line;
    }
    // A refutation of one copy does not refute the defect; only an unrefuted
    // copy can keep it unrefuted.
    if (prior.refuted && !f.refuted) { prior.refuted = false; prior.refutation = f.refutation; }
  }
  return [...seen.values()];
}

/** Apply the demotion rules. Never deletes; always records why. */
export function applyDemotions(findings, { root = ROOT, readFile = readFileSync, exists = existsSync, hollowUnits = new Set() } = {}) {
  return findings.map((f) => {
    const out = { ...f, demotions: [...f.demotions] };
    if (out.grounded === null || out.grounded === undefined) {
      const g = groundFinding(out, { root, readFile, exists });
      out.grounded = g.grounded;
      out.groundingReason = g.reason;
    }
    if (!out.grounded) out.demotions.push(`ungrounded: ${out.groundingReason ?? 'evidence not verified'}`);
    if (out.refuted) out.demotions.push('refuted by the verification pass');
    if (hollowUnits.has(out.unit)) out.demotions.push('reported by a unit that examined no files');
    // The blocker test is three booleans the agent must assert, not a vibe. A
    // BLOCKER that does not carry all three is a severity claim the agent never
    // actually made, so it does not get to block a release.
    if (out.originalBucket === 'BLOCKER' && !out.mechanical) {
      if (!blockerTestAsserted(out.blockerTest)) out.demotions.push('blocker test not fully asserted');
    }
    if (out.bucket === 'BLOCKER' && out.demotions.length > 0) out.bucket = 'SHOULD-FIX';
    return out;
  });
}

/**
 * Which shipped artifacts were actually audited.
 * `hollow` = a report that examined no files; `missing` = no report at all.
 */
export function unitCoverage(reports, expectedUnitIds) {
  const byUnit = new Map(reports.map((r) => [r.unit, r]));
  const audited = [];
  const hollow = [];
  const missing = [];
  for (const id of expectedUnitIds) {
    const r = byUnit.get(id);
    if (!r) { missing.push(id); continue; }
    const examined = Array.isArray(r.files_examined) ? r.files_examined : (r.filesExamined ?? []);
    if (examined.length === 0) hollow.push(id);
    else audited.push(id);
  }
  return { audited, hollow, missing };
}

/** Turn the mechanical probe results into findings, so nothing lives outside the report. */
export function probeFindings(probes) {
  const out = [];
  for (const [key, bucket] of Object.entries(PROBE_SEVERITY)) {
    for (const problem of probes?.[key] ?? []) {
      out.push({
        unit: 'suite:mechanical',
        bucket,
        originalBucket: bucket,
        klass: `probe:${key}`,
        title: problem.slice(0, 120),
        body: problem,
        file: null,
        line: null,
        // Mechanical checks are their own evidence — they read the tree directly.
        evidence: '',
        consequence: bucket === 'BLOCKER' ? 'aborts or silently skips part of the lockstep publish' : 'the version bump is expected to heal this; confirm after bumping',
        recommendation: 'see scripts/release.mjs for the check that produced this',
        blockerTest: null,
        refuted: false,
        refutation: null,
        grounded: true,
        mechanical: true,
        demotions: [],
      });
    }
  }
  return out;
}

/**
 * The verdict. Fail-closed by construction:
 *   NO-GO        red suite, a surviving BLOCKER, or a shipped unit nobody audited
 *   GO-WITH-RISK no blockers, but open SHOULD-FIX items or a probe that could not run
 *   GO           nothing outstanding and everything was actually checked
 */
export function computeVerdict({ findings, coverage, probes, suite, issues, partial = false }) {
  const reasons = [];
  const blockers = findings.filter((f) => f.bucket === 'BLOCKER');

  // An ABSENT suite result is the same epistemic state as one that did not run:
  // nothing is known about the tests. Treating null as "fine" would let a caller
  // obtain a GO simply by omitting --suite, which is the cheapest possible way to
  // defeat the whole gate.
  if (!suite) reasons.push('no test suite result was supplied (--suite) — the tests are unverified');
  else if (suite.ran && !suite.green) reasons.push(`test suite is red: ${suite.failed.length} segment(s) failed — ${suite.failed.join(', ')}`);
  else if (!suite.ran) reasons.push('test suite result unavailable — no summary line was captured');
  if (blockers.length) reasons.push(`${blockers.length} release blocker(s) survived verification`);
  if (coverage.missing.length) reasons.push(`${coverage.missing.length} shipped artifact(s) produced no audit report: ${coverage.missing.join(', ')}`);
  if (coverage.hollow.length) reasons.push(`${coverage.hollow.length} audit report(s) examined no files: ${coverage.hollow.join(', ')}`);
  if (reasons.length) return { verdict: 'NO-GO', reasons };

  const shouldFix = findings.filter((f) => f.bucket === 'SHOULD-FIX');
  const unconsultable = probes?.unconsultable ?? [];
  if (shouldFix.length) reasons.push(`${shouldFix.length} should-fix item(s) open`);
  for (const u of unconsultable) reasons.push(`probe could not run: ${u}`);
  // Issue triage is one of the audit's two inputs, and its failure mode is silent:
  // when `gh` cannot answer, every list is simply empty and the run looks like a
  // backlog with nothing in it. Naming it is the difference between "no blocking
  // issues" and "no issues were read".
  if (issues?.unconsultable) reasons.push(`GitHub issues were not triaged: ${issues.unconsultable}`);
  if (issues?.truncated) reasons.push(`the open-issue list hit its fetch limit (${issues.truncated}) — some issues were never routed`);
  // A partial audit has nothing to say about the artifacts it did not read, so it
  // is never allowed to produce the verdict that means "the release is clear".
  if (partial) reasons.push('partial audit (--packages) — the unaudited artifacts and the suite-level agents were not run');
  if (reasons.length) return { verdict: 'GO-WITH-RISK', reasons };

  return { verdict: 'GO', reasons: ['no blockers, every shipped artifact audited, suite green'] };
}

/** The terse thing a human reads before deciding to cut the release. */
export function renderTerminal(result) {
  const L = [];
  const { verdict, reasons } = result.verdict;
  L.push(`RELEASE AUDIT — ${result.version} (baseline ${result.since ?? 'none'})`);
  L.push(`VERDICT: ${verdict}`);
  for (const r of reasons) L.push(`  · ${r}`);
  L.push('');
  L.push(`units audited ${result.coverage.audited.length}/${result.expectedUnits}` +
    `${result.coverage.hollow.length ? `  hollow ${result.coverage.hollow.length}` : ''}` +
    `${result.coverage.missing.length ? `  missing ${result.coverage.missing.length}` : ''}`);
  const counts = BUCKETS.map((b) => `${b} ${result.findings.filter((f) => f.bucket === b).length}`).join('   ');
  L.push(counts);
  const blockers = result.findings.filter((f) => f.bucket === 'BLOCKER');
  if (blockers.length) {
    L.push('');
    L.push('BLOCKERS');
    for (const b of blockers) {
      L.push(`  [${b.klass}] ${b.unit} — ${b.title}`);
      if (b.file) L.push(`      ${b.file}${b.line ? `:${b.line}` : ''}`);
      if (b.consequence) L.push(`      → ${b.consequence}`);
    }
  }
  const demoted = result.findings.filter((f) => f.originalBucket === 'BLOCKER' && f.bucket !== 'BLOCKER');
  if (demoted.length) {
    L.push('');
    L.push(`DEMOTED FROM BLOCKER (${demoted.length}) — reported, not blocking`);
    for (const d of demoted) L.push(`  ${d.unit} — ${d.title}  [${d.demotions.join('; ')}]`);
  }
  return L.join('\n');
}

export function synthesize({ input, reports, suite, root = ROOT, readFile = readFileSync, exists = existsSync }) {
  // A narrowed run (--packages) does not run the suite agents, so it must not be
  // held to their coverage — and, by the same token, must never read as GO.
  const expectedUnitIds = [
    ...(input.units ?? []).map((u) => u.id),
    ...(input.filtered ? [] : expectedSuiteUnits(input)),
  ];
  const coverage = unitCoverage(reports, expectedUnitIds);
  const hollowUnits = new Set(coverage.hollow);

  const raw = [];
  for (const r of reports) {
    for (const f of r.findings ?? []) raw.push(normalizeFinding(f, r.unit));
  }
  const grounded = applyDemotions(
    dedupeFindings(groundAll(raw, { root, readFile, exists })),
    { root, readFile, exists, hollowUnits },
  );
  const findings = [...probeFindings(input.probes), ...grounded]
    .sort((a, b) => BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));

  return {
    schema: 'release-audit-result/1',
    version: input.version,
    since: input.since,
    expectedUnits: expectedUnitIds.length,
    coverage,
    suite,
    probes: input.probes,
    issues: input.issues,
    issueVerdicts: reports.flatMap((r) => (r.issue_verdicts ?? r.issueVerdicts ?? []).map((v) => ({ unit: r.unit, ...v }))),
    findings,
    partial: input.filtered === true,
    verdict: computeVerdict({ findings, coverage, probes: input.probes, suite, issues: input.issues, partial: input.filtered === true }),
  };
}

export function synthesizeMain(argv = process.argv.slice(2), { readFile = readFileSync, writeFile = writeFileSync, log = console.log, root = ROOT } = {}) {
  const args = parseArgs(argv);
  if (!args.input || !args.reports) {
    log('usage: release-audit-synthesize --input <collect.json> --reports <workflow.json> [--suite <log>] [--json <out>]');
    return 1;
  }
  const input = JSON.parse(readFile(args.input, 'utf8'));
  const reportDoc = JSON.parse(readFile(args.reports, 'utf8'));
  const reports = Array.isArray(reportDoc) ? reportDoc : (reportDoc.reports ?? []);
  const suite = args.suite ? parseSuiteResult(readFile(args.suite, 'utf8')) : null;

  const result = synthesize({ input, reports, suite, root, readFile });
  if (args.json) writeFile(args.json, JSON.stringify(result, null, 2));
  log(renderTerminal(result));
  return result.verdict.verdict === 'NO-GO' ? 2 : 0;
}

const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) process.exit(synthesizeMain());
