// dispatch.test.mjs — offline, no network, no API keys, leaves no trace.
// Proves the dispatcher's two jobs: (1) correct tool resolution / routing,
// (2) verbatim propagation of the gate exit code (0 / 1 / 2).
//
// End-to-end cases route through the real @adlc/spec-lint, which is fully
// deterministic offline:
//   - a spec whose sole criterion has a verification method  -> exit 0
//   - a spec whose sole criterion is a wish (no method)      -> exit 2
//   - a missing spec path                                    -> exit 1

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { resolveBin } from '../lib/dispatch.mjs';
import { isTool, suggest, TOOLS } from '../lib/registry.mjs';
import { renderHelp } from '../lib/help.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'adlc.mjs');

/** Run the dispatcher bin; return { code, stdout, stderr }. */
function runAdlc(args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function withTempSpec(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-'));
  try {
    const p = join(dir, 'spec.md');
    writeFileSync(p, contents);
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- registry / resolution (pure) ----

test('registry knows exactly the 19 suite tools', () => {
  assert.equal(TOOLS.length, 19);
  assert.ok(isTool('spec-lint'));
  assert.ok(isTool('rails-guard'));
  assert.ok(!isTool('core')); // core has no bin
  assert.ok(!isTool('not-a-tool'));
});

test('suggest offers a near-miss for a typo and stays quiet on nonsense', () => {
  assert.equal(suggest('spec-lnt'), 'spec-lint');
  assert.equal(suggest('railsguard'), 'rails-guard');
  assert.equal(suggest('zzzzzzzzzzzz'), null);
});

test('resolveBin finds an installed tool and returns null for an unknown one', () => {
  const bin = resolveBin('spec-lint');
  assert.ok(bin && bin.endsWith('spec-lint.mjs'), `unexpected bin: ${bin}`);
  assert.equal(resolveBin('definitely-not-real'), null);
});

// ---- built-ins ----

test('--help lists every tool and exits 0', () => {
  const { code, stdout } = runAdlc(['--help']);
  assert.equal(code, 0);
  for (const t of TOOLS) assert.match(stdout, new RegExp(`\\b${t.name}\\b`));
});

test('renderHelp embeds the version and the tool count', () => {
  const out = renderHelp('9.9.9');
  assert.match(out, /adlc 9\.9\.9/);
  assert.match(out, /Tools \(19\)/);
});

test('--version prints a semver-shaped string and exits 0', () => {
  const { code, stdout } = runAdlc(['--version']);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('unknown tool exits 1 with a suggestion', () => {
  const { code, stderr } = runAdlc(['spec-lnt']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown tool/);
  assert.match(stderr, /did you mean "spec-lint"/);
});

// ---- exit-code propagation through a real tool ----

test('routes to spec-lint and propagates exit 0 (all criteria verified)', () => {
  withTempSpec('## Acceptance Criteria\n- Returns 200, verified by `curl -sf localhost`\n', (p) => {
    const { code } = runAdlc(['spec-lint', p]);
    assert.equal(code, 0);
  });
});

test('routes to spec-lint and propagates exit 2 (a wish gate-fails)', () => {
  withTempSpec('## Acceptance Criteria\n- It should feel fast and delightful\n', (p) => {
    const { code } = runAdlc(['spec-lint', p]);
    assert.equal(code, 2);
  });
});

test('routes to spec-lint and propagates exit 1 (operational error: missing path)', () => {
  const { code } = runAdlc(['spec-lint']);
  assert.equal(code, 1);
});

test('forwards trailing flags untouched (spec-lint --prompt-only exits 0)', () => {
  withTempSpec('## Acceptance Criteria\n- It should feel fast\n', (p) => {
    const { code } = runAdlc(['spec-lint', p, '--prompt-only']);
    assert.equal(code, 0); // prompt-only short-circuits the gate
  });
});
