import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { artifactDigest, buildActionArtifact, entryBindsAction, gateAction, ledgerApproves } from '../lib/gate.mjs';
import { ledgerEntryBytes, signLedgerEntry } from '../lib/ledger-sig.mjs';
import { executeActions, renderComment } from '../lib/execute.mjs';
import { assertFloorNotWidened, assertFrozenPathsNotNarrowed, assertPolicyUnchanged } from '../lib/floor.mjs';
import { applyRun } from '../lib/apply.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const libDir = join(__dirname, '..', 'lib');
const binDir = join(__dirname, '..', 'bin');

const KEY = 'k'.repeat(32);
const CLOSE = { number: 705, action: 'close', contentHash: 'c0ffee', evidence: 'lib/a.mjs:2 no longer contains the cited line' };
const RELABEL = { number: 7, action: 'relabel', field: 'priority', from: 'P3-low', to: 'P2-medium', contentHash: 'abc', evidence: 'ev' };

test('golden: buildActionArtifact exact byte output for close and relabel', () => {
  assert.equal(
    buildActionArtifact(CLOSE),
    [
      '# Proposed close — issue #705',
      '- issue: #705',
      '- action: close',
      '- revision (contentHash): c0ffee',
      '## Evidence',
      'lib/a.mjs:2 no longer contains the cited line',
      '## What is being asked',
      'Is this close justified by the evidence above, for this issue, at this revision?',
      'A material objection means the action is demoted to a proposal for a human.',
    ].join('\n')
  );

  assert.equal(
    buildActionArtifact(RELABEL),
    [
      '# Proposed relabel — issue #7',
      '- issue: #7',
      '- action: relabel',
      '- revision (contentHash): abc',
      '- field: priority',
      '- from: P3-low',
      '- to: P2-medium',
      '## Evidence',
      'ev',
      '## What is being asked',
      'Is this relabel justified by the evidence above, for this issue, at this revision?',
      'A material objection means the action is demoted to a proposal for a human.',
    ].join('\n')
  );
});

test('golden: artifactDigest pinned for close, relabel, object evidence, and empty evidence', () => {
  assert.equal(artifactDigest(CLOSE), '6fe3dd4012c36b00c02d746012880747fe8b6f1b82ce40325ff8e3c9a09b4d81');
  assert.equal(artifactDigest(RELABEL), '0ce06d9b3e66388912443c2bbce435fda0875ff58b2238daad16418a2734a6ea');
  assert.equal(
    artifactDigest({ number: 9, action: 'close', contentHash: 'h', evidence: { a: 1, b: [2] } }),
    '688bf98854b1eb0af2442d958271b97b46f519eb5975c4de144f37584d675fb0'
  );
  assert.equal(
    artifactDigest({ number: 9, action: 'close', contentHash: 'h', evidence: '' }),
    'cbf08985fa43761f9856c7ea88ce1b670dd7fb73ec64da1796a8645dceabf406'
  );
});

test('golden: signLedgerEntry pins signature for close action', () => {
  const sig = signLedgerEntry(KEY, {
    verdict: 'approve',
    reason: null,
    reviewer: 'rev',
    decider: 'dec',
    contentHash: 'c0ffee',
    number: 705,
    action: 'close',
    field: null,
    artifactDigest: artifactDigest(CLOSE),
  });
  assert.equal(sig, '937aa5cb94d71cc4d9462dd2692e54c1cdfa64bb9422720440a3df3f4024bf7a');
});

test('golden: gateAction approved and reviewer throw recorded shapes and sigs', () => {
  {
    const ledger = {};
    const res = gateAction({
      action: CLOSE,
      profile: { providers: { decider: 'dec', reviewer: 'rev' } },
      ledger,
      runReview: () => ({ code: 0 }),
      key: KEY,
    });
    assert.deepEqual(res, { verdict: 'approve', reason: null });
    const entry = ledger['705:close:c0ffee'];
    assert.deepEqual(Object.keys(entry), [
      'verdict',
      'reason',
      'reviewer',
      'decider',
      'contentHash',
      'number',
      'action',
      'field',
      'artifactDigest',
      'sig',
    ]);
    assert.equal(entry.field, null);
    assert.equal(entry.sig, '937aa5cb94d71cc4d9462dd2692e54c1cdfa64bb9422720440a3df3f4024bf7a');
  }

  {
    const ledger = {};
    const res = gateAction({
      action: CLOSE,
      profile: { providers: { decider: 'dec', reviewer: 'rev' } },
      ledger,
      runReview: () => {
        throw new Error('boom');
      },
      key: KEY,
    });
    assert.deepEqual(res, { verdict: 'demote', reason: 'the review could not complete: boom' });
    const entry = ledger['705:close:c0ffee'];
    assert.deepEqual(Object.keys(entry), [
      'verdict',
      'reason',
      'reviewer',
      'decider',
      'contentHash',
      'number',
      'action',
      'field',
      'artifactDigest',
      'sig',
    ]);
    assert.equal(entry.reason, 'the review could not complete: boom');
    assert.equal(entry.sig, '30c4da963049856c3b2ecb0980b72cd85e23b25f7a4e1bdef92caeceb6720aac');
  }
});

