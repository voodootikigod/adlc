// gate-fuzzing/lib/record.mjs
// Defeat recording: repro artifacts + cluster findings (§4).
// Only writes with --record flag. Default is dry-run.
//
// Every write here lands on the HOST, in the operator's real repository,
// outside the sandbox that confines the rest of the run. The defeat object is
// built from the adversary model's candidate (loop.mjs spreads the candidate
// into it), so nothing model-controlled may choose a path: the artifact id is
// derived from the harness-computed dedup hash, the target name is validated
// before it becomes a directory segment, and each write asserts containment.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { appendEntry } from '@adlc/core';

const ADLC_DIR = '.adlc';
const GATE_DEFEATS_DIR = join(ADLC_DIR, 'gate-defeats');

/** Characters a target package name may contain, and its length bound. */
const SAFE_TARGET_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HEX_RE = /^[0-9a-f]+$/i;
const ARTIFACT_ID_LENGTH = 16;

/**
 * True only for a plain package-name string: no separators, no `.`/`..`,
 * at most 64 characters. Anything else must never become a path segment.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeTarget(value) {
  if (typeof value !== 'string') return false;
  if (value === '.' || value === '..') return false;
  return SAFE_TARGET_RE.test(value);
}

/**
 * The filename stem for a defeat's artifacts: the first 16 hex characters of
 * the harness-computed dedup hash. The model-supplied `defeat.id` is never
 * consulted — it is echoed inside the artifact as `candidateId`, as data.
 *
 * @param {object} defeat
 * @returns {string}
 */
export function artifactId(defeat) {
  const hash = defeat?.hash;
  if (typeof hash === 'string' && hash.length > 0 && HEX_RE.test(hash)) {
    return hash.slice(0, ARTIFACT_ID_LENGTH);
  }
  return `cand-${Date.now()}`;
}

/**
 * Assert that `filePath` resolves strictly inside `baseDir`; return the
 * resolved path. Defence in depth behind isSafeTarget/artifactId: a future
 * caller that threads untrusted text into a path still cannot escape.
 *
 * @param {string} baseDir
 * @param {string} filePath
 * @returns {string} the resolved path
 */
export function assertContained(baseDir, filePath) {
  const base = resolve(baseDir);
  const target = resolve(filePath);
  if (!target.startsWith(base + sep)) {
    throw new Error(`gate-fuzzing: refusing to write outside ${base}: ${target}`);
  }
  return target;
}

/** mkdir -p `dir`, then write `content` at `dir/<name>` after asserting containment. */
function writeContained(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  const path = assertContained(dir, join(dir, name));
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * Write a defeat repro artifact to .adlc/gate-defeats/<artifactId>.json (§4.3)
 * and, for a safe target name, the RED test scaffold to
 * packages/<target>/test/bypass-<artifactId>.test.mjs.
 *
 * @param {object} defeat - Confirmed defeat with all fields
 * @param {string} [dir] - base dir (default '.')
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.warn] - stderr sink (default console.error)
 * @returns {string} path of the repro artifact written
 */
export function writeReproArtifact(defeat, dir = '.', { warn = console.error } = {}) {
  const id = artifactId(defeat);
  const target = defeat.target;
  const scaffold = buildRedTestScaffold({ ...defeat, id });

  const artifact = {
    id,
    candidateId: defeat.id ?? null,
    target,
    claimKind: defeat.claimKind,
    strategy: defeat.strategy,
    ts: new Date().toISOString(),
    diff: defeat.diff,
    setup: defeat.setup ?? [],
    witness: defeat.witnessProposal,
    witnessSource: defeat.verdict?.witnessSource ?? defeat.witnessSource,
    redTestScaffold: scaffold,
  };

  const reproPath = writeContained(join(dir, GATE_DEFEATS_DIR), `${id}.json`, JSON.stringify(artifact, null, 2));

  if (!isSafeTarget(target)) {
    warn(`gate-fuzzing: refusing to write a test scaffold for unsafe target ${JSON.stringify(target)}`);
    return reproPath;
  }

  // The RED test scaffold goes to the target package's test directory.
  const targetTestDir = join(dir, 'packages', target, 'test');
  try {
    writeContained(targetTestDir, `bypass-${id}.test.mjs`, scaffold);
  } catch (err) {
    // A containment violation is a bug, never a "warning"; let it surface.
    if (err.message.startsWith('gate-fuzzing: refusing to write outside')) throw err;
    // Otherwise (e.g. the target dir cannot be created) log but keep the artifact.
    warn(`Warning: could not write test scaffold to ${targetTestDir}: ${err.message}`);
  }

  return reproPath;
}

