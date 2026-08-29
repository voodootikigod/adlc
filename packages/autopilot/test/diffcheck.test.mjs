// AC 34 / 55 / 76 / 98 / 100 / 140 (diff halves) — the actual-diff check over
// REAL temporary git repositories: scope, protected paths, the ticket
// snapshot, the criteria document, append-only + orchestrator-owned manifest
// lines with the real chain verifier behind the key-bearing `gate-manifest
// verify` spawn, symlink escape, and the fail-closed secret scan.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, ticketFilename } from '@adlc/tickets';
import { signEntry } from '@adlc/gate-manifest/lib/sign.mjs';
import { verifyChain } from '@adlc/gate-manifest/lib/verify.mjs';
import { readRawLines } from '@adlc/gate-manifest/lib/forest.mjs';
import {
  actualDiffCheck, canonicalTicketSha256, manifestLineSha256, sha256, criteriaDocPath, describeSecretHits, scanAddedLinesForSecrets,
} from '../lib/diffcheck.mjs';
import { SECRET_PATTERNS } from '../lib/redact.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { makeCtx, TEST_KEY } from './helpers/gates-ctx.mjs';
import { makeRepo, addIssueWorktree, writeFiles, commitAll, git } from './helpers/gates-fixture.mjs';

/** One added-line sample per SECRET_PATTERNS name (kept local: importing redact.test.mjs would register its tests twice). */
const SAMPLES = {
  'AWS access key ID': 'AKIA' + 'ABCDEFGHIJKLMNOP',
  'Private key (PEM)': '-----BEGIN RSA PRIVATE KEY-----',
  'OpenAI/Anthropic-style key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
  'GitHub token': 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0' + 'K1l2M3n4O5p6Q7r8S9t0',
  'Slack token': 'xoxb-1234567890-abcdefghij',
  'Google API key': 'AIza' + 'A'.repeat(35),
  JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  'Hardcoded credential assignment': 'api_key = "abcdefghijklmnopqrstuvwxyz"',
  'ADLC manifest key': 'ADLC_MANIFEST_KEY=0123456789abcdef0123456789abcdef',
  'env secret assignment': 'FOO_TOKEN=plainvalue123',
  'Bearer token': 'Bearer abcdefghijklmnopqrstuvwxyz0123',
};

const ISSUE = 7;
const TICKET = 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH';
const SCOPE = ['packages/foo/**'];
const SEGMENT = '.adlc/manifest.d/chore-fixture-01M0Z3FN7SAS4HAH7CS63YQ0DH.jsonl';

const signed = (entry, key = TEST_KEY) => JSON.stringify({ ...entry, sig: signEntry(key, entry) });
const line1 = signed({ seq: 1, gate: 'spec-lint', ts: '2026-08-28T00:00:00.000Z', ticket: TICKET, data: {}, files: {}, prev: null, sigVersion: 2 });
const line2 = signed({ seq: 2, gate: 'ticket-create', ts: '2026-08-28T00:01:00.000Z', ticket: TICKET, data: { run: 1 }, files: {}, prev: sha256(line1), sigVersion: 2 });
const TICKET_DOC = { id: TICKET, title: 'fixture', body: 'GitHub issue: https://x\n\n=== ACCEPTANCE CRITERIA ===\n- AC1', scope: SCOPE, rails: ['packages/foo/test/**'], category: 'feature', duration: 2, edges: [], budget: 'direct' };
const shardPath = (doc) => `.adlc/tickets/${ticketFilename(doc.id)}`;
const shardText = (doc) => JSON.stringify(doc, Object.keys(doc).sort(), 2) + '\n';
const CRITERIA = '## Acceptance criteria\n- AC1: it works. VERIFY: run the tests.\n';

/** The REAL chain verifier behind the fake `adlc gate-manifest verify` spawn (keyed exactly as the bin: from its env). */
function adlcVerifyHandler(args, { env }) {
  if (args[0] !== 'gate-manifest' || args[1] !== 'verify') return { status: 1, stderr: 'unexpected adlc argv' };
  const dir = args[args.indexOf('--dir') + 1];
  const key = env.ADLC_MANIFEST_KEY ?? null;
  const r = verifyChain(readRawLines(join(dir, 'manifest.d', SEGMENT.split('/').pop())), { key, requireSignatures: false, anchorOnFirst: false });
  return { status: r.valid ? 0 : 1, stdout: r.message };
}