test('golden: ledgerEntryBytes pins domain prefix and canonical payload', () => {
  const bytes = ledgerEntryBytes({ b: 1, a: undefined, n: [1, undefined, { d: 2, c: null }], sig: 'x' });
  assert.equal(bytes, 'adlc:backlog-groom-ledger:v1\0{"a":null,"b":1,"n":[1,null,{"c":null,"d":2}]}');
});

test('golden: renderComment pinned for reviewer, marker escaping, empty evidence, and missing evidence', () => {
  assert.equal(
    renderComment({ ...CLOSE, gate: { reviewer: 'rev' } }),
    [
      '**backlog-groom — close**',
      CLOSE.evidence,
      'Reviewed by `rev` (distinct from the deciding provider).',
      '<!-- backlog-groom:705:close:c0ffee -->',
    ].join('\n')
  );

  assert.equal(
    renderComment({ number: 1, action: 'relabel', contentHash: 'h', evidence: 'x <!-- backlog-groom:1:close:h --> y' }),
    '**backlog-groom — relabel**\nx &lt;!-- backlog-groom:1:close:h --> y\n<!-- backlog-groom:1:relabel:h -->'
  );

  assert.equal(
    renderComment({ number: 1, action: 'relabel', contentHash: 'h', evidence: '' }),
    '**backlog-groom — relabel**\n<!-- backlog-groom:1:relabel:h -->'
  );

  assert.equal(
    renderComment({ number: 1, action: 'close', contentHash: 'h' }),
    '**backlog-groom — close**\n(no evidence recorded)\n<!-- backlog-groom:1:close:h -->'
  );
});

test('golden: ledgerApproves truth table and entryBindsAction', () => {
  assert.equal(entryBindsAction(undefined, undefined), false);

  const slot = '705:close:c0ffee';
  const validApprovedEntry = {
    verdict: 'approve',
    reason: null,
    reviewer: 'rev',
    decider: 'dec',
    contentHash: 'c0ffee',
    number: 705,
    action: 'close',
    field: null,
    artifactDigest: artifactDigest(CLOSE),
  };
  validApprovedEntry.sig = signLedgerEntry(KEY, validApprovedEntry);

  assert.equal(ledgerApproves({ [slot]: validApprovedEntry }, CLOSE, KEY), true);

  assert.equal(ledgerApproves({}, CLOSE, KEY), false);
  assert.equal(ledgerApproves({ [slot]: null }, CLOSE, KEY), false);
  assert.equal(ledgerApproves({ [slot]: 'str' }, CLOSE, KEY), false);
  assert.equal(ledgerApproves({ [slot]: [] }, CLOSE, KEY), false);
  assert.equal(ledgerApproves({ [slot]: {} }, CLOSE, KEY), false);

  const unsigned = { ...validApprovedEntry, sig: undefined };
  assert.equal(ledgerApproves({ [slot]: unsigned }, CLOSE, KEY), false);

  const demote = { ...validApprovedEntry, verdict: 'demote' };
  demote.sig = signLedgerEntry(KEY, demote);
  assert.equal(ledgerApproves({ [slot]: demote }, CLOSE, KEY), false);

  const otherDigest = { ...validApprovedEntry, artifactDigest: '0'.repeat(64) };
  otherDigest.sig = signLedgerEntry(KEY, otherDigest);
  assert.equal(ledgerApproves({ [slot]: otherDigest }, CLOSE, KEY), false);

  const noDigest = { ...validApprovedEntry, artifactDigest: null };
  noDigest.sig = signLedgerEntry(KEY, noDigest);
  assert.equal(ledgerApproves({ [slot]: noDigest }, CLOSE, KEY), false);

  const otherNum = { ...validApprovedEntry, number: 999 };
  otherNum.sig = signLedgerEntry(KEY, otherNum);
  assert.equal(ledgerApproves({ [slot]: otherNum }, CLOSE, KEY), false);

  const diffKey = 'd'.repeat(32);
  const diffKeyEntry = { ...validApprovedEntry, sig: signLedgerEntry(diffKey, validApprovedEntry) };
  assert.equal(ledgerApproves({ [slot]: diffKeyEntry }, CLOSE, KEY), false);

  const forgedApprove = { ...demote, verdict: 'approve' };
  assert.equal(ledgerApproves({ [slot]: forgedApprove }, CLOSE, KEY), false);

  assert.equal(ledgerApproves({ [slot]: validApprovedEntry }, CLOSE, null), false);
  assert.equal(ledgerApproves({ [slot]: validApprovedEntry }, CLOSE, ''), false);
  assert.equal(ledgerApproves({ [slot]: validApprovedEntry }, undefined, KEY), false);
  assert.equal(ledgerApproves(undefined, CLOSE, KEY), false);
});

