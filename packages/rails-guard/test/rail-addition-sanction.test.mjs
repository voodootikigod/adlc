// T-01M0122Y3JYM04D2VZC3026G3B — sanction rail-file ADDITION by the declaring
// ticket's own build PR.
//
// Once a railed ticket merges, its rail globs freeze paths that may not exist yet:
// the build PR that AUTHORS the rail test file then fails the rail-freeze gate with
// no sanctioned escape (T36 lifts only completed tickets; a PR may complete only
// railless tickets; the #141 ceremony never lifts ticket rails). PRs #494/#497 had
// to merge over a red advisory check — the signal erosion this fixes.
//
// The sanction is exactly the authoring act, nothing wider:
//   - a PURE ADDITION (absent at the trusted base, never a rename/copy destination),
//   - matching ONLY in-flight ticket rails (never an immutable trust root),
//   - reported loudly, naming the declaring ticket id(s).
// Everything else keeps today's denial: edits, renames (both sides), deletions,
// files that exist at base, and anything touching a trust root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRailFreezeGate } from '../lib/ci/rail-freeze.mjs';
import { GateDeny } from '../lib/ci/errors.mjs';
import { checkRailEdits } from '../lib/rails.mjs';

// ── unit: the mechanism is a dumb, explicit membership skip ─────────────────────
// Policy (what qualifies as a sanctioned addition) lives in the CI wrapper, which
// alone knows glob ownership and the trusted base. The library only honors the set.

test('checkRailEdits without a sanction set behaves exactly as before', () => {
  const violations = checkRailEdits(['test/frozen/new.mjs'], ['test/frozen/**'], null);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'rail-edit');
});

test('checkRailEdits skips exactly the sanctioned paths, never their neighbors', () => {
  const violations = checkRailEdits(
    ['test/frozen/new.mjs', 'test/frozen/other.mjs'],
    ['test/frozen/**'],
    null,
    new Set(['test/frozen/new.mjs'])
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'test/frozen/other.mjs');
});

test('the --help contract documents --sanctioned-add as CI plumbing, not an operator flag', () => {
  // The flag is invoker-trusted plumbing; the help text is the contract that says
  // so. Pin it so the documented meaning cannot silently drift from the wiring.
  // (URL-based path, not import.meta.dirname — that is Node ≥20 and this runs on 18.)
  const BIN = new URL('../bin/rails-guard.mjs', import.meta.url).pathname;
  const stdout = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(stdout, /--sanctioned-add <path>/);
  assert.match(stdout, /Do not pass by hand/);
});

// ── end-to-end: the CI gate in a real scratch repo ─────────────────────────────

