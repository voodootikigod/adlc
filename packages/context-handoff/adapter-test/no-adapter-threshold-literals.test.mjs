// no-adapter-threshold-literals.test.mjs — the enforcing-tier adapters must
// resolve every band threshold through `@adlc/context-handoff` (slice 5).
//
// The spec is explicit: "Thresholds only via lib/thresholds.mjs (adapters MUST
// import)". A copied 60 in one adapter is not a visible bug — it is a gate that
// silently stops agreeing with the other three the day a threshold moves.
//
// SCOPE: the handoff adapter sources this slice ships, not the whole plugin
// tree. Sibling hooks legitimately inline the BUILD-GATE thresholds (they
// cannot resolve npm packages at runtime and are pinned by their own drift
// tests), so a plugin-wide scan would flag a copy that is already governed.
// The repo-wide literal ban is issue #474.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WARN_PCT,
  HANDOFF_PCT,
  HARD_PCT,
  WARN_DEPTH,
  HANDOFF_DEPTH,
  HARD_DEPTH,
  WARN_BYTES,
  HANDOFF_BYTES,
  HARD_BYTES,
} from '@adlc/context-handoff';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The handoff adapter sources shipped by slice 5, plus the slice-4 reference. */
const ADAPTER_SOURCES = [
  'plugins/adlc-codex/hooks/adlc-handoff-gate.mjs',
  'plugins/adlc-opencode/lib/handoff-gate.mjs',
  'plugins/adlc-pi/lib/handoff-gate.mjs',
  'plugins/adlc-claude-code/hooks/handoff-gate.mjs',
];

/**
 * Declarations that hold a band value for a reason that is NOT a threshold
 * comparison. Each entry is a deliberate, reviewed exception — keep it short.
 *
 * Empty on purpose. The one candidate was the Codex hook's transcript read
 * window, which equals HARD_BYTES by construction (scanning past the hard band
 * buys nothing, since a transcript that large already denies on bytes). Rather
 * than exempt the copy, the hook now takes the window from the loaded package.
 */
const ALLOWLIST = [];

const BAND_VALUES = [
  WARN_PCT,
  HANDOFF_PCT,
  HARD_PCT,
  WARN_DEPTH,
  HANDOFF_DEPTH,
  HARD_DEPTH,
  WARN_BYTES,
  HANDOFF_BYTES,
  HARD_BYTES,
];

/** Byte thresholds are usually written `N * 1024`; accept both spellings. */
function literalSpellings(value) {
  const spellings = [String(value)];
  if (value % 1024 === 0 && value >= 1024) {
    spellings.push(`${value / 1024} * 1024`, `${value / 1024}*1024`);
  }
  return spellings;
}

/** Strip comments so prose about a threshold is not read as a threshold. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Findings for one adapter source.
 * @param {string} source file text
 * @param {string[]} allowedIdentifiers declarations exempted for this file
 * @returns {string[]} human-readable violations
 */
export function findThresholdLiterals(source, allowedIdentifiers = []) {
  const code = stripComments(source);
  const findings = [];

  // 1. A locally DECLARED threshold identifier. Thresholds are imported, never
  //    re-declared — an adapter that owns one has already forked the contract.
  const declRe = /(?:const|let|var)\s+((?:WARN|HANDOFF|HARD)_[A-Z0-9_]+|[A-Z0-9_]*THRESHOLD[A-Z0-9_]*)\s*=/g;
  let m;
  while ((m = declRe.exec(code)) !== null) {
    if (allowedIdentifiers.includes(m[1])) continue;
    findings.push(`declares threshold identifier ${m[1]}`);
  }

  // 2. A band value in a comparison: `pct >= 60`, `depth > 40`, `bytes === 262144`.
  for (const value of BAND_VALUES) {
    for (const spelling of literalSpellings(value)) {
      const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cmpRe = new RegExp(`(?:[<>]=?|={2,3}|!={1,2})\\s*${escaped}\\b`);
      if (cmpRe.test(code)) findings.push(`compares against band literal ${spelling}`);
    }
  }

  // 3. A band value as the initializer of any declaration, allowlist aside.
  const initRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\d\s*]+?)\s*;/g;
  while ((m = initRe.exec(code)) !== null) {
    const [, identifier, rawValue] = m;
    if (allowedIdentifiers.includes(identifier)) continue;
    const normalized = rawValue.replace(/\s+/g, '');
    for (const value of BAND_VALUES) {
      const spellings = literalSpellings(value).map((s) => s.replace(/\s+/g, ''));
      if (spellings.includes(normalized)) {
        findings.push(`declares ${identifier} = ${rawValue.trim()} (band value ${value})`);
      }
    }
  }

  return findings;
}

test('the thresholds under test are the package\'s, not a copy', () => {
  assert.ok(WARN_PCT < HANDOFF_PCT && HANDOFF_PCT < HARD_PCT);
  assert.ok(WARN_DEPTH < HANDOFF_DEPTH && HANDOFF_DEPTH < HARD_DEPTH);
  assert.ok(WARN_BYTES < HANDOFF_BYTES && HANDOFF_BYTES < HARD_BYTES);
});