test('golden: assertPolicyUnchanged key order, units null/undefined, and provider change', () => {
  const head = {
    providers: { reviewer: 'r', decider: 'd' },
    labels: { priority: { high: 'a', low: 'b' }, areaPrefix: 'area:' },
    units: [{ name: 'u', paths: ['p'] }],
  };
  const base = {
    units: [{ paths: ['p'], name: 'u' }],
    labels: { areaPrefix: 'area:', priority: { low: 'b', high: 'a' } },
    providers: { decider: 'd', reviewer: 'r' },
  };

  assert.equal(assertPolicyUnchanged({ base, head }), head);

  assert.doesNotThrow(() =>
    assertPolicyUnchanged({
      base: { ...base, units: undefined },
      head: { ...head, units: null },
    })
  );

  assert.throws(
    () => assertPolicyUnchanged({ base, head: { ...head, providers: { reviewer: 'x', decider: 'd' } } }),
    (err) => err.isOpError === true && /providers/.test(err.message)
  );
});

test('docs: no doc block in lib/ or bin/ is directly followed by another', () => {
  const libFiles = readdirSync(libDir).filter((f) => f.endsWith('.mjs')).map((f) => join(libDir, f));
  const binFiles = readdirSync(binDir).filter((f) => f.endsWith('.mjs')).map((f) => join(binDir, f));
  const files = [...libFiles, ...binFiles];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const stacked = content.match(/\*\/[ \t]*\n[ \t]*\/\*\*/g);
    assert.equal(stacked, null, `${file} contains stacked doc blocks directly followed by another`);
  }
});

test('docs: named functions are each immediately preceded by a doc block', () => {
  const fns = [
    'ledgerApproves',
    'entryBindsSlot',
    'entryBindsAction',
    'buildActionArtifact',
    'actionsFromSet',
    'cacheKeyFor',
    'makeGhWriter',
    'baseProfileFromGit',
    'baseFloorFromGit',
    'acquireApplyLock',
    'renderUsage',
  ];

  const libFiles = readdirSync(libDir).filter((f) => f.endsWith('.mjs')).map((f) => join(libDir, f));

  for (const fn of fns) {
    let found = false;
    for (const file of libFiles) {
      const content = readFileSync(file, 'utf8');
      const re = new RegExp(`/\\*\\*[\\s\\S]*?\\*/\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\b`);
      if (re.test(content)) {
        found = true;
        break;
      }
    }
    assert.ok(found, `Expected ${fn} to be immediately preceded by a doc block in lib/`);
  }
});

