// record-paths.test.mjs — issues #643 and #644.
//
// #643: --record wrote files at a MODEL-SUPPLIED `id`/`target`, with no
// normalization or containment check, on the host. `id: '../../../../pwned'`
// escaped .adlc/gate-defeats and packages/<target>/test. The artifact id is
// now derived from the harness-computed dedup hash, the target is validated
// against a strict name pattern, and every write asserts containment.
//
// #644: the emitted RED scaffold imported `tmpdir` from node:path (no such
// export), so the generated test broke the target package's suite at load.
// The scaffold now imports only what it uses and is proven loadable here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  artifactId,
  assertContained,
  isSafeTarget,
  recordDefeats,
  writeReproArtifact,
} from '../lib/record.mjs';

const HASH = 'ab'.repeat(32); // 64 hex chars, like normalizeAndHash()
const HASH_PREFIX = HASH.slice(0, 16);

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gf-record-paths-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function defeat(overrides = {}) {
  return {
    id: 'model-chosen-id',
    target: 'rails-guard',
    claimKind: 'deny-rail-edit',
    strategy: 'rename',
    diff: '--- a\n+++ b\n',
    witnessProposal: { cmd: 'echo', args: ['hi'] },
    verdict: { witnessSource: 'independent' },
    hash: HASH,
    ...overrides,
  };
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// AC3 — the two pure helpers
// ---------------------------------------------------------------------------

test('isSafeTarget accepts plain package names and rejects separators, dots and overlong names', () => {
  for (const ok of ['rails-guard', 'gate_manifest', 'v1.2', 'x', 'x'.repeat(64)]) {
    assert.equal(isSafeTarget(ok), true, `${ok} should be safe`);
  }
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x'.repeat(65), undefined, null, 42, ' rails-guard']) {
    assert.equal(isSafeTarget(bad), false, `${JSON.stringify(bad)} should be unsafe`);
  }
});

test('artifactId is the 16-hex prefix of the harness hash, never the model id', () => {
  assert.equal(artifactId(defeat()), HASH_PREFIX);
  assert.equal(artifactId(defeat({ id: '../../../../pwned' })), HASH_PREFIX);
  assert.equal(artifactId(defeat({ hash: 'ABCDEF0123456789abcdef' })), 'ABCDEF0123456789');
  // A hash shorter than the prefix is used whole — one hex char is still a hash.
  assert.equal(artifactId(defeat({ hash: 'a' })), 'a');
  assert.equal(artifactId(defeat({ hash: 'abc' })), 'abc');
});

test('artifactId falls back to a cand-<timestamp> id when the hash is absent or not hex', () => {
  for (const hash of [undefined, null, '', 'not-hex!', '../x', 42]) {
    const id = artifactId(defeat({ hash }));
    assert.match(id, /^cand-\d+$/, `hash ${JSON.stringify(hash)} → ${id}`);
  }
});

// ---------------------------------------------------------------------------
// AC1 — a traversal id cannot choose the path
// ---------------------------------------------------------------------------