function fixture() {
  const { root, baseOid } = makeRepo({ files: {
    'packages/foo/lib/a.mjs': 'export const a = 1;\n', 'packages/foo/test/a.test.mjs': 'test\n',
    'scripts/rails-guard-ci.mjs': 'orig\n', 'scripts/preflight.mjs': 'orig\n', 'scripts/toolkit-floor.json': '{}\n',
    [SEGMENT]: `${line1}\n`, '.adlc/findings.jsonl': '',
  } });
  const ctx = makeCtx({ repoRoot: root, handlers: { '/fake/adlc': adlcVerifyHandler }, baseOid });
  const wt = addIssueWorktree(root, ctx.paths.issueWorktree(ISSUE), ISSUE, baseOid);
  const record = { issue: ISSUE, ticketSnapshotSha256: canonicalTicketSha256(TICKET_DOC), criteriaDocSha256: sha256(CRITERIA), manifestLinesWritten: [manifestLineSha256(line2)] };
  const reset = () => git(wt, ['reset', '-q', '--hard', baseOid]);
  const commit = (files, msg = 'worker') => { reset(); writeFiles(wt, files); return commitAll(wt, msg); };
  const check = (head, over = {}) => actualDiffCheck({ ctx, issue: ISSUE, record, baseOid, head, scope: SCOPE, ticketId: TICKET, ...over });
  return { root, baseOid, ctx, wt, record, commit, check, reset, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function ac34_actualDiffCheckScopeManifestSymlink() {
  const f = fixture();
  try {
    const a = await f.check(f.commit({ 'packages/foo/lib/a.mjs': 'export const a = 2;\n', 'scripts/rails-guard-ci.mjs': 'edited\n' }));
    assert.equal(a.ok, false); assert.ok(a.paths.includes('scripts/rails-guard-ci.mjs'), 'the trust-root path is named'); assert.equal(a.code, 'protected-path');
    const b = await f.check(f.commit({ [SEGMENT]: '' }));
    assert.equal(b.ok, false); assert.equal(b.code, 'manifest-line-removed', 'a removed manifest line is a violation');
    const c = await f.check(f.commit({ 'packages/foo/lib/a.mjs': 'export const a = 3;\n', [shardPath(TICKET_DOC)]: shardText(TICKET_DOC), [SEGMENT]: `${line1}\n${line2}\n` }));
    assert.deepEqual({ ok: c.ok, code: c.code, paths: c.paths }, { ok: true, code: null, paths: [] }, 'scope + one shard + appended orchestrator lines pass');
    f.reset(); mkdirSync(join(f.wt, 'packages/foo/lib'), { recursive: true }); symlinkSync('../../../scripts/rails-guard-ci.mjs', join(f.wt, 'packages/foo/lib/link.mjs'));
    const d = await f.check(commitAll(f.wt, 'symlink'));
    assert.equal(d.ok, false); assert.equal(d.code, 'symlink-escape'); assert.deepEqual(d.paths, ['packages/foo/lib/link.mjs']);
    f.reset(); mkdirSync(join(f.wt, 'packages/foo/lib'), { recursive: true }); symlinkSync('./a.mjs', join(f.wt, 'packages/foo/lib/inside.mjs'));
    assert.equal((await f.check(commitAll(f.wt, 'symlink-inside'))).ok, true, 'a symlink whose target stays inside the scope passes');
  } finally { f.cleanup(); }
}
test('AC34: a trust-root edit outside scope, a removed manifest line and an escaping symlink each fail the actual-diff check by name; scope + one shard + appended lines pass', ac34_actualDiffCheckScopeManifestSymlink);

export async function ac55_ticketSnapshot() {
  const f = fixture();
  try {
    const shard = (doc) => ({ [shardPath(doc)]: shardText(doc), [SEGMENT]: `${line1}\n${line2}\n` });
    for (const [what, doc] of [['scope widened', { ...TICKET_DOC, scope: [...SCOPE, 'scripts/**'] }], ['rail removed', { ...TICKET_DOC, rails: [] }], ['body edited', { ...TICKET_DOC, body: 'GitHub issue: https://x\n\n=== ACCEPTANCE CRITERIA ===\n- AC1 weakened' }]]) {
      const r = await f.check(f.commit(shard(doc)));
      assert.equal(r.ok, false, what); assert.equal(r.code, 'ticket-shard-mismatch', what); assert.ok(r.paths[0].startsWith('.adlc/tickets/t-01m0z3fn7sas4hah7cs63yq0dh--'), `${what}: the shard is named`);
    }
    for (const completed of [true, false]) {
      const r = await f.check(f.commit(shard({ ...TICKET_DOC, completed })));
      assert.equal(r.ok, true, `completed:${completed} only → pass`);
    }
    const two = await f.check(f.commit({ ...shard({ ...TICKET_DOC, completed: true }), [shardPath({ ...TICKET_DOC, id: 'T-01M0Z3FN7SAS4HAH7CS63YQ0DJ' })]: shardText({ ...TICKET_DOC, id: 'T-01M0Z3FN7SAS4HAH7CS63YQ0DJ' }) }));
    assert.equal(two.ok, false, 'a second shard (another ticket) is a violation'); assert.equal(two.code, 'protected-path');
    assert.equal(f.record.ticketSnapshotSha256, sha256(canonicalJson((({ completed: _c, ...rest }) => rest)({ ...TICKET_DOC, completed: true }))), 'the recorded hash is sha256 of the canonicalized shard without completed');
  } finally { f.cleanup(); }
}
test('AC55: a shard with a widened scope, a dropped rail or an edited body fails naming the shard; a completed toggle alone passes; the recorded hash is the canonical shard hash', ac55_ticketSnapshot);

export async function ac76_secretScanFailClosed() {
  const f = fixture();
  try {
    const names = SECRET_PATTERNS.map((p) => p.name);
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...names].sort(), 'one fixture per pattern name');
    for (const name of names) {
      const sample = SAMPLES[name].replace(/^\n/, '');
      const file = name === 'Private key (PEM)' ? 'packages/foo/test/key.test.mjs' : name === 'AWS access key ID' ? shardPath(TICKET_DOC) : 'packages/foo/lib/cfg.mjs';
      const content = file.endsWith('.json') ? shardText({ ...TICKET_DOC, body: `GitHub issue: https://x ${sample}` }) : `// fixture\n${sample}\n`;
      const r = await f.check(f.commit({ [file]: content }));
      assert.equal(r.code, 'secret-in-diff', name); assert.equal(r.ok, false);
      assert.ok(r.secretHits.some((h) => h.pattern === name && h.file === file && Number.isInteger(h.line) && h.line > 0), `${name}: hit names the pattern and ${file}:line`);
      assert.ok(!JSON.stringify(r).includes(sample), `${name}: the matched text never appears in the result`);
      assert.ok(!describeSecretHits(r.secretHits).includes(sample) && describeSecretHits(r.secretHits).includes(`${name} at ${file}:`), `${name}: the comment text carries name + file:line only`);
    }
    const lit = await f.check(f.commit({ 'packages/foo/lib/cfg.mjs': `export const k = '${TEST_KEY}';\n` }));
    assert.equal(lit.code, 'secret-in-diff'); assert.equal(lit.secretHits[0].pattern, 'orchestrator secret value'); assert.ok(!JSON.stringify(lit).includes(TEST_KEY));
    assert.equal(f.ctx.recorder.filter((s) => s.argv[0] === '/fake/adlc').length, 0, 'no adlc / push / dispatch spawn follows a secret hit');
    assert.equal(f.ctx.recorder.filter((s) => s.argv.includes('push')).length, 0);
    assert.equal(scanAddedLinesForSecrets('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-ghp_' + 'A'.repeat(40) + '\n+clean\n').length, 0, 'a REMOVED secret line is not a hit');
  } finally { f.cleanup(); }
}
test('AC76: every SECRET_PATTERNS entry (PEM in a test file, a key inside the ticket shard) and the literal orchestrator key value → secret-in-diff naming only the pattern and file:line, with no further spawn', ac76_secretScanFailClosed);

