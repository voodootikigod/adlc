// flag-consistency.test.mjs — cross-package conformance gate for T-adlc67.
//
// Every model-calling package in packages/ must support:
//   --prompt-only  (print the exact prompt(s) and exit 0, zero network calls)
//   --tier         (cheap|mid|frontier; reject anything else with a clear error)
//
// This test is intentionally table-driven and lives outside any single
// package (scripts/test/, like rails-guard-ci.test.mjs) because it asserts a
// cross-cutting contract, not the behavior of one tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Each entry describes one of the 9 model-calling packages: where its bin
// lives, and the minimal extra args (beyond --prompt-only / --tier) needed to
// reach the flag-handling code without hitting an unrelated required-arg
// error first. `setup(dir)` may create fixture files inside a scratch dir and
// return extra argv to append.
const PACKAGES = [
  {
    name: 'coldstart',
    bin: 'packages/coldstart/bin/coldstart.mjs',
    setup(dir) {
      const ticketsPath = join(dir, 'tickets.json');
      writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1', title: 'Test ticket' }] }));
      return ['--all', '--tickets', ticketsPath];
    },
  },
  {
    name: 'consensus-fix',
    bin: 'packages/consensus-fix/bin/consensus-fix.mjs',
    setup(dir) {
      const filePath = join(dir, 'target.mjs');
      writeFileSync(filePath, 'export const x = 1;\n');
      return ['--test-cmd', 'true', '--files', filePath];
    },
  },
  {
    name: 'gate-fuzzing',
    bin: 'packages/gate-fuzzing/bin/gate-fuzzing.mjs',
    setup(dir) {
      const suitePath = join(dir, 'gate-suite.json');
      writeFileSync(suitePath, JSON.stringify({ gates: [{ name: 'example-gate', claims: ['x'], surface: ['src/**'] }] }));
      return ['--suite', suitePath];
    },
    // gate-fuzzing rejects the 'frontier' tier by design (adversary cost
    // constraint) — use a value that's invalid everywhere for the bad-tier case.
  },
  {
    name: 'lesson-foundry',
    bin: 'packages/lesson-foundry/bin/lesson-foundry.mjs',
    setup() {
      return []; // no findings ledger in scratch cwd -> zero clusters, still prints
    },
  },
  {
    name: 'parallax',
    bin: 'packages/parallax/bin/parallax.mjs',
    setup() {
      return ['--request', 'example feature request'];
    },
  },
  {
    name: 'premortem',
    bin: 'packages/premortem/bin/premortem.mjs',
    setup(dir) {
      const specPath = join(dir, 'spec.md');
      writeFileSync(specPath, '# Spec\n\nDo the thing.\n');
      return [specPath];
    },
  },
  {
    name: 'rejection-mining',
    bin: 'packages/rejection-mining/bin/rejection-mining.mjs',
    setup() {
      return []; // must not shell out to gh at all in --prompt-only mode
    },
  },
  {
    name: 'spec-lint',
    bin: 'packages/spec-lint/bin/spec-lint.mjs',
    setup(dir) {
      const specPath = join(dir, 'spec.md');
      writeFileSync(specPath, '# Spec\n\n- [ ] some criterion (verify: `npm test`)\n');
      return [specPath];
    },
  },
  {
    name: 'review-calibration',
    bin: 'packages/review-calibration/bin/review-calibration.mjs',
    setup() {
      return []; // --prompt-only must work with zero other flags
    },
  },
];

function run(bin, args, cwd) {
  const result = spawnSync(process.execPath, [join(ROOT, bin), ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ADLC_AGY: '', ADLC_PROVIDER: '' },
    timeout: 15_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-flagcheck-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const pkg of PACKAGES) {
  test(`${pkg.name}: bin registers --prompt-only and --tier as parseable options`, () => {
    const source = readFileSync(join(ROOT, pkg.bin), 'utf8');
    assert.match(source, /['"]prompt-only['"]/, `${pkg.name} bin should define a --prompt-only option`);
    assert.match(source, /\btier\b/, `${pkg.name} bin should define a --tier option`);
  });

  test(`${pkg.name}: --prompt-only prints a prompt, exits 0, makes no network/LLM call`, () => {
    withScratchDir((dir) => {
      const extra = pkg.setup(dir);
      const { code, stdout, stderr } = run(pkg.bin, [...extra, '--prompt-only'], dir);
      assert.equal(code, 0, `${pkg.name} --prompt-only should exit 0\nstdout:${stdout}\nstderr:${stderr}`);
      assert.ok(stdout.trim().length > 0, `${pkg.name} --prompt-only should print something to stdout`);
      // No LLM/network error strings should leak through.
      assert.doesNotMatch(stderr, /ENOTFOUND|ECONNREFUSED|no LLM provider configured/i);
    });
  });

  test(`${pkg.name}: an invalid --tier value errors clearly`, () => {
    withScratchDir((dir) => {
      const extra = pkg.setup(dir);
      const { code, stdout, stderr } = run(pkg.bin, [...extra, '--tier', 'not-a-real-tier'], dir);
      assert.notEqual(code, 0, `${pkg.name} should reject an invalid --tier value`);
      assert.match(stdout + stderr, /tier/i, `${pkg.name} error message should mention "tier"`);
    });
  });
}

test('adlc --help documents the ticket-sync -> ticket dispatcher shorthand', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'packages/cli/bin/adlc.mjs'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ticket-sync/i);
});
