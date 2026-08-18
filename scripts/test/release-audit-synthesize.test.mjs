// Tests for scripts/release-audit-synthesize.mjs — Phase C of /release-audit.
//
// The verdict is the product. Everything here exists to prove the same property
// from different angles: the audit fails CLOSED. A red suite, a surviving
// blocker, an artifact nobody audited, or a report that examined no files must
// each produce NO-GO — and none of the demotion rules may ever DELETE a finding,
// because a deleted finding is one a human can no longer disagree with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUCKETS,
  SUITE_UNITS,
  expectedSuiteUnits,
  PROBE_SEVERITY,
  parseArgs,
  parseSuiteResult,
  normalizeFinding,
  groundFinding,
  dedupeFindings,
  blockerTestAsserted,
  groundAll,
  applyDemotions,
  unitCoverage,
  probeFindings,
  computeVerdict,
  renderTerminal,
  synthesize,
} from '../release-audit-synthesize.mjs';

const PASSING_TEST = { user_hits_it: true, needs_another_release: true, worse_than_status_quo: true };

function finding(over = {}) {
  return normalizeFinding({
    bucket: 'BLOCKER',
    klass: 'false-green',
    title: 'gate exits 0 on malformed input',
    body: 'the guard filters truthy-malformed votes',
    file: 'scripts/release-audit-synthesize.mjs',
    line: 1,
    evidence: 'export const BUCKETS',
    consequence: 'a real blocker is dropped',
    recommendation: 'fail closed',
    blocker_test: PASSING_TEST,
    ...over,
  }, over.unit ?? 'pkg:core');
}

const CLEAN_INPUT = {
  version: '1.11.0',
  since: 'v1.10.0',
  units: [{ id: 'pkg:core' }],
  probes: { versionDrift: [], publishMetadata: [], hostDiscoveryNearMisses: [], unconsultable: [] },
  filtered: false,
};
const FULL_REPORTS = [
  { unit: 'pkg:core', files_examined: ['packages/core/lib/glob.mjs'], findings: [], issue_verdicts: [] },
  ...expectedSuiteUnits(CLEAN_INPUT).map((u) => ({ unit: u, files_examined: ['README.md'], findings: [], issue_verdicts: [] })),
];

test('expectedSuiteUnits names the three fixed agents plus one shard per issue batch', () => {
  assert.deepEqual(expectedSuiteUnits({ issues: { sweepBatches: [[], [], []] } }),
    [...SUITE_UNITS, 'suite:issues:1', 'suite:issues:2', 'suite:issues:3']);
});

test('expectedSuiteUnits still expects one sweep shard when there are no issues at all', () => {
  // Coverage must have something to expect, or a run with an empty backlog would
  // silently stop checking that the sweep ran.
  assert.deepEqual(expectedSuiteUnits({}), [...SUITE_UNITS, 'suite:issues:1']);
});

test('parseArgs reads every path flag', () => {
  const a = parseArgs(['--input', 'i.json', '--reports', 'r.json', '--suite', 's.log', '--json', 'o.json']);
  assert.deepEqual(a, { input: 'i.json', reports: 'r.json', suite: 's.log', json: 'o.json' });
});

test('parseSuiteResult reads run-tests summary line', () => {
  const r = parseSuiteResult('noise\n═══ 54/54 segments passed\n  all green\n');
  assert.equal(r.ran, true);
  assert.equal(r.green, true);
  assert.equal(r.passed, 54);
  assert.equal(r.total, 54);
});

test('parseSuiteResult reports a red suite with the failing segment names', () => {
  const r = parseSuiteResult('═══ 52/54 segments passed\n  FAILED  packages/core (exit 1)\n  FAILED  cursor (exit 1)\n');
  assert.equal(r.ran, true);
  assert.equal(r.green, false);
  assert.deepEqual(r.failed, ['packages/core (exit 1)', 'cursor (exit 1)']);
});

test('parseSuiteResult treats a log with NO summary line as not-run, never as green', () => {
  // A suite killed before it printed a summary must not read as a pass just
  // because the word FAILED never appeared.
  const r = parseSuiteResult('running tests...\nsegment 1 ok\nsegment 2 ok\n');
  assert.equal(r.ran, false);
  assert.equal(r.green, false);
  assert.match(r.reason, /no summary line/);
});