export async function ac98_criteriaDocTracked() {
  const f = fixture();
  try {
    const ok = await f.check(f.commit({ [criteriaDocPath(TICKET)]: CRITERIA, 'packages/foo/lib/a.mjs': 'x\n' }));
    assert.equal(ok.ok, true, 'exactly the recorded criteria document is accepted');
    assert.equal(criteriaDocPath(TICKET), `.adlc/specs/${TICKET}-ac.md`);
    const second = await f.check(f.commit({ [criteriaDocPath(TICKET)]: CRITERIA, '.adlc/specs/T-01M0Z3FN7SAS4HAH7CS63YQ0DJ-ac.md': CRITERIA }));
    assert.equal(second.ok, false); assert.deepEqual(second.paths, ['.adlc/specs/T-01M0Z3FN7SAS4HAH7CS63YQ0DJ-ac.md']);
    const modified = await f.check(f.commit({ [criteriaDocPath(TICKET)]: CRITERIA + '- AC2: weakened\n' }));
    assert.equal(modified.ok, false); assert.equal(modified.code, 'criteria-doc-mismatch'); assert.deepEqual(modified.paths, [criteriaDocPath(TICKET)]);
  } finally { f.cleanup(); }
}
test('AC98: the actual-diff check accepts exactly the one recorded criteria document and rejects a second or a modified one', ac98_criteriaDocTracked);