/**
 * Generate a RED test scaffold for the defeated gate: a node:test stub that
 * the operator turns into a real regression test. It imports only what it
 * uses, so the target package's `node --test test/*.test.mjs` keeps loading.
 *
 * @param {object} defeat
 * @returns {string} test scaffold source
 */
function buildRedTestScaffold(defeat) {
  const id = defeat.id ?? 'unknown';
  const target = defeat.target;
  const strategy = defeat.strategy ?? 'unknown';
  const claimKind = defeat.claimKind;

  return `// RED test scaffold — gate-fuzzing found bypass: ${id}
// Target: ${target} | Strategy: ${strategy} | Claim: ${claimKind}
// This test was auto-generated by gate-fuzzing.
// Make it PASS after fixing the gate.

import { test } from 'node:test';

test('regression: gate-bypass ${id} (${strategy}) should now be caught', (t) => {
  // This test was auto-generated by gate-fuzzing.
  // Apply the bypass diff, run ${target}, verify it exits 2 (caught).
  // Before the fix, ${target} exits 0 (defeat). After the fix, it must exit 2.

  // TODO: Set up a git repo, apply this diff, run ${target}
  // Bypass diff summary: see .adlc/gate-defeats/${id}.json

  t.todo('Implement RED test from repro: .adlc/gate-defeats/${id}.json');
});
`;
}

/**
 * Append a cluster finding to .adlc/findings.jsonl (§4.4).
 * Uses plain prose desc with NO quoted/backticked literal so it routes to SPEC-GAP not LINT.
 *
 * @param {object} defeat
 * @param {string} reproPath - path to the repro artifact
 * @param {string} [dir] - base dir
 */
export function appendFinding(defeat, reproPath, dir = '.') {
  const adlcDir = join(dir, ADLC_DIR);
  // desc: plain prose, no quoted/backtick literal (routes to SPEC-GAP via
  // lesson-foundry, not LINT — §4.4, F4). The artifact is named by its id and
  // its directory as two short tokens, never as one path: the committed
  // findings ledger refuses a 32+ character mixed letter/digit token with
  // high entropy (packages/core/lib/ledger.mjs, ADR 0014), and an absolute
  // repro path is exactly that.
  const id = basename(reproPath, '.json');
  const desc = `gate-fuzzing defeated ${defeat.target} using ${defeat.strategy ?? 'unknown'} strategy, ` +
    `violating ${defeat.claimKind} property. ` +
    `Repro artifact id ${id} under ${GATE_DEFEATS_DIR}`;

  // `file` names the defeated gate's bin only for a validated target; an
  // unsafe target name has no package directory, so point at the artifacts dir.
  const file = isSafeTarget(defeat.target)
    ? `packages/${defeat.target}/bin/${defeat.target}.mjs`
    : GATE_DEFEATS_DIR;

  const entry = {
    ts: new Date().toISOString(),
    tool: 'gate-fuzzing',
    file,
    line: 1,
    category: `gate-bypass:${defeat.strategy ?? 'unknown'}`,
    severity: 'high',
    desc,
    verdict: 'open',
    witnessSource: defeat.verdict?.witnessSource ?? defeat.witnessSource,
  };

  appendEntry('findings', entry, adlcDir);
  return entry;
}

/**
 * Record all defeats: write repro artifacts + append findings.
 * Only call with --record flag.
 *
 * @param {object[]} defeats
 * @param {string} [dir]
 * @param {object} [opts] - forwarded to writeReproArtifact (e.g. `warn`)
 * @returns {object[]} recorded entries with reproPath
 */
export function recordDefeats(defeats, dir = '.', opts = {}) {
  const recorded = [];
  for (const defeat of defeats) {
    const reproPath = writeReproArtifact(defeat, dir, opts);
    const finding = appendFinding(defeat, reproPath, dir);
    recorded.push({ ...defeat, reproPath, finding });
  }
  return recorded;
}