function scratchRepo({ tickets, seedFiles = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'rail-add-sanction-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@test.invalid');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'config.json'), JSON.stringify({
    schema: 1,
    securityMode: 'unsigned-fallback',
    acknowledgedNewRailBypass: true,
  }, null, 2) + '\n');
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({
    schema: 1,
    tickets,
  }, null, 2) + '\n');
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  for (const [file, content] of Object.entries(seedFiles)) {
    mkdirSync(join(root, file.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feat');
  return { root, g, base };
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const gate = (root, base) => runRailFreezeGate({ cwd: root, base, env: {}, stdio: 'pipe' });

test('AC1: adding a declared-but-absent rail file passes and names the declaring ticket', () => {
  const { root, g, base } = scratchRepo({
    tickets: [{ id: 'T-BUILD-1', title: 'build me', rails: ['test/frozen/**'] }],
  });
  try {
    mkdirSync(join(root, 'test', 'frozen'), { recursive: true });
    writeFileSync(join(root, 'test', 'frozen', 'contract.test.mjs'), 'export const t = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'author the rail test');
    const res = gate(root, base);
    assert.equal(res.status, 0, 'the authoring addition must pass the gate');
    const text = res.messages.join('\n');
    assert.match(text, /sanctioned rail authoring/i, 'the sanction must be reported, never silent');
    assert.match(text, /test\/frozen\/contract\.test\.mjs/);
    assert.match(text, /T-BUILD-1/, 'the declaring ticket is named in the record');
  } finally { cleanup(root); }
});

test('AC1: an addition covered by TWO in-flight tickets names both', () => {
  const { root, g, base } = scratchRepo({
    tickets: [
      { id: 'T-BUILD-1', title: 'a', rails: ['test/frozen/**'] },
      { id: 'T-BUILD-2', title: 'b', rails: ['test/frozen/contract.test.mjs'] },
    ],
  });
  try {
    mkdirSync(join(root, 'test', 'frozen'), { recursive: true });
    writeFileSync(join(root, 'test', 'frozen', 'contract.test.mjs'), 'export const t = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'author the rail test');
    const res = gate(root, base);
    assert.equal(res.status, 0);
    const text = res.messages.join('\n');
    assert.match(text, /T-BUILD-1/);
    assert.match(text, /T-BUILD-2/);
  } finally { cleanup(root); }
});

test('AC2: editing a rail file that EXISTS at base stays denied (exit 2)', () => {
  const { root, g, base } = scratchRepo({
    tickets: [{ id: 'T-BUILD-1', title: 'build me', rails: ['test/frozen/**'] }],
    seedFiles: { 'test/frozen/contract.test.mjs': 'export const t = 1;\n' },
  });
  try {
    writeFileSync(join(root, 'test', 'frozen', 'contract.test.mjs'), 'export const t = 2; // gamed\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'edit the frozen rail');
    const res = gate(root, base);
    assert.equal(res.status, 2, 'an edit to an existing rail file is the exact thing the freeze denies');
  } finally { cleanup(root); }
});

test('AC3: renaming a rail file stays denied, even when the destination is inside the rail glob', () => {
  const { root, g, base } = scratchRepo({
    tickets: [{ id: 'T-BUILD-1', title: 'build me', rails: ['test/frozen/**'] }],
    seedFiles: { 'test/frozen/contract.test.mjs': 'export const t = 1;\n' },
  });
  try {
    g('mv', 'test/frozen/contract.test.mjs', 'test/frozen/renamed.test.mjs');
    g('commit', '-q', '-m', 'rename inside the rail dir');
    const res = gate(root, base);
    assert.equal(res.status, 2, 'a rename is never a sanctioned addition — the destination must not launder it');
  } finally { cleanup(root); }
});

test('AC3: deleting a rail file stays denied', () => {
  const { root, g, base } = scratchRepo({
    tickets: [{ id: 'T-BUILD-1', title: 'build me', rails: ['test/frozen/**'] }],
    seedFiles: { 'test/frozen/contract.test.mjs': 'export const t = 1;\n' },
  });
  try {
    g('rm', '-q', 'test/frozen/contract.test.mjs');
    g('commit', '-q', '-m', 'delete the frozen rail');
    const res = gate(root, base);
    assert.equal(res.status, 2);
  } finally { cleanup(root); }
});

test('AC4: an addition matching BOTH a ticket rail and an immutable trust root is denied', () => {
  // docs/ci/rails-guard.yml is an immutable trust root; a ticket declaring a rail
  // over docs/ci/** must not turn adding that file into a sanctioned act.
  const { root, g, base } = scratchRepo({
    tickets: [{ id: 'T-BUILD-1', title: 'build me', rails: ['docs/ci/**'] }],
  });
  try {
    mkdirSync(join(root, 'docs', 'ci'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ci', 'rails-guard.yml'), 'name: forged\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'add a trust-root path');
    assert.throws(
      () => gate(root, base),
      (err) => err instanceof GateDeny,
      'the trust-root surface is untouched by the sanction'
    );
  } finally { cleanup(root); }
});

test('a COMPLETED ticket’s rails are expired: the addition passes with NO sanction message', () => {
  const { root, g, base } = scratchRepo({
    tickets: [{ id: 'T-DONE', title: 'shipped', rails: ['test/frozen/**'], completed: true }],
  });
  try {
    mkdirSync(join(root, 'test', 'frozen'), { recursive: true });
    writeFileSync(join(root, 'test', 'frozen', 'late.test.mjs'), 'export const t = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'add under an expired rail');
    const res = gate(root, base);
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.messages.join('\n'), /sanctioned rail authoring/i,
      'nothing was frozen, so nothing is "sanctioned" — the message must not overclaim');
  } finally { cleanup(root); }
});

test('an addition NOT matching any rail is untouched by the sanction machinery', () => {
  const { root, g, base } = scratchRepo({
    tickets: [{ id: 'T-BUILD-1', title: 'build me', rails: ['test/frozen/**'] }],
  });
  try {
    writeFileSync(join(root, 'ordinary.mjs'), 'export const o = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'ordinary addition');
    const res = gate(root, base);
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.messages.join('\n'), /sanctioned rail authoring/i);
  } finally { cleanup(root); }
});
