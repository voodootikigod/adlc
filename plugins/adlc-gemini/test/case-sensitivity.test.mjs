import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCaseInsensitiveFs, checkRail } from '../rails-checker.mjs';

const ENF = { ADLC_P4_ENFORCEMENT: '1' };

function adlcRepo({ rails = [], id = 'T1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-case-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id, title: 't', body: 'b', scope: ['src/**'], rails }] }));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id }));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// isCaseInsensitiveFs — probe unit tests (fully mocked, no real disk case dependency)
// ---------------------------------------------------------------------------

test('probe: flipped-case path resolving to the SAME real path reports insensitive', () => {
  const fns = {
    existsSync: () => true,
    realpathSync: (p) => '/real/canonical/path', // both spellings collapse to the same real path
  };
  assert.equal(isCaseInsensitiveFs('/tmp/AbCd', fns), true);
});

test('probe: flipped-case path NOT existing reports sensitive', () => {
  const fns = {
    existsSync: (p) => !/[A-Z]/.test(p), // only the original (lowercase) spelling exists
    realpathSync: (p) => p,
  };
  assert.equal(isCaseInsensitiveFs('/tmp/abcd', fns), false);
});

test('probe: flipped-case path existing but resolving to a DIFFERENT real path reports sensitive', () => {
  const fns = {
    existsSync: () => true,
    realpathSync: (p) => p, // no collapsing — each spelling is genuinely distinct
  };
  assert.equal(isCaseInsensitiveFs('/tmp/abcd', fns), false);
});

test('probe: a throwing fs call reports sensitive (fail toward no extra denial)', () => {
  const fns = {
    existsSync: () => { throw new Error('boom'); },
    realpathSync: () => { throw new Error('boom'); },
  };
  assert.equal(isCaseInsensitiveFs('/tmp/abcd', fns), false);
});

test('probe: a root with no alphabetic leaf segment to flip reports sensitive (cannot determine)', () => {
  const fns = {
    existsSync: (p) => !p.endsWith('.adlc'), // no .adlc dir, so root's own (numeric) leaf is probed
    realpathSync: (p) => '/some/real/path', // would look "insensitive" if we trusted a no-op flip
  };
  assert.equal(isCaseInsensitiveFs('/tmp/12345', fns), false);
});

test('probe: real filesystem call succeeds without throwing (smoke test, no fns injected)', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-case-real-'));
  assert.equal(typeof isCaseInsensitiveFs(root), 'boolean');
});

// ---------------------------------------------------------------------------
// checkRail — case-insensitive-aware integration (injected probe result)
// ---------------------------------------------------------------------------

const insensitiveProbe = () => true;
const sensitiveProbe = () => false;

test('checkRail (insensitive fs): differently-cased write to an EXISTING frozen file is DENIED (upper rail, lower write)', () => {
  const root = adlcRepo({ rails: ['src/FROZEN.js'] });
  writeFileSync(join(root, 'src', 'FROZEN.js'), 'x');
  const result = checkRail({
    filePath: 'src/frozen.js', tool: 'write_to_file', root, env: ENF,
    isCaseInsensitiveFsFn: insensitiveProbe,
  });
  assert.equal(result.decision, 'deny');
});

test('checkRail (insensitive fs): differently-cased write to an EXISTING frozen file is DENIED (lower rail, upper write)', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  writeFileSync(join(root, 'src', 'frozen.js'), 'x');
  const result = checkRail({
    filePath: 'src/FROZEN.js', tool: 'write_to_file', root, env: ENF,
    isCaseInsensitiveFsFn: insensitiveProbe,
  });
  assert.equal(result.decision, 'deny');
});

test('checkRail (insensitive fs): differently-cased write to a NOT-YET-EXISTING new file is DENIED', () => {
  const root = adlcRepo({ rails: ['src/FROZEN.js'] });
  // src/FROZEN.js is declared as a rail but never created on disk — the write
  // targets a brand-new path that differs only in case.
  const result = checkRail({
    filePath: 'src/frozen.js', tool: 'write_to_file', root, env: ENF,
    isCaseInsensitiveFsFn: insensitiveProbe,
  });
  assert.equal(result.decision, 'deny');
});

test('checkRail (insensitive fs): .adlc/TICKETS.json (case variant of the trust root) is DENIED', () => {
  const root = adlcRepo({ rails: [] });
  const result = checkRail({
    filePath: '.adlc/TICKETS.json', tool: 'write_to_file', root, env: ENF,
    isCaseInsensitiveFsFn: insensitiveProbe,
  });
  assert.equal(result.decision, 'deny');
});

test('checkRail (insensitive fs): a genuinely unrelated file is still ALLOWED', () => {
  const root = adlcRepo({ rails: ['src/FROZEN.js'] });
  const result = checkRail({
    filePath: 'src/unrelated.js', tool: 'write_to_file', root, env: ENF,
    isCaseInsensitiveFsFn: insensitiveProbe,
  });
  assert.equal(result.decision, 'allow');
});

test('checkRail (sensitive fs, injected): a differently-cased UNRELATED file is still ALLOWED — no regression', () => {
  const root = adlcRepo({ rails: ['src/FROZEN.js'] });
  writeFileSync(join(root, 'src', 'frozen.js'), 'unrelated content');
  const result = checkRail({
    filePath: 'src/frozen.js', tool: 'write_to_file', root, env: ENF,
    isCaseInsensitiveFsFn: sensitiveProbe,
  });
  assert.equal(result.decision, 'allow');
});

test('checkRail (insensitive fs): a glob-pattern rail denies via glob match alone, not just exact string equality', () => {
  // The rail is a glob (SRC/**), so rail.toLowerCase() ('src/**') never literally
  // equals the lowercased candidate path — only globMatch can find this hit. This
  // distinguishes the `||` between exact-equality and globMatch from an `&&`.
  const root = adlcRepo({ rails: ['SRC/**'] });
  const result = checkRail({
    filePath: 'src/nested/newfile.js', tool: 'write_to_file', root, env: ENF,
    isCaseInsensitiveFsFn: insensitiveProbe,
  });
  assert.equal(result.decision, 'deny');
});

test('checkRail (no probe injected — real fs): exact-case frozen file is still DENIED (byte-identical baseline behaviour)', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  const result = checkRail({ filePath: 'src/frozen.js', tool: 'write_to_file', root, env: ENF });
  assert.equal(result.decision, 'deny');
});