export async function ac100_foreignManifestLines() {
  const f = fixture();
  try {
    const foreign = signed({ seq: 2, gate: 'cross-model-review', ts: '2026-08-28T00:02:00.000Z', ticket: TICKET, data: { verdict: 'approve' }, files: {}, prev: sha256(line1), sigVersion: 2 });
    const a = await f.check(f.commit({ [SEGMENT]: `${line1}\n${foreign}\n` }));
    assert.equal(a.code, 'foreign-manifest-line', 'an appended line outside the orchestrator-written set');
    const forged = JSON.stringify({ ...JSON.parse(line2), sig: 'f'.repeat(64) });
    const b = await f.check(f.commit({ [SEGMENT]: `${line1}\n${forged}\n` }), { record: { ...f.record, manifestLinesWritten: [manifestLineSha256(forged)] } });
    assert.equal(b.ok, false); assert.equal(b.code, 'manifest-verify-failed', 'a line with an invalid signature makes the real verifier exit non-zero');
    const unsigned = JSON.stringify((({ sig: _s, ...rest }) => rest)(JSON.parse(line2)));
    const c = await f.check(f.commit({ [SEGMENT]: `${line1}\n${unsigned}\n` }), { record: { ...f.record, manifestLinesWritten: [manifestLineSha256(unsigned)] } });
    assert.equal(c.ok, false); assert.equal(c.violations[0].code, 'run-entry-unsigned');
    const ok = await f.check(f.commit({ [SEGMENT]: `${line1}\n${line2}\n` }));
    assert.equal(ok.ok, true, "the orchestrator's own signed append passes");
    const verifies = f.ctx.recorder.filter((s) => s.argv[0] === '/fake/adlc');
    assert.ok(verifies.length >= 3, 'gate-manifest verify was spawned for the manifest diffs');
    for (const v of verifies) {
      assert.deepEqual(v.argv.slice(1), ['gate-manifest', 'verify', '--dir', join(f.wt, '.adlc'), '--allow-legacy-unsigned']);
      assert.equal(v.env.ADLC_MANIFEST_KEY, TEST_KEY, 'verify is key-bearing');
    }
    assert.equal(f.ctx.recorder.filter((s) => s.argv[0] === f.ctx.pinned.git).every((s) => s.env.ADLC_MANIFEST_KEY === undefined), true, 'no git spawn carries the key');
  } finally { f.cleanup(); }
}
test('AC100: a foreign manifest line → foreign-manifest-line, an invalid signature fails the key-bearing verify, an unsigned run entry → run-entry-unsigned, the orchestrator\'s own signed appends pass', ac100_foreignManifestLines);