test('normalizeFinding defaults an unknown bucket to the least severe one', () => {
  assert.equal(normalizeFinding({ bucket: 'CATASTROPHIC' }, 'pkg:x').bucket, 'BACKLOG');
  assert.equal(normalizeFinding({}, 'pkg:x').bucket, 'BACKLOG');
});

test('normalizeFinding keeps each declared bucket', () => {
  for (const b of BUCKETS) assert.equal(normalizeFinding({ bucket: b }, 'pkg:x').bucket, b);
});

test('groundFinding accepts evidence that really occurs in the cited file', () => {
  const g = groundFinding(finding());
  assert.equal(g.grounded, true);
  assert.equal(g.reason, null);
});

test('groundFinding tolerates whitespace differences from a JSON round-trip', () => {
  const g = groundFinding(finding({ evidence: '  export   const\n  BUCKETS ' }));
  assert.equal(g.grounded, true);
});

test('groundFinding rejects fabricated evidence', () => {
  const g = groundFinding(finding({ evidence: 'this string is nowhere in that file at all' }));
  assert.equal(g.grounded, false);
  assert.match(g.reason, /does not appear/);
});

test('groundFinding refuses to read a path that escapes the repository', () => {
  // finding.file is model-authored, so it is untrusted input to a file read.
  // Grounding must never become an arbitrary-file probe.
  const g = groundFinding(finding({ file: '../../../../../../etc/passwd', evidence: 'root' }));
  assert.equal(g.grounded, false);
  assert.match(g.reason, /outside the repository/);
});

test('groundFinding rejects a missing file, an absent file and empty evidence', () => {
  assert.match(groundFinding(finding({ file: null })).reason, /no file cited/);
  assert.match(groundFinding(finding({ file: 'scripts/does-not-exist.mjs' })).reason, /does not exist/);
    assert.match(groundFinding(finding({ evidence: '   ' })).reason, /no evidence quoted/);
});

test('dedupeFindings collapses the same defect and counts the duplicates', () => {
  const out = dedupeFindings([finding(), finding(), finding({ title: 'something else' })]);
  assert.equal(out.length, 2);
  assert.equal(out[0].duplicates, 1);
});

