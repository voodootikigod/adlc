// adversarial-review-template.test.mjs — prosecutes issue #60: a documented,
// not-force-installed CI template that wires `adversarial-review` into a risk
// gate (ADR-0007), mirroring the docs/ci/adlc-maintenance.yml "template, not
// force-installed" pattern.
//
// This file lives outside any single package (like rails-guard-ci.test.mjs
// and flag-consistency.test.mjs) because it asserts properties of a template
// document plus a cross-cutting CLI-usage contract, not the behavior of one
// package.
//
// Structural checks only (no YAML parser is a repo dependency, matching how
// the sibling docs/ci/*.yml templates are tested elsewhere in this repo —
// via hashing/shell execution rather than schema parsing). The one dynamic
// check (T-adlc60/AC6) actually runs the real gate-manifest binary against
// the exact --data payload shape the template emits, so the recording
// command is proven to work, not just present as text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(ROOT, 'docs', 'ci', 'adversarial-review.yml');
const GATE_MANIFEST_BIN = join(ROOT, 'packages', 'gate-manifest', 'bin', 'gate-manifest.mjs');

function readTemplate() {
  assert.ok(existsSync(TEMPLATE), `expected ${TEMPLATE} to exist`);
  return readFileSync(TEMPLATE, 'utf8');
}

// Explanatory `#` comments legitimately mention --loop/--evidence (to say why
// NOT to use them); only the executable (non-comment) lines must avoid them.
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

test('AC1: docs/ci/adversarial-review.yml exists and is a documented template (not force-installed)', () => {
  const text = readTemplate();
  // Same "copy into your repo" framing as docs/ci/adlc-maintenance.yml — this
  // template must not be wired into .github/workflows/ directly by this change.
  assert.match(text, /copy into your repo as/i);
  assert.ok(!existsSync(join(ROOT, '.github', 'workflows', 'adversarial-review.yml')),
    'the template must not be force-installed into .github/workflows/');
});

test('AC2: triggers on pull_request against main', () => {
  const text = readTemplate();
  assert.match(text, /on:\s*\n\s*pull_request:/);
});

test('AC3: risk-tier path filter covers every ADR-0007 category', () => {
  const text = readTemplate();
  // auth / trust boundary
  assert.match(text, /auth/i);
  // security controls / deny paths: rail guards, validators, sandboxes
  assert.match(text, /guard/i);
  assert.match(text, /validat/i);
  assert.match(text, /sandbox/i);
  // secrets handling
  assert.match(text, /secret/i);
  // data-loss / destructive / irreversible ops
  assert.match(text, /destructive|irreversible|data-loss/i);
  // schema / migration changes
  assert.match(text, /migrat/i);
  assert.match(text, /schema/i);
  // CI/CD / supply-chain config
  assert.match(text, /\.github\/workflows/);
});

test('AC4: uses plain (non-loop) review mode and documents why, citing adversarial-review#9', () => {
  const text = readTemplate();
  const executable = stripComments(text);
  assert.ok(!/--loop\b/.test(executable), 'no executable line may pass --loop (silently drops --providers per adversarial-review#9)');
  assert.match(text, /adversarial-review#9/, 'must document the reason, citing the upstream issue');
  assert.match(text, /--providers/);
});

test('AC5: high-risk job runs the documented invocation shape and posts a PR comment', () => {
  const text = readTemplate();
  assert.match(text, /npx --yes ["']?adversarial-review/);
  assert.match(text, /--base ["']?"?origin\/\$BASE_REF/);
  assert.match(text, /--providers auto/);
  assert.match(text, /--fail-on high/);
  assert.match(text, /gh pr comment/);
});

test('AC6: records the verdict via the CLI flag gate-manifest actually supports (--data, not the stale --evidence doc convention)', () => {
  const text = readTemplate();
  const executable = stripComments(text);
  assert.match(executable, /gate-manifest record adversarial-review/);
  assert.ok(!executable.includes('--evidence'),
    'gate-manifest record has no --evidence flag (node:util parseArgs strict mode throws ' +
    'ERR_PARSE_ARGS_UNKNOWN_OPTION) -- must use the real --data JSON flag');
  assert.match(executable, /--data\s+["']/);
});

test('AC6b: the --data JSON payload shape the template emits is accepted by the real gate-manifest binary', () => {
  const text = readTemplate();
  // Pull the record step's --data template out of the yml and substitute
  // sample values for the shell variables it interpolates, so we exercise
  // gate-manifest with the exact JSON *shape* the workflow will send. The
  // template double-quotes the payload for bash variable interpolation and
  // backslash-escapes the inner JSON quotes (`\"`) -- undo that escaping here
  // since we invoke the binary directly (no shell) with execFileSync.
  const match = text.match(/--data\s+"(\{[^\n]*\})"/);
  assert.ok(match, 'expected a --data "{...}" JSON payload in the record step');
  const sample = match[1]
    .replaceAll('\\"', '"')
    .replaceAll('$providers', 'claude,gpt')
    .replaceAll('$verdict', 'needs-attention')
    .replaceAll('$surviving', '1');

  const dir = mkdtempSync(join(tmpdir(), 'gm-adv-review-'));
  try {
    const out = execFileSync(
      process.execPath,
      [GATE_MANIFEST_BIN, 'record', 'adversarial-review', '--data', sample, '--dir', dir, '--json'],
      { encoding: 'utf8' },
    );
    const entry = JSON.parse(out);
    assert.equal(entry.gate, 'adversarial-review');
    assert.equal(entry.data.verdict, 'needs-attention');
    assert.equal(entry.data.providers, 'claude,gpt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC7: non-risk-tier paths skip the full quorum (cost control per ADR-0007)', () => {
  const text = readTemplate();
  // There must be a second job path gated on the low-risk output that does
  // NOT request the full multi-provider quorum.
  assert.match(text, /risk\s*==\s*['"]low['"]/);
  const lowJobMatch = text.match(/risk[^\n]*low[\s\S]*?(?=\njobs:|$)/);
  assert.ok(lowJobMatch);
});

test('AC8: pins actions to full commit SHAs, matching the sibling template convention', () => {
  const text = readTemplate();
  assert.match(text, /actions\/checkout@[0-9a-f]{40}/);
  if (/actions\/setup-node@/.test(text)) {
    assert.match(text, /actions\/setup-node@[0-9a-f]{40}/);
  }
});

test('AC9: docs/toolkit.md references the new CI template', () => {
  const toolkit = readFileSync(join(ROOT, 'docs', 'toolkit.md'), 'utf8');
  assert.match(toolkit, /ci\/adversarial-review\.yml/);
});

test('AC10: docs/toolkit.md\'s gate-manifest record example uses the real --data flag, not --evidence', () => {
  const toolkit = readFileSync(join(ROOT, 'docs', 'toolkit.md'), 'utf8');
  // The runnable example is the indented ("    adlc gate-manifest record ...")
  // code sample -- prose above it is allowed to name the old, incorrect
  // --evidence flag while explaining the correction.
  const exampleMatch = toolkit.match(/^ {4}adlc gate-manifest record adversarial-review[\s\S]*?\n\n/m);
  assert.ok(exampleMatch, 'expected a runnable gate-manifest record example in docs/toolkit.md');
  assert.match(exampleMatch[0], /--data\s+'/);
  assert.ok(!exampleMatch[0].includes('--evidence'),
    'the runnable example must not use the nonexistent --evidence flag');
});

test('AC11: docs/README.md CI templates section lists the new template, mirroring adlc-maintenance.yml', () => {
  const readme = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8');
  assert.match(readme, /ci\/adversarial-review\.yml/);
});
