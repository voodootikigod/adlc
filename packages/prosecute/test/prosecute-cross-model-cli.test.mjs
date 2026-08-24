// Concern: bin/adlc-prosecute.mjs trust-root-tier gate + record-cross-model
// subcommand (T39 AC3/AC5 + review fixes A/B/C), end-to-end at the process boundary.
//
// Builds scratch git repos so the tier's changed-file set is real. Two hardening
// properties are pinned here:
//   FIX A: the tier is WORKING-TREE-INCLUSIVE (two-dot diff vs base ∪ untracked),
//          so an UNCOMMITTED trust-root edit — invisible to a committed three-dot
//          diff — still tiers. The bundle is committed on the BASELINE so untracked
//          scratch files never spuriously tier.
//   FIX C: the ticket table for rails-deny-path tiering is read from the SAME --dir
//          the prosecution uses, not a hard-coded .adlc/tickets.json.
// The recorded revision is resolved the SAME way the gate resolves it (no --revision).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sha256 } from '@adlc/core';
import { migrateLegacyStore } from '@adlc/tickets';
import { resolveProsecutionRevision } from '../lib/run.mjs';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

// #326 hardening: record-cross-model signs and the readers verify, both under this key.
process.env.ADLC_MANIFEST_KEY = 'test-cross-model-cli-signing-key';