test('every scanned adapter source actually exists', () => {
  // A scan over a renamed-away file passes vacuously; make that impossible.
  for (const rel of ADAPTER_SOURCES) {
    assert.equal(existsSync(join(REPO_ROOT, rel)), true, `${rel} is missing`);
  }
});

test('no enforcing adapter declares or compares a band threshold literal', () => {
  for (const rel of ADAPTER_SOURCES) {
    const allowed = ALLOWLIST.filter((a) => a.file === rel).map((a) => a.identifier);
    const findings = findThresholdLiterals(readFileSync(join(REPO_ROOT, rel), 'utf8'), allowed);
    assert.deepEqual(
      findings,
      [],
      `${rel} must resolve thresholds through @adlc/context-handoff: ${findings.join('; ')}`,
    );
  }
});

test('every gate-evaluating adapter reaches the package to decide', () => {
  // The three slice-5 adapters own the decision. (The Claude Code
  // handoff-gate.mjs is scanned for literals but decides nothing — its hook
  // calls api.evaluateHandoffPreToolUse; cc-helper-drift.test.mjs pins the two
  // pure helpers it does keep.)
  const deciders = {
    // A hook script cannot bare-import from a plugin install dir; it resolves.
    'plugins/adlc-codex/hooks/adlc-handoff-gate.mjs': /api\.evaluateHandoffPreToolUse\(/,
    // Loaded by the host as an npm package, so a plain import.
    'plugins/adlc-opencode/lib/handoff-gate.mjs':
      /import \{[\s\S]*evaluateHandoffPreToolUse[\s\S]*\} from '@adlc\/context-handoff'/,
    'plugins/adlc-pi/lib/handoff-gate.mjs':
      /import \{[\s\S]*evaluateHandoffPreToolUse[\s\S]*\} from '@adlc\/context-handoff'/,
  };
  for (const [rel, pattern] of Object.entries(deciders)) {
    assert.ok(ADAPTER_SOURCES.includes(rel), `${rel} must also be literal-scanned`);
    assert.match(readFileSync(join(REPO_ROOT, rel), 'utf8'), pattern, `${rel} never reaches the package`);
  }
});

test('the allowlist is documented and stays small', () => {
  assert.ok(ALLOWLIST.length <= 2, 'a growing allowlist means the rule is not holding');
  for (const entry of ALLOWLIST) {
    assert.ok(entry.why.length > 40, `${entry.identifier} needs a real justification`);
    assert.ok(ADAPTER_SOURCES.includes(entry.file), `${entry.file} is not scanned`);
  }
});

test('the read window is taken from the package, not re-declared', () => {
  // A local window constant equal to HARD_BYTES cannot be killed by any
  // behavioural test — a transcript large enough to trigger windowing already
  // denies on the bytes signal — so it must not exist in the first place.
  const source = readFileSync(
    join(REPO_ROOT, 'plugins/adlc-codex/hooks/adlc-handoff-gate.mjs'),
    'utf8',
  );
  assert.match(source, /maxScanBytes:\s*api\.HARD_BYTES/);
  assert.doesNotMatch(stripComments(source), /MAX_SCAN_BYTES\s*=/);
});

test('the scan bites', () => {
  // A checker that never rejects anything is the failure mode this test class
  // exists to prevent — prove each rule fires on a planted violation.
  assert.deepEqual(findThresholdLiterals('const HANDOFF_PCT = 60;\n'), [
    'declares threshold identifier HANDOFF_PCT',
    `declares HANDOFF_PCT = ${HANDOFF_PCT} (band value ${HANDOFF_PCT})`,
  ]);
  assert.deepEqual(findThresholdLiterals('const DEPTH_THRESHOLD = 7;\n'), [
    'declares threshold identifier DEPTH_THRESHOLD',
  ]);
  assert.ok(
    findThresholdLiterals(`if (observed.pct >= ${HANDOFF_PCT}) deny();\n`).some((f) =>
      f.startsWith('compares against band literal'),
    ),
  );
  assert.ok(
    findThresholdLiterals(`const CAP = ${HARD_BYTES / 1024} * 1024;\n`).some((f) =>
      f.startsWith('declares CAP'),
    ),
  );
  // …and that the allowlist is what silences it, not a hole in the rule.
  assert.deepEqual(findThresholdLiterals(`const CAP = ${HARD_BYTES / 1024} * 1024;\n`, ['CAP']), []);
});

test('comments about a threshold are not mistaken for one', () => {
  assert.deepEqual(findThresholdLiterals(`// the handoff band is ${HANDOFF_PCT}%\n`), []);
  assert.deepEqual(findThresholdLiterals(`/* pct >= ${HANDOFF_PCT} denies */\n`), []);
});