test('dedupeFindings keeps the MOST severe reading of one defect', () => {
  const out = dedupeFindings([finding({ bucket: 'BACKLOG' }), finding({ bucket: 'BLOCKER' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].bucket, 'BLOCKER');
});

test('dedupeFindings survivor prefers the copy whose evidence checks out', () => {
  // Two agents find the same defect; one quotes it verbatim, one paraphrases.
  // Arrival order must not decide whether the defect keeps its blocker status.
  const paraphrased = { ...finding(), evidence: 'a paraphrase that is not in the file' };
  const verbatim = finding();
  const [merged] = dedupeFindings(groundAll([paraphrased, verbatim]));
  assert.equal(merged.grounded, true);
  assert.equal(merged.evidence, verbatim.evidence);
  assert.equal(applyDemotions([merged])[0].bucket, 'BLOCKER');
});

test('dedupeFindings does not let one refuted copy refute the defect', () => {
  const [merged] = dedupeFindings(groundAll([{ ...finding(), refuted: true }, finding()]));
  assert.equal(merged.refuted, false);
});

test('blockerTestAsserted requires all three booleans to be exactly true', () => {
  assert.equal(blockerTestAsserted(PASSING_TEST), true);
  assert.equal(blockerTestAsserted(null), false);
  assert.equal(blockerTestAsserted({ ...PASSING_TEST, user_hits_it: false }), false);
  assert.equal(blockerTestAsserted({ ...PASSING_TEST, needs_another_release: 'yes' }), false);
});

test('dedupeFindings carries the blocker test with an upgraded severity', () => {
  // Two agents find the SAME defect. One rates it SHOULD-FIX and fills in no
  // blocker test; the other rates it BLOCKER and asserts all three. Merging must
  // not let the lower-severity copy strip the justification off the higher one —
  // that demoted a real release blocker precisely BECAUSE two agents found it.
  const shouldFix = finding({ bucket: 'SHOULD-FIX', blocker_test: null });
  const blocker = finding({ bucket: 'BLOCKER' });
  const [merged] = applyDemotions(dedupeFindings(groundAll([shouldFix, blocker])));
  assert.equal(merged.bucket, 'BLOCKER');
  assert.deepEqual(merged.demotions, []);
});

test('dedupeFindings adopts a blocker test even when the buckets already agree', () => {
  const bare = finding({ blocker_test: null });
  const asserted = finding();
  const [merged] = dedupeFindings(groundAll([bare, asserted]));
  assert.equal(blockerTestAsserted(merged.blockerTest), true);
});

test('dedupeFindings does not let a lower-severity copy overwrite a supported claim', () => {
  const blocker = finding();
  const shouldFix = finding({ bucket: 'SHOULD-FIX', blocker_test: null });
  const [merged] = applyDemotions(dedupeFindings(groundAll([blocker, shouldFix])));
  assert.equal(merged.bucket, 'BLOCKER');
});

test('dedupeFindings keeps findings in different units apart', () => {
  const out = dedupeFindings([finding({ unit: 'pkg:core' }), finding({ unit: 'pkg:cli' })]);
  assert.equal(out.length, 2);
});

test('applyDemotions keeps a fully-grounded, unrefuted, fully-asserted blocker', () => {
  const [f] = applyDemotions([finding()]);
  assert.equal(f.bucket, 'BLOCKER');
  assert.equal(f.grounded, true);
  assert.deepEqual(f.demotions, []);
});

test('applyDemotions demotes — never deletes — an ungrounded blocker', () => {
  const out = applyDemotions([finding({ evidence: 'not in the file' })]);
  assert.equal(out.length, 1, 'the finding must still be reported');
  assert.equal(out[0].bucket, 'SHOULD-FIX');
  assert.equal(out[0].originalBucket, 'BLOCKER');
  assert.match(out[0].demotions.join(' '), /ungrounded/);
});

test('applyDemotions demotes a refuted blocker and says so', () => {
  const out = applyDemotions([finding({ refuted: true })]);
  assert.equal(out[0].bucket, 'SHOULD-FIX');
  assert.match(out[0].demotions.join(' '), /refuted/);
});

test('applyDemotions demotes a blocker from a hollow unit', () => {
  const out = applyDemotions([finding()], { hollowUnits: new Set(['pkg:core']) });
  assert.equal(out[0].bucket, 'SHOULD-FIX');
  assert.match(out[0].demotions.join(' '), /examined no files/);
});

test('applyDemotions demotes a blocker whose three-part blocker test is not fully asserted', () => {
  for (const missing of ['user_hits_it', 'needs_another_release', 'worse_than_status_quo']) {
    const t = { ...PASSING_TEST, [missing]: false };
    const out = applyDemotions([finding({ blocker_test: t })]);
    assert.equal(out[0].bucket, 'SHOULD-FIX', `${missing}=false must not block a release`);
    assert.match(out[0].demotions.join(' '), /blocker test not fully asserted/);
  }
});

test('applyDemotions demotes a blocker with no blocker_test at all', () => {
  const out = applyDemotions([finding({ blocker_test: null })]);
  assert.equal(out[0].bucket, 'SHOULD-FIX');
});

test('applyDemotions does not touch a non-blocker', () => {
  const out = applyDemotions([finding({ bucket: 'SHOULD-FIX', evidence: 'nowhere' })]);
  assert.equal(out[0].bucket, 'SHOULD-FIX');
});

test('unitCoverage separates audited, hollow and missing artifacts', () => {
  const c = unitCoverage(
    [
      { unit: 'pkg:a', files_examined: ['x.mjs'] },
      { unit: 'pkg:b', files_examined: [] },
    ],
    ['pkg:a', 'pkg:b', 'pkg:c'],
  );
  assert.deepEqual(c.audited, ['pkg:a']);
  assert.deepEqual(c.hollow, ['pkg:b']);
  assert.deepEqual(c.missing, ['pkg:c']);
});

test('unitCoverage accepts either spelling of files_examined', () => {
  const c = unitCoverage([{ unit: 'pkg:a', filesExamined: ['x'] }], ['pkg:a']);
  assert.deepEqual(c.audited, ['pkg:a']);
});

test('probeFindings blocks on publish metadata and near-misses, not on pre-bump version drift', () => {
  const out = probeFindings({
    publishMetadata: ['@adlc/x: repository.url is null'],
    hostDiscoveryNearMisses: ['.foo-plugin/plugin.json invisible'],
    versionDrift: ['packages/y: 9.9.9 != 1.10.0'],
  });
  assert.equal(out.length, 3);
  assert.equal(out.filter((f) => f.bucket === 'BLOCKER').length, 2);
  const drift = out.find((f) => f.klass === 'probe:versionDrift');
  assert.equal(drift.bucket, 'SHOULD-FIX');
  assert.equal(PROBE_SEVERITY.versionDrift, 'SHOULD-FIX');
});

test('probeFindings marks probe results as mechanical and pre-grounded', () => {
  const [f] = probeFindings({ publishMetadata: ['x'] });
  assert.equal(f.mechanical, true);
  assert.equal(f.grounded, true);
  assert.equal(f.unit, 'suite:mechanical');
});

test('computeVerdict returns GO only when everything checked out', () => {
  const v = computeVerdict({
    findings: [],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: [] },
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(v.verdict, 'GO');
});

test('computeVerdict returns NO-GO on a red suite even with zero findings', () => {
  const v = computeVerdict({
    findings: [],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: [] },
    suite: { ran: true, green: false, failed: ['packages/core'] },
  });
  assert.equal(v.verdict, 'NO-GO');
  assert.match(v.reasons.join(' '), /test suite is red/);
});

test('computeVerdict returns NO-GO on a surviving blocker', () => {
  const v = computeVerdict({
    findings: [finding()],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: [] },
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(v.verdict, 'NO-GO');
});

test('computeVerdict returns NO-GO when a shipped artifact produced no report', () => {
  // "Could not check" must never render as "verified".
  const v = computeVerdict({
    findings: [],
    coverage: { audited: ['pkg:core'], hollow: [], missing: ['plugin:adlc-pi'] },
    probes: { unconsultable: [] },
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(v.verdict, 'NO-GO');
  assert.match(v.reasons.join(' '), /no audit report/);
});

test('computeVerdict returns NO-GO when a report examined no files', () => {
  const v = computeVerdict({
    findings: [],
    coverage: { audited: [], hollow: ['pkg:core'], missing: [] },
    probes: { unconsultable: [] },
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(v.verdict, 'NO-GO');
  assert.match(v.reasons.join(' '), /examined no files/);
});

test('computeVerdict refuses to reach GO when no suite result was supplied at all', () => {
  // Omitting --suite is the cheapest possible way to defeat the gate, so an absent
  // result is the same epistemic state as a suite that did not run.
  const v = computeVerdict({
    findings: [],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: [] },
    suite: null,
  });
  assert.equal(v.verdict, 'NO-GO');
  assert.match(v.reasons.join(' '), /no test suite result was supplied/);
});

test('computeVerdict names an untriaged backlog rather than reading it as "no issues"', () => {
  const v = computeVerdict({
    findings: [],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: [] },
    suite: { ran: true, green: true, failed: [] },
    issues: { unconsultable: 'gh issue list failed: not authenticated' },
  });
  assert.equal(v.verdict, 'GO-WITH-RISK');
  assert.match(v.reasons.join(' '), /GitHub issues were not triaged/);
});

test('computeVerdict reports a truncated issue fetch', () => {
  const v = computeVerdict({
    findings: [],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: [] },
    suite: { ran: true, green: true, failed: [] },
    issues: { truncated: 500 },
  });
  assert.equal(v.verdict, 'GO-WITH-RISK');
  assert.match(v.reasons.join(' '), /hit its fetch limit/);
});

test('computeVerdict returns NO-GO when the suite result was never captured', () => {
  const v = computeVerdict({
    findings: [],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: [] },
    suite: { ran: false, green: false, failed: [] },
  });
  assert.equal(v.verdict, 'NO-GO');
});

test('computeVerdict returns GO-WITH-RISK for should-fix items and unconsultable probes', () => {
  const v = computeVerdict({
    findings: [finding({ bucket: 'SHOULD-FIX' })],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: ['gh issue list failed'] },
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(v.verdict, 'GO-WITH-RISK');
  assert.match(v.reasons.join(' '), /should-fix/);
  assert.match(v.reasons.join(' '), /could not run/);
});

test('computeVerdict never returns GO for a partial (--packages) run', () => {
  const v = computeVerdict({
    findings: [],
    coverage: { audited: ['pkg:core'], hollow: [], missing: [] },
    probes: { unconsultable: [] },
    suite: { ran: true, green: true, failed: [] },
    partial: true,
  });
  assert.equal(v.verdict, 'GO-WITH-RISK');
  assert.match(v.reasons.join(' '), /partial audit/);
});

test('synthesize end-to-end: a clean suite-wide run is GO', () => {
  const r = synthesize({
    input: CLEAN_INPUT,
    reports: FULL_REPORTS,
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(r.verdict.verdict, 'GO');
  assert.equal(r.coverage.missing.length, 0);
  assert.equal(r.findings.length, 0);
});

test('synthesize expects the suite agents, so omitting them is NO-GO', () => {
  const r = synthesize({
    input: CLEAN_INPUT,
    reports: [FULL_REPORTS[0]],
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(r.verdict.verdict, 'NO-GO');
  for (const u of expectedSuiteUnits(CLEAN_INPUT)) assert.ok(r.coverage.missing.includes(u));
});

test('synthesize does not expect the suite agents on a filtered run', () => {
  const r = synthesize({
    input: { ...CLEAN_INPUT, filtered: true },
    reports: [FULL_REPORTS[0]],
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(r.coverage.missing.length, 0);
  assert.equal(r.partial, true);
  assert.equal(r.verdict.verdict, 'GO-WITH-RISK');
});

test('synthesize surfaces a mechanical probe blocker with no agent involved', () => {
  const r = synthesize({
    input: { ...CLEAN_INPUT, probes: { ...CLEAN_INPUT.probes, publishMetadata: ['@adlc/x: repository.url is null'] } },
    reports: FULL_REPORTS,
    suite: { ran: true, green: true, failed: [] },
  });
  assert.equal(r.verdict.verdict, 'NO-GO');
  assert.equal(r.findings.filter((f) => f.bucket === 'BLOCKER').length, 1);
});

test('synthesize collects issue verdicts from every report', () => {
  const reports = FULL_REPORTS.map((r, i) => (i === 0
    ? { ...r, issue_verdicts: [{ number: 42, verdict: 'already-fixed-close-it', rationale: 'guarded at line 9' }] }
    : r));
  const r = synthesize({ input: CLEAN_INPUT, reports, suite: { ran: true, green: true, failed: [] } });
  assert.equal(r.issueVerdicts.length, 1);
  assert.equal(r.issueVerdicts[0].unit, 'pkg:core');
  assert.equal(r.issueVerdicts[0].number, 42);
});

test('renderTerminal names the verdict, the blockers and the demotions', () => {
  const r = synthesize({
    input: CLEAN_INPUT,
    reports: FULL_REPORTS.map((x, i) => (i === 0
      ? { ...x, findings: [{ ...finding(), title: 'fabricated claim', evidence: 'nowhere at all' }, finding()] }
      : x)),
    suite: { ran: true, green: true, failed: [] },
  });
  const text = renderTerminal(r);
  assert.match(text, /VERDICT: NO-GO/);
  assert.match(text, /BLOCKERS/);
  assert.match(text, /DEMOTED FROM BLOCKER/);
  assert.match(text, /ungrounded/);
});

test('every suite-level agent is named in the coverage contract', () => {
  // Spelled out rather than derived: dropping one of these from SUITE_UNITS would
  // silently stop requiring that agent to report, and an unaudited surface would
  // pass as GO. The list IS the contract, so the test states it.
  assert.deepEqual(expectedSuiteUnits({ issues: { sweepBatches: [[]] } }),
    ['suite:drift', 'suite:docs', 'suite:supply', 'suite:issues:1']);
});

test('dropping any single suite agent from a run forces NO-GO', () => {
  for (const omitted of ['suite:drift', 'suite:docs', 'suite:supply']) {
    const r = synthesize({
      input: CLEAN_INPUT,
      reports: FULL_REPORTS.filter((x) => x.unit !== omitted),
      suite: { ran: true, green: true, failed: [] },
    });
    assert.equal(r.verdict.verdict, 'NO-GO', `${omitted} going missing must block the release`);
    assert.ok(r.coverage.missing.includes(omitted));
  }
});

test('BUCKETS lists exactly the three severities the report renders', () => {
  assert.deepEqual(BUCKETS, ['BLOCKER', 'SHOULD-FIX', 'BACKLOG']);
});
