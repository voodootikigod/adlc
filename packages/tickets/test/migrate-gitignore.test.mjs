// Concern: the .gitignore the migration writes must make the migrated store —
// AND its mandatory CI evidence — actually trackable, without breaking negations
// the repository already declares.
//
// Both properties are asserted through `git check-ignore`, not by reading the
// file: gitignore semantics are last-match-wins, so a negation can be present in
// the text and still be dead. Only git can answer whether a path is tracked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyStore } from '../index.mjs';

const TICKET = { id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] };

function legacyRepo(gitignore) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-migrate-ignore-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  // Never inherit the developer's signing config: a fixture that depends on an
  // external signing agent turns an unrelated agent hiccup into a test failure.
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [TICKET] }));
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  return { dir, g };
}

// `git check-ignore` exits 0 when a path IS ignored, 1 when it is not.
function isIgnored(dir, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('migration tracks the manifest the CI evidence gate requires', () => {
  const { dir } = legacyRepo('.adlc/*\n!.adlc/tickets.json\n');
  try {
    migrateLegacyStore(dir, { write: true, yes: true, requireClean: false });
    assert.equal(isIgnored(dir, '.adlc/manifest.jsonl'), false,
      'the ticket-migrate/apply evidence must be trackable or the migration PR fails CI for missing evidence');
    assert.equal(isIgnored(dir, '.adlc/tickets/.store.json'), false);
    // Runtime state stays ignored — tracking the manifest must not track everything.
    assert.equal(isIgnored(dir, '.adlc/findings.jsonl'), true);
    assert.equal(isIgnored(dir, '.adlc/tickets.lock'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration does not strand pre-existing .adlc negations', () => {
  // Negations the stanza knows nothing about, already effective (below the
  // blanket rule). Relocating the blanket to the end of the file would leave
  // these above it, where the later pattern wins and they silently die.
  const { dir } = legacyRepo([
    '.adlc/*',
    '!.adlc/tickets.json',
    '!.adlc/tickets.example.json',
    '!.adlc/lessons/',
    '!.adlc/lessons/**',
    '',
  ].join('\n'));
  try {
    migrateLegacyStore(dir, { write: true, yes: true, requireClean: false });
    for (const path of ['.adlc/tickets.example.json', '.adlc/lessons/interrogation-template.md']) {
      assert.equal(isIgnored(dir, path), false, `${path} was tracked before the migration and must stay tracked`);
    }
    assert.equal(isIgnored(dir, '.adlc/manifest.jsonl'), false, 'and the new evidence negation still applies');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration adds the whole stanza when no .adlc rule exists yet', () => {
  const { dir } = legacyRepo('node_modules/\n');
  try {
    migrateLegacyStore(dir, { write: true, yes: true, requireClean: false });
    assert.equal(isIgnored(dir, '.adlc/manifest.jsonl'), false);
    assert.equal(isIgnored(dir, '.adlc/tickets/t1--abc.json'), false);
    assert.equal(isIgnored(dir, '.adlc/findings.jsonl'), true);
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /node_modules\//, 'existing rules are preserved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The stanza is a SET of required rules, so "already complete" must be a no-op.
// Without this, a rule that is present but miscounted as missing gets appended
// again — harmless to `check-ignore` (a duplicate negation still negates) and
// therefore invisible to every assertion above, but it grows the file on each
// migration and misrepresents what changed.
test('a .gitignore that already satisfies the stanza is left byte-identical', () => {
  const complete = [
    '.adlc/*',
    '!.adlc/tickets.json',
    '!.adlc/tickets/',
    '!.adlc/tickets/**',
    '!.adlc/ticket-archive/',
    '!.adlc/ticket-archive/**',
    '!.adlc/specs/',
    '!.adlc/manifest.jsonl',
    '!.adlc/manifest.d/',
    '!.adlc/manifest.d/**',
    '.adlc/manifest.d/.lineage',
    '.adlc/manifest.d/*.lock',
    '.adlc/manifest.d/*.tmp-*',
    '',
  ].join('\n');
  const { dir } = legacyRepo(complete);
  try {
    migrateLegacyStore(dir, { write: true, yes: true, requireClean: false });
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), complete,
      'a complete stanza must not be rewritten, duplicated or reordered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The realistic upgrade path: a repo migrated by the PREVIOUS version already
// has every rule except the evidence negation. Exactly one line is missing, so
// an off-by-one in the "nothing to do" short-circuit silently skips the only
// repair that matters.
test('a stanza missing exactly one rule still gets that rule', () => {
  const { dir } = legacyRepo([
    '.adlc/*',
    '!.adlc/tickets.json',
    '!.adlc/tickets/',
    '!.adlc/tickets/**',
    '!.adlc/ticket-archive/',
    '!.adlc/ticket-archive/**',
    '!.adlc/specs/',
    '',
  ].join('\n'));
  try {
    migrateLegacyStore(dir, { write: true, yes: true, requireClean: false });
    assert.equal(isIgnored(dir, '.adlc/manifest.jsonl'), false,
      'the single missing rule is the evidence negation — skipping it fails CI for missing evidence');

    // APPENDED to the existing block, not spliced in front of it. Both orderings
    // are equally effective (all below the blanket), so only position pins this —
    // and a stable position is what keeps the diff reviewable across upgrades.
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
    assert.ok(lines.indexOf('!.adlc/manifest.jsonl') > lines.indexOf('!.adlc/specs/'),
      `new rules must be appended after existing .adlc rules, got:\n${lines.join('\n')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Inserted rules belong with the block they extend. Placement below the blanket
// is what makes them EFFECTIVE (asserted elsewhere); placement immediately after
// it is what keeps the file readable, and nothing else pins that.
test('inserted rules land directly after the blanket rule, not after unrelated entries', () => {
  const { dir } = legacyRepo(['.adlc/*', 'node_modules/', 'dist/', ''].join('\n'));
  try {
    migrateLegacyStore(dir, { write: true, yes: true, requireClean: false });
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
    const blanketAt = lines.indexOf('.adlc/*');
    assert.ok(blanketAt >= 0, 'blanket rule must survive');
    assert.match(lines[blanketAt + 1] ?? '', /^!\.adlc\//,
      `expected an .adlc negation directly after the blanket rule, got ${JSON.stringify(lines[blanketAt + 1])}`);
    assert.equal(lines.filter((l) => l === 'node_modules/').length, 1, 'unrelated rules are neither moved nor duplicated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an ordinary `git add -A` stages everything the migration evidence gate needs', () => {
  // The end-to-end property that matters: a user runs the documented command,
  // stages normally, and the commit CONTAINS the store, the archive and the
  // evidence. No force-add, no manual .gitignore repair.
  const { dir, g } = legacyRepo('.adlc/*\n!.adlc/tickets.json\n');
  try {
    migrateLegacyStore(dir, { write: true, yes: true, requireClean: false });
    g('add', '-A');
    const staged = g('diff', '--cached', '--name-only', 'HEAD').trim().split('\n').filter(Boolean);
    assert.ok(staged.includes('.adlc/manifest.jsonl'), `evidence not staged; staged: ${staged.join(', ')}`);
    assert.ok(staged.includes('.adlc/tickets/.store.json'), 'store manifest not staged');
    assert.ok(staged.some((p) => p.startsWith('.adlc/tickets/') && p.endsWith('.json')), 'no ticket shard staged');
    assert.ok(staged.includes('.adlc/tickets.json'), 'legacy store deletion not staged');

    // And the staged evidence is the real thing, bound to the migrated store.
    const manifest = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(manifest.length, 1, 'a fresh ledger holds exactly the migration entry');
    const entry = JSON.parse(manifest[0]);
    assert.equal(entry.gate, 'ticket-migrate');
    assert.equal(entry.data.action, 'apply');
    assert.equal(entry.seq, 1, 'a fresh chain starts at seq 1');
    assert.equal(entry.prev, null, 'with no predecessor');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