export async function ac140_denylistInDiffCheck() {
  const f = fixture();
  try {
    for (const path of ['scripts/preflight.mjs', 'scripts/toolkit-floor.json']) {
      const r = await f.check(f.commit({ [path]: 'edited\n', 'packages/foo/lib/a.mjs': 'y\n' }));
      assert.equal(r.ok, false, path); assert.equal(r.code, 'protected-path', path); assert.deepEqual(r.paths, [path]);
    }
    const inScope = await f.check(f.commit({ 'packages/foo/lib/b.mjs': 'export const b = 1;\n' }));
    assert.equal(inScope.ok, true);
    const findings = await f.check(f.commit({ '.adlc/findings.jsonl': '{"x":1}\n' }));
    assert.equal(findings.code, 'findings-ledger-written');
  } finally { f.cleanup(); }
}
test('AC140: a worker edit to scripts/preflight.mjs or scripts/toolkit-floor.json despite a packages/foo/** scope is a protected-path violation of the actual-diff check', ac140_denylistInDiffCheck);

// Mutation fixtures the registry names: each test fails under exactly one seam.
test('seam check: the AC34/55/98/100/140/76 tests fail under their registered seams', async () => {
  for (const [seam, fn] of [['diffcheck.skipManifestAppendOnly', ac34_actualDiffCheckScopeManifestSymlink], ['diffcheck.skipTicketSnapshot', ac55_ticketSnapshot], ['diffcheck.skipCriteriaHash', ac98_criteriaDocTracked], ['diffcheck.skipForeignLineCheck', ac100_foreignManifestLines], ['diffcheck.skipDenylist', ac140_denylistInDiffCheck], ['diffcheck.skipSecretScan', ac76_secretScanFailClosed]]) {
    await assert.rejects(() => withMutation(seam, fn), `${fn.name} must fail under ${seam}`);
  }
});

export async function ac76_binaryBlobsFailClosed() {
  const f = fixture();
  try {
    const blob = Buffer.concat([Buffer.from('PNG'), Buffer.from('AKIA' + 'ABCDEFGHIJKLMNOP'), Buffer.alloc(64, 0)]);
    const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
    const { join: j } = await import('node:path');
    f.reset(); mk(j(f.wt, 'packages', 'foo', 'lib'), { recursive: true }); wf(j(f.wt, 'packages', 'foo', 'lib', 'blob.bin'), blob);
    const head = commitAll(f.wt, 'binary');
    const r = await f.check(head);
    assert.equal(r.ok, false); assert.equal(r.code, 'binary-file', 'a binary addition cannot be secret-scanned → refused by name');
    assert.ok(r.paths.includes('packages/foo/lib/blob.bin'));
    const allowed = await withMutation('diffcheck.allowBinary', () => f.check(head));
    assert.equal(allowed.ok, true, 'the seam lets the blob through — the fixture bites');
  } finally { f.cleanup(); }
}
test('AC76: a binary blob added in scope fails the actual-diff check closed (binary-file) — its bytes cannot be secret-scanned', ac76_binaryBlobsFailClosed);

export async function ac76_everySecretLiteralIsScanned() {
  // The actual-diff secret scan receives EVERY key-bearing literal the context knows (not only the manifest key).
  const f = fixture();
  try {
    const token = 'plain-credential-value-0123456789abcdef';       // matches no SECRET_PATTERN: only the literal list can catch it
    f.ctx.secretValues = [f.ctx.key, token];
    const hit = await f.check(f.commit({ 'packages/foo/lib/a.mjs': `export const a = '${token}';\n` }));
    assert.equal(hit.code, 'secret-in-diff', JSON.stringify(hit));
    assert.ok(hit.secretHits.some((h) => h.pattern === 'orchestrator secret value'), 'the hit names the literal class');
    assert.ok(!JSON.stringify(hit).includes(token), 'the literal itself never appears in the result');
  } finally { f.cleanup(); }
  // The production wiring: buildContext exposes the same literal set the redactor uses (credential token included).
  const { createSequenceFixture } = await import('./helpers/sequence-fixture.mjs');
  const fx = await createSequenceFixture();
  try { assert.ok(Array.isArray(fx.ctx.secretValues) && fx.ctx.secretValues.includes('fake-access-token'), 'the credential token is in ctx.secretValues'); }
  finally { fx.cleanup(); }
}
test('AC76: the actual-diff secret scan covers every orchestrator secret literal (credential token included), never only the manifest key', { timeout: 120_000 }, ac76_everySecretLiteralIsScanned);