test('a traversal `id` writes only the two hash-named files inside the fixture root', () => {
  withRoot((root) => {
    const escaped = resolve(root, '../../../../pwned.json');
    assert.equal(existsSync(escaped), false, 'precondition: nothing above the root');

    const reproPath = writeReproArtifact(defeat({ id: '../../../../pwned' }), root);

    assert.equal(reproPath, join(root, '.adlc', 'gate-defeats', `${HASH_PREFIX}.json`));
    const files = walk(root).sort();
    assert.deepEqual(files, [
      `.adlc/gate-defeats/${HASH_PREFIX}.json`,
      `packages/rails-guard/test/bypass-${HASH_PREFIX}.test.mjs`,
    ]);
    assert.equal(files.some((f) => /pwned/.test(f)), false, 'no file named by the model');
    assert.equal(existsSync(escaped), false, 'nothing written above the root');

    const artifact = JSON.parse(readFileSync(reproPath, 'utf8'));
    assert.equal(artifact.id, HASH_PREFIX);
    assert.equal(artifact.candidateId, '../../../../pwned', 'the model id is echoed as data only');
    for (const field of ['target', 'claimKind', 'strategy', 'ts', 'diff', 'setup', 'witness', 'witnessSource', 'redTestScaffold']) {
      assert.ok(field in artifact, `artifact keeps ${field}`);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — an unsafe target gets the repro but no scaffold, and does not stop the batch
// ---------------------------------------------------------------------------

for (const target of ['../..', 'a/b']) {
  test(`target ${JSON.stringify(target)}: repro written, scaffold refused on stderr, siblings still recorded`, () => {
    withRoot((root) => {
      const warnings = [];
      const safeHash = 'cd'.repeat(32);
      const recorded = recordDefeats(
        [defeat({ target }), defeat({ hash: safeHash })],
        root,
        { warn: (line) => warnings.push(line) },
      );

      assert.equal(recorded.length, 2, 'both defeats recorded');
      assert.deepEqual(warnings, [
        `gate-fuzzing: refusing to write a test scaffold for unsafe target ${JSON.stringify(target)}`,
      ]);

      const files = walk(root).sort();
      assert.ok(files.includes(`.adlc/gate-defeats/${HASH_PREFIX}.json`), 'repro JSON for the unsafe target');
      assert.ok(files.includes(`.adlc/gate-defeats/${safeHash.slice(0, 16)}.json`), 'repro JSON for the sibling');
      assert.ok(files.includes(`packages/rails-guard/test/bypass-${safeHash.slice(0, 16)}.test.mjs`), 'scaffold for the sibling');
      assert.equal(files.filter((f) => f.startsWith('packages/')).length, 1, 'exactly one scaffold: the safe one');
      assert.equal(existsSync(join(root, '.adlc', 'findings.jsonl')), true, 'findings appended');
      const findings = readFileSync(join(root, '.adlc', 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(findings.length, 2);
      const [unsafe, safe] = findings;
      assert.equal(unsafe.file, '.adlc/gate-defeats', 'no package dir exists for an unsafe target');
      assert.equal(safe.file, 'packages/rails-guard/bin/rails-guard.mjs');
      for (const [finding, id] of [[unsafe, HASH_PREFIX], [safe, safeHash.slice(0, 16)]]) {
        assert.match(finding.desc, new RegExp(`Repro artifact id ${id} under \\.adlc/gate-defeats$`));
        assert.equal(finding.desc.includes(root), false, 'no absolute path inside the committed ledger');
      }
    });
  });
}

test('a finding for a realistic random hash under an absolute repo path is publishable', () => {
  // The committed findings ledger refuses a 32+ char mixed letter/digit token with
  // high entropy; an absolute repro path is one. Pin that the finding stays below it.
  withRoot((root) => {
    const hash = '3fa9c2e17b04d6a8f193a5f82ed0cac75e3bf30c192cbf54563af4d2add228aa';
    const recorded = recordDefeats([defeat({ hash })], root, { warn: () => {} });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].finding.desc.includes('3fa9c2e17b04d6a8'), true);
  });
});

test('writeReproArtifact warns on stderr by default (console.error) for an unsafe target', () => {
  withRoot((root) => {
    const original = console.error;
    const lines = [];
    console.error = (line) => lines.push(line);
    try {
      writeReproArtifact(defeat({ target: '..' }), root);
    } finally {
      console.error = original;
    }
    assert.deepEqual(lines, ['gate-fuzzing: refusing to write a test scaffold for unsafe target ".."']);
  });
});

// ---------------------------------------------------------------------------
// AC4 — the written scaffold loads and runs
// ---------------------------------------------------------------------------

test('the written scaffold is importable and `node --test` reports one todo, zero failures', () => {
  withRoot((root) => {
    writeReproArtifact(defeat(), root);
    const scaffoldPath = join(root, 'packages', 'rails-guard', 'test', `bypass-${HASH_PREFIX}.test.mjs`);
    assert.equal(existsSync(scaffoldPath), true);

    const source = readFileSync(scaffoldPath, 'utf8');
    assert.equal(source.includes("from 'node:path'"), false, 'no node:path import');
    assert.equal(source.includes('tmpdir'), false, 'no tmpdir reference');

    // The child must not inherit THIS runner's test-context env, or it reports
    // over the parent's channel instead of its own stdout.
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;

    // A real dynamic import in a clean process: this is exactly where the old
    // scaffold threw "does not provide an export named 'tmpdir'".
    const imported = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(scaffoldPath).href)});`],
      { encoding: 'utf8', timeout: 30_000, env },
    );
    assert.equal(imported.status, 0, `import failed:\n${imported.stderr}`);

    const run = spawnSync(process.execPath, ['--test', scaffoldPath], { encoding: 'utf8', timeout: 30_000, env });
    const report = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 0, `node --test failed:\n${report}`);
    assert.match(report, /\btodo 1\b/);
    assert.match(report, /\bfail 0\b/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — containment is asserted, not assumed
// ---------------------------------------------------------------------------

test('assertContained throws for a path that resolves outside its base', () => {
  const base = join(tmpdir(), 'gf-base');
  assert.throws(
    () => assertContained(base, join(base, '..', 'elsewhere', 'x.json')),
    (err) => err instanceof Error && err.message.startsWith('gate-fuzzing: refusing to write outside'),
  );
  // A sibling directory whose name merely starts with the base name is outside too.
  assert.throws(
    () => assertContained(base, `${base}-sibling${sep}x.json`),
    (err) => err.message.startsWith('gate-fuzzing: refusing to write outside'),
  );
  // The base itself is not "inside" the base.
  assert.throws(() => assertContained(base, base));
});

test('assertContained returns the resolved path for a contained file', () => {
  const base = join(tmpdir(), 'gf-base');
  assert.equal(assertContained(base, join(base, 'x.json')), resolve(base, 'x.json'));
  assert.equal(assertContained(base, join(base, 'deep', 'x.json')), resolve(base, 'deep', 'x.json'));
});