// spawnSync, not execFileSync: stderr must be captured on the SUCCESS path too. A run
// that exits 0 can still warn (#370 prints the unsigned-entry warning and suppresses the
// success line), and execFileSync surfaces stderr only through the thrown error.
function runBin(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// A minimal, revision-PINNED record-cross-model invocation: no --input, so no revision
// resolution is involved and the case under test is purely the signing contract (#370).
const REC_UNSIGNABLE = [
  'record-cross-model', '--ticket', 'T1', '--provider', 'openai',
  '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', '.adlc',
];

// Raw ledger lines, so "nothing was appended" is asserted on the file itself rather
// than on a parsed view that could hide a written-then-unparsed entry.
function manifestLines(dir) {
  const path = join(dir, '.adlc', 'manifest.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function lastManifestEntry(dir) {
  const lines = manifestLines(dir);
  assert.ok(lines.length > 0, 'expected at least one manifest entry');
  return JSON.parse(lines.at(-1));
}

// A scratch repo. The ticket table (with `rails`) lives at <ledgerDir>/tickets.json;
// evidence always lives under .adlc/ (isEvidencePath). The whole bundle + any
// `baselineFiles` are committed on MAIN before branching, so no untracked file
// spuriously tiers under the working-tree-inclusive changed-file set. `featurePath`
// (if given) is committed on the `feat` branch.
function scratchRepo(featurePath, { baselineFiles = {}, ledgerDir = '.adlc', rails = [], migrateStore = false, extraTickets = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-xm-cli-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');

  for (const [rel, content] of Object.entries(baselineFiles)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }

  // Ticket table at the ledger dir (read by --dir); evidence under .adlc/.
  const ledger = join(dir, ledgerDir);
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, 'tickets.json'), JSON.stringify({
    tickets: [
      { id: 'T1', title: 'x', scope: ['src/**'], rails, edges: [] },
      ...extraTickets.map((id) => ({ id, title: 'spare', scope: ['src/**'], rails: [], edges: [] })),
    ],
  }));
  // Optionally convert the canonical store to the SHARDED backend before the
  // baseline commit, so the directory store is committed on main and a feature
  // change tiers (or not) purely on its own merits — not because uncommitted
  // shards under .adlc/tickets/ are themselves a trust-root surface.
  // T1 declares rails in these fixtures, so the legacy store being migrated is a
  // frozen trust root and the migration is an audited override that must be
  // signable (packages/tickets/test/bypass-audit.test.mjs). This fixture runs
  // deliberately keyless — these tests exercise the tier gate, whose whole point
  // is that it does NOT trust the manifest — so it opts into the unsigned audit
  // entry rather than introducing a key. That keeps the committed baseline
  // byte-identical to what these assertions were written against.
  if (migrateStore) migrateLegacyStore(dir, { write: true, yes: true, requireClean: false, key: null, allowUnsigned: true });

  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const transcriptPath = join(adlc, 'review.txt');
  writeFileSync(transcriptPath, 'placeholder\n');
  const promptPath = join(adlc, 'prompt.txt');
  const inputsPath = join(adlc, 'inputs.txt');
  writeFileSync(promptPath, 'review prompt\n');
  writeFileSync(inputsPath, 'reviewed input packet\n');
  // Commit the whole baseline on MAIN so nothing here is untracked at gate time.
  g('add', '-A'); g('commit', '-qm', 'baseline');

  if (featurePath) {
    g('checkout', '-q', '-b', 'feat');
    const abs = join(dir, ...featurePath.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'export const x = 1;\n');
    g('add', '-A'); g('commit', '-qm', `touch ${featurePath}`);
  }

  const passesPath = join(adlc, 'passes.json');
  return { dir, ledgerDir, adlc, transcriptPath, promptPath, inputsPath, passesPath };
}

// Bind the transcript to `revision` and write the passes input (both under .adlc/,
// so they are revision-ignored and the resolved revision stays stable).
function writePasses({ passesPath, transcriptPath, promptPath, inputsPath, revision }) {
  writeFileSync(transcriptPath, [
    'ticket: T1',
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  writeFileSync(passesPath, JSON.stringify({
    provenance: { reviewer: 'r', session: 's', command: 'c', transcript: transcriptPath },
    review_packet: {
      prompt: promptPath, prompt_hash: sha256(readFileSync(promptPath)),
      inputs: inputsPath, inputs_hash: sha256(readFileSync(inputsPath)),
      clean_worktree: revision,
    },
    no_findings_attestation: { reason: 'none', method: 'audit', evidence: 'review.txt' },
    passes: [
      { lens: 'security', findings: [], dry_evidence: 'no security findings' },
      { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
    ],
  }));
}

// Resolve the reviewed revision exactly as the bin does (cwd = repo root, same
// --input/--dir), so the evidence can be bound to it before the gate runs.
function resolveRev(repo) {
  const input = JSON.parse(readFileSync(repo.passesPath, 'utf8'));
  return resolveProsecutionRevision({ cwd: repo.dir, dir: repo.ledgerDir, input, inputPath: '.adlc/passes.json' });
}

describe('adlc-prosecute trust-root-tier CLI gate', () => {
  it('exits 2 without an attestation, then 0 once a distinct-provider approve is recorded (revision resolved by both)', () => {
    const repo = scratchRepo('packages/prosecute/lib/feature.mjs');
    try {
      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      assert.ok(revision, 'gate resolves a revision');

      writePasses({ ...repo, revision });
      const fail = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--author-provider', 'anthropic', '--json'], repo.dir);
      assert.equal(fail.status, 2);
      assert.match(JSON.parse(fail.stdout).message, /cross-model adversarial approve from a distinct provider/);

      // Record a distinct-provider approve; the subcommand resolves the SAME revision.
      const rec = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--input', '.adlc/passes.json', '--base', 'main', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(rec.status, 0);
      assert.equal(JSON.parse(rec.stdout).data.revision, revision, 'recorded revision matches the gate revision');

      const pass = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--author-provider', 'anthropic', '--json'], repo.dir);
      assert.equal(pass.status, 0);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('FIX A: an UNCOMMITTED edit to a trust-root file tiers (invisible to a committed three-dot diff)', () => {
    // run.mjs is committed on main; feat commits only an ordinary docs file. The
    // trust-root change is an UNCOMMITTED edit — a three-dot main...HEAD diff misses
    // it, but the working-tree-inclusive tier must catch it.
    const repo = scratchRepo('apps/docs/x.mdx', { baselineFiles: { 'packages/prosecute/lib/run.mjs': 'v1\n' } });
    const g = (...args) => execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      writeFileSync(join(repo.dir, 'packages', 'prosecute', 'lib', 'run.mjs'), 'v2-uncommitted\n');
      // Prove the committed three-dot diff does NOT see the uncommitted edit.
      const committedDiff = g('diff', '--name-only', 'main...HEAD');
      assert.doesNotMatch(committedDiff, /packages\/prosecute\/lib\/run\.mjs/);

      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      writePasses({ ...repo, revision });
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--author-provider', 'anthropic', '--json'], repo.dir);
      assert.equal(res.status, 2, 'uncommitted trust-root edit must tier → exit 2 without an attestation');
      assert.match(JSON.parse(res.stdout).message, /cross-model adversarial approve from a distinct provider/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('FIX C: a rails deny-path declared in the --dir ticket table tiers the change', () => {
    // The feature file is trust-root ONLY via a rail declared in custom/tickets.json.
    // Reading a hard-coded .adlc/tickets.json (which has no such rail) would miss it.
    const repo = scratchRepo('src/auth/login.mjs', { ledgerDir: 'custom', rails: ['src/auth/**'] });
    try {
      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      writePasses({ ...repo, revision });
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', 'custom', '--author-provider', 'anthropic', '--json'], repo.dir);
      assert.equal(res.status, 2, '--dir custom rail must tier the matching change');
      assert.match(res.stderr, /rails deny-path of ticket T1/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('residual: an OUT-OF-REPO --dir cannot declassify a change that is trust-root via the repo canonical rails', () => {
    // The rail lives in the repo's CANONICAL .adlc/tickets.json; src/secure/* is
    // trust-root ONLY via that rail. Point --dir at an OUTSIDE table that OMITS the
    // rail — pre-fix, loadTicketsForTier read the --dir table and declassified the
    // change (gate bypass). The canonical rails must still tier it. Explicit
    // --revision keeps the transcript binding stable regardless of --dir.
    const repo = scratchRepo('src/secure/secret.mjs', { ledgerDir: '.adlc', rails: ['src/secure/**'] });
    const outside = mkdtempSync(join(tmpdir(), 'adlc-escape-'));
    try {
      writeFileSync(join(outside, 'tickets.json'), JSON.stringify({
        tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }],
      }));
      writePasses({ ...repo, revision: 'fixed-rev' });
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', outside, '--revision', 'fixed-rev', '--author-provider', 'anthropic', '--json'], repo.dir);
      assert.equal(res.status, 2, 'canonical rails must tier even when --dir points OUTSIDE the repo (no escape)');
      assert.match(JSON.parse(res.stdout).message, /cross-model adversarial approve from a distinct provider/);
      assert.match(res.stderr, /rails deny-path of ticket T1/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('residual: canonical rails still tier when the store uses the SHARDED directory backend', () => {
    // Pre-fix, loadTicketsForTier read only `.adlc/tickets.json`. After a repo
    // migrates to `.adlc/tickets/`, that path is GONE — the ENOENT branch yielded
    // an empty table, so a change that is trust-root ONLY via a ticket rail was
    // silently declassified and a same-model P5 passed clean. That is a fail-OPEN
    // gate bypass, so it is asserted at the process boundary on a real migrated store.
    const repo = scratchRepo('src/secure/secret.mjs', { ledgerDir: '.adlc', rails: ['src/secure/**'], migrateStore: true });
    try {
      writePasses({ ...repo, revision: 'fixed-rev' });
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--revision', 'fixed-rev', '--author-provider', 'anthropic', '--json'], repo.dir);
      assert.equal(res.status, 2, 'a rail-only trust-root change must still tier under the directory backend');
      assert.match(JSON.parse(res.stdout).message, /cross-model adversarial approve from a distinct provider/);
      assert.match(res.stderr, /rails deny-path of ticket T1/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('residual: ADLC_TICKETS / ADLC_TICKET_STORE cannot replace the canonical store for tiering', () => {
    // Same escape as the OUT-OF-REPO --dir case, through the environment instead.
    // detectTicketStore defaults to env = process.env and honours these variables,
    // so resolving the canonical store WITHOUT disabling overrides would let the
    // gated author point tiering at a valid rail-free store and declassify a
    // rails-only trust-root change. Both variable names are covered.
    for (const varName of ['ADLC_TICKETS', 'ADLC_TICKET_STORE']) {
      const repo = scratchRepo('src/secure/secret.mjs', { ledgerDir: '.adlc', rails: ['src/secure/**'] });
      try {
        // A VALID store that contains the active ticket but omits the rail.
        const railFree = join(repo.dir, 'rail-free-tickets.json');
        writeFileSync(railFree, JSON.stringify({ tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }] }));
        writePasses({ ...repo, revision: 'fixed-rev' });
        const res = runBin(
          ['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--revision', 'fixed-rev', '--author-provider', 'anthropic', '--json'],
          repo.dir,
          { [varName]: railFree },
        );
        assert.equal(res.status, 2, `${varName} must not declassify a change that is trust-root via the canonical rails`);
        assert.match(res.stderr, /rails deny-path of ticket T1/);
      } finally {
        rmSync(repo.dir, { recursive: true, force: true });
      }
    }
  });

  it('residual: a store tracked at BASE but absent from the worktree still supplies rails', () => {
    // A sparse checkout / skip-worktree entry leaves the canonical store absent
    // locally WITHOUT git reporting a deletion, so it never shows up in
    // changedFiles either. Reading only the worktree collapses that to "no rails"
    // and declassifies a rails-only trust-root change — a fail-OPEN bypass. The
    // base tree is authoritative, exactly as rails-guard-ci.mjs treats it.
    //
    // The override store is what makes this reachable rather than merely broken:
    // downstream ticket binding still resolves T1 through it, so the run proceeds
    // to the tier decision instead of op-erroring on an unresolvable ticket. Only
    // tiering is left blind — which is precisely the hole.
    const repo = scratchRepo('src/secure/secret.mjs', { ledgerDir: '.adlc', rails: ['src/secure/**'] });
    const g = (...args) => execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const railFree = join(repo.dir, 'rail-free-tickets.json');
      writeFileSync(railFree, JSON.stringify({ tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }] }));
      g('update-index', '--skip-worktree', '.adlc/tickets.json');
      rmSync(join(repo.dir, '.adlc', 'tickets.json'));
      // Precondition: git must NOT see this as a change, or the test would be
      // proving something weaker than the sparse-checkout scenario it describes.
      assert.equal(g('status', '--porcelain', '--', '.adlc/tickets.json').trim(), '', 'skip-worktree removal must be invisible to git');
      writePasses({ ...repo, revision: 'fixed-rev' });
      const res = runBin(
        ['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--revision', 'fixed-rev', '--author-provider', 'anthropic', '--json'],
        repo.dir,
        { ADLC_TICKET_STORE: railFree },
      );
      assert.equal(res.status, 2, 'base-tree rails must still tier when the worktree store is absent');
      assert.match(res.stderr, /rails deny-path of ticket T1/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('residual: an AMBIGUOUS dual store (legacy + directory) fails closed (exit 1), never a silent ungated pass', () => {
    // A half-finished migration leaves both backends present. Resolving the
    // canonical store then throws AMBIGUOUS_STORE — which must op-error rather
    // than degrade to "no rails" and drop the rails dimension entirely.
    const repo = scratchRepo('src/secure/secret.mjs', { ledgerDir: '.adlc', rails: ['src/secure/**'], migrateStore: true });
    try {
      writePasses({ ...repo, revision: 'fixed-rev' });
      writeFileSync(join(repo.dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--revision', 'fixed-rev', '--author-provider', 'anthropic', '--json'], repo.dir);
      assert.equal(res.status, 1, 'an ambiguous dual store must op-error, not proceed ungated');
      assert.match(`${res.stderr ?? ''}${res.stdout ?? ''}`, /AMBIGUOUS_STORE|cannot be read for tiering|determine trust-root tier/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('residual: a PRESENT-but-corrupt canonical .adlc/tickets.json fails closed (exit 1), never a silent ungated pass', () => {
    // A present-but-malformed canonical ticket table must NOT be silently read as
    // "no rails" (which would drop the rails dimension and let a rails-only
    // trust-root change evade). It must op-error.
    const repo = scratchRepo('src/secure/secret.mjs', { ledgerDir: '.adlc', rails: ['src/secure/**'] });
    try {
      writePasses({ ...repo, revision: 'fixed-rev' });
      writeFileSync(join(repo.dir, '.adlc', 'tickets.json'), 'not valid json {');
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--revision', 'fixed-rev', '--author-provider', 'anthropic', '--json'], repo.dir);
      assert.equal(res.status, 1, 'a corrupt canonical ticket table must op-error, not proceed ungated');
      assert.match(`${res.stderr ?? ''}${res.stdout ?? ''}`, /valid JSON|determine trust-root tier/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('FIX B: a tiered run with NO --author-provider fails closed (exit 1)', () => {
    const repo = scratchRepo('packages/prosecute/lib/feature.mjs');
    try {
      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      writePasses({ ...repo, revision });
      // Run with ADLC_AUTHOR_PROVIDER cleared so only the missing flag is under test.
      const res = runBinNoAuthor(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(res.status, 1, 'trust-root tier without an author-provider must be exit 1');
      // --json prints the op-error result (with errors) to stdout; tier reasons go to stderr.
      assert.ok(JSON.parse(res.stdout).errors.some((e) => /author-provider|ADLC_AUTHOR_PROVIDER/.test(e)));
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('record-cross-model fails closed (exit 1) when provider === author-provider', () => {
    const repo = scratchRepo('packages/prosecute/lib/feature.mjs');
    try {
      writePasses({ ...repo, revision: 'r' });
      const rec = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'anthropic', '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', '.adlc'], repo.dir);
      assert.equal(rec.status, 1);
      assert.match(rec.stderr, /distinct from the author/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  // #370 — record-cross-model is a SIGNING operation. With no key it used to write an
  // inert unsigned entry, exit 0 and print success, so the operator learned the truth
  // only from CI — after the distinct-provider review that produced the attestation had
  // already been spent. These pin the write side as loud as the read side.
  it('#370: with NO key it fails closed (exit 1), names the consequence, and writes NOTHING', () => {
    const repo = scratchRepo('packages/prosecute/lib/feature.mjs');
    try {
      const before = manifestLines(repo.dir);
      const rec = runBin(REC_UNSIGNABLE, repo.dir, { ADLC_MANIFEST_KEY: '' });
      assert.equal(rec.status, 1, 'a signing command with no key must not exit 0');
      assert.match(rec.stderr, /ADLC_MANIFEST_KEY/, 'names the missing key');
      assert.match(rec.stderr, /would NOT satisfy the trust-root gate/, 'names the consequence');
      assert.match(rec.stderr, /--allow-unsigned/, 'names the deliberate opt-in');
      assert.doesNotMatch(rec.stdout, /recorded cross-model/, 'never claims success');
      // The manifest is append-only and hash-chained: a wrongly written entry is
      // permanent noise, so failing closed must happen BEFORE the append.
      assert.deepEqual(manifestLines(repo.dir), before, 'no entry may be appended on the no-key path');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('#370: --allow-unsigned still writes the unsigned entry, but WARNS instead of reporting success', () => {
    const repo = scratchRepo('packages/prosecute/lib/feature.mjs');
    try {
      const rec = runBin([...REC_UNSIGNABLE, '--allow-unsigned'], repo.dir, { ADLC_MANIFEST_KEY: '' });
      assert.equal(rec.status, 0, 'a deliberate unsigned write is allowed');
      const entry = lastManifestEntry(repo.dir);
      assert.equal(entry.gate, 'cross-model-review', 'the entry is written');
      assert.equal(entry.sig, undefined, 'and it is genuinely unsigned');
      assert.doesNotMatch(rec.stdout, /recorded cross-model/, 'the success line is never printed for an unsigned entry');
      assert.match(rec.stderr, /UNSIGNED/);
      assert.match(rec.stderr, /will NOT satisfy the trust-root gate/, 'the warning names the consequence');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('#370: --json reports whether the entry was signed, in BOTH the keyed and unsigned cases', () => {
    const repo = scratchRepo('packages/prosecute/lib/feature.mjs');
    try {
      const signed = runBin([...REC_UNSIGNABLE, '--json'], repo.dir);
      assert.equal(signed.status, 0, signed.stderr);
      const signedJson = JSON.parse(signed.stdout);
      assert.equal(signedJson.signed, true);
      assert.equal(signedJson.data.revision, 'r', 'the recorded entry is still the JSON payload');

      const unsigned = runBin([...REC_UNSIGNABLE, '--allow-unsigned', '--json'], repo.dir, { ADLC_MANIFEST_KEY: '' });
      assert.equal(unsigned.status, 0, unsigned.stderr);
      assert.equal(JSON.parse(unsigned.stdout).signed, false);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('an ordinary (non-trust-root) diff is not gated by cross-model', () => {
    const repo = scratchRepo('apps/docs/x.mdx');
    try {
      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      writePasses({ ...repo, revision });
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(res.status, 0, 'ordinary diff passes P5 with no cross-model attestation');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('FAILS CLOSED (exit 1) when the base ref is unresolvable — never a silent ungated pass', () => {
    const repo = scratchRepo('apps/docs/x.mdx');
    try {
      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      writePasses({ ...repo, revision });
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'no-such-ref', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(res.status, 1, 'unresolvable base ref must be exit 1, not a silent ungated exit 0');
      assert.match(res.stderr, /cannot determine trust-root tier: base ref 'no-such-ref' unresolvable/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

// Run the bin with ADLC_AUTHOR_PROVIDER explicitly cleared so the env of the test
// runner cannot accidentally satisfy the author-provider requirement.
function runBinNoAuthor(args, cwd) {
  const env = { ...process.env };
  delete env.ADLC_AUTHOR_PROVIDER;
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