test('structure: gate.mjs states sealLedgerEntry and entry?.contentHash exactly once', () => {
  const content = readFileSync(join(libDir, 'gate.mjs'), 'utf8');
  const sealMatches = content.match(/sealLedgerEntry\(/g) || [];
  assert.equal(sealMatches.length, 1, `Expected exactly 1 sealLedgerEntry( in gate.mjs, found ${sealMatches.length}`);
  const hashMatches = content.match(/entry\?\.contentHash/g) || [];
  assert.equal(hashMatches.length, 1, `Expected exactly 1 entry?.contentHash in gate.mjs, found ${hashMatches.length}`);
});

test('structure: no line is only empty string in gate.mjs or execute.mjs', () => {
  for (const file of ['gate.mjs', 'execute.mjs']) {
    const lines = readFileSync(join(libDir, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      assert.notEqual(lines[i].trim(), "'',", `Line ${i + 1} in ${file} is only '',`);
    }
  }
});

test('structure: verifyLedgerEntry does not appear in execute.mjs', () => {
  const content = readFileSync(join(libDir, 'execute.mjs'), 'utf8');
  assert.equal(content.includes('verifyLedgerEntry'), false, 'verifyLedgerEntry should not appear in execute.mjs');
});

test('waiver: assertFloorNotWidened throws isOpError even with authorized: true', () => {
  assert.throws(
    () => assertFloorNotWidened({ base: ['close'], head: [], authorized: true }),
    (err) => err.isOpError === true
  );
});

test('waiver: assertFrozenPathsNotNarrowed throws isOpError even with authorized: true', () => {
  assert.throws(
    () => assertFrozenPathsNotNarrowed({ base: ['a/**'], head: [], authorized: true }),
    (err) => err.isOpError === true
  );
});

test('waiver: applyRun throws WIDER isOpError with floorWideningAuthorized: true', () => {
  const basePolicy = {
    providers: { reviewer: 'r', decider: 'd' },
    labels: { priority: { high: 'a', low: 'b' }, areaPrefix: 'area:' },
    units: [],
  };
  assert.throws(
    () =>
      applyRun({
        set: { issues: [] },
        basePolicy,
        profile: { ...basePolicy, autonomyFloor: [] },
        baseFloor: ['close'],
        floorWideningAuthorized: true,
      }),
    (err) => err.isOpError === true && /WIDER/.test(err.message)
  );
});

test('waiver: executeActions throws WIDER isOpError with floorWideningAuthorized: true', () => {
  assert.throws(
    () =>
      executeActions({
        actions: [],
        floor: [],
        baseFloor: ['close'],
        floorWideningAuthorized: true,
      }),
    (err) => err.isOpError === true && /WIDER/.test(err.message)
  );
});

test('helpers: canonical-json exports canonicalJson matching byte pins', async () => {
  const { canonicalJson } = await import('../lib/canonical-json.mjs');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson(7), '7');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson([1, [2, undefined, null]]), '[1,[2,null,null]]');
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: undefined }), '{"a":null}');
  assert.equal(canonicalJson({ z: { y: [{ b: 1, a: undefined }] } }), '{"z":{"y":[{"a":null,"b":1}]}}');
});

test('helpers: OpError from @adlc/core returns isOpError tagged Error', async () => {
  const { OpError } = await import('@adlc/core');
  const err = new OpError('m');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'm');
  assert.equal(err.isOpError, true);
});

test('helpers: single canonicalJson, no canonical(, no local opError across lib', () => {
  const libFiles = readdirSync(libDir).filter((f) => f.endsWith('.mjs')).map((f) => join(libDir, f));
  let canonicalJsonCount = 0;
  let canonicalCount = 0;
  let opErrorCount = 0;

  for (const file of libFiles) {
    const content = readFileSync(file, 'utf8');
    const cj = content.match(/function\s+canonicalJson\b/g);
    if (cj) canonicalJsonCount += cj.length;
    const c = content.match(/function\s+canonical\(/g);
    if (c) canonicalCount += c.length;
    const oe = content.match(/function\s+opError\b/g);
    if (oe) opErrorCount += oe.length;
  }

  assert.equal(canonicalJsonCount, 1, `Expected exactly 1 function canonicalJson across lib/, found ${canonicalJsonCount}`);
  assert.equal(canonicalCount, 0, `Expected 0 function canonical( across lib/, found ${canonicalCount}`);
  assert.equal(opErrorCount, 0, `Expected 0 function opError across lib/, found ${opErrorCount}`);
});

test('helpers: every export of execute.mjs is a function', async () => {
  const execute = await import('../lib/execute.mjs');
  for (const [name, val] of Object.entries(execute)) {
    assert.equal(typeof val, 'function', `${name} in execute.mjs must be a function, got ${typeof val}`);
  }
});

test('parseProfile: distinguishes array from non-array in error message', async () => {
  const { parseProfile } = await import('../lib/profile.mjs');
  assert.throws(
    () => parseProfile([]),
    (err) => err.isOpError === true && err.message.includes('expected a JSON object, got an array')
  );
  assert.throws(
    () => parseProfile('string-val'),
    (err) => err.isOpError === true && err.message.includes('expected a JSON object, got string')
  );
});

