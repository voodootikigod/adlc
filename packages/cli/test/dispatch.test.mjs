import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin, resolveRunnerBin } from '../lib/dispatch.mjs';
import { isTool, suggest, TOOLS } from '../lib/registry.mjs';
import { renderHelp } from '../lib/help.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'adlc.mjs');

function runAdlc(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      cwd: options.cwd,
      stderr: 'pipe',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function withTempSpec(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-'));
  try {
    const path = join(dir, 'spec.md');
    writeFileSync(path, contents);
    return fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registry exposes the suite tools and omits internal packages', () => {
  assert.equal(TOOLS.length, 21);
  assert.equal(isTool('spec-lint'), true);
  assert.equal(isTool('prosecute'), true);
  assert.equal(isTool('ticket'), true);
  assert.equal(isTool('core'), false);
  assert.equal(isTool('runner'), false);
});

test('suggest returns near misses only', () => {
  assert.equal(suggest('spec-lnt'), 'spec-lint');
  assert.equal(suggest('railsguard'), 'rails-guard');
  assert.equal(suggest('zzzzzzzz'), null);
});

test('resolves package-local tool bins without PATH lookup', () => {
  assert.match(resolveBin('spec-lint') ?? '', /packages\/spec-lint\/bin\/spec-lint\.mjs$/);
  assert.match(resolveBin('prosecute') ?? '', /packages\/prosecute\/bin\/adlc-prosecute\.mjs$/);
  assert.match(resolveBin('ticket') ?? '', /packages\/ticket-sync\/bin\/ticket-sync\.mjs$/);
  assert.equal(resolveBin('definitely-not-real'), null);
});

test('resolves runner bin for run and accept verbs', () => {
  assert.match(resolveRunnerBin() ?? '', /packages\/runner\/bin\/adlc\.mjs$/);
});

test('help lists every routed tool and exits 0', () => {
  const { code, stdout } = runAdlc(['--help']);
  assert.equal(code, 0);
  for (const tool of TOOLS) assert.match(stdout, new RegExp(`\\b${tool.name}\\b`));
});

test('renderHelp embeds version and tool count', () => {
  const output = renderHelp('9.9.9');
  assert.match(output, /adlc 9\.9\.9/);
  assert.match(output, /Tools \(21\)/);
});

test('version prints a semver-shaped string', () => {
  const { code, stdout } = runAdlc(['--version']);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('unknown tool exits 1 with suggestion', () => {
  const { code, stderr } = runAdlc(['spec-lnt']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown tool/);
  assert.match(stderr, /did you mean "spec-lint"/);
});

test('routes to spec-lint and propagates exit 0', () => {
  withTempSpec('## Acceptance Criteria\n- Returns 200, verified by `curl -sf localhost`\n', (path) => {
    assert.equal(runAdlc(['spec-lint', path]).code, 0);
  });
});

test('routes to spec-lint and propagates exit 2', () => {
  withTempSpec('## Acceptance Criteria\n- It should feel fast and delightful\n', (path) => {
    assert.equal(runAdlc(['spec-lint', path]).code, 2);
  });
});

test('routes run verb to runner', () => {
  const { code, stdout } = runAdlc(['run', 'p5', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /adlc run <phase>/);
});

test('routes accept verb to runner', () => {
  const { code, stdout } = runAdlc(['accept', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /adlc accept --ticket id/);
});
