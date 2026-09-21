// Tests for LLM failure exit and refined flag reporting (issue #747).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildHumanReport, buildJsonResult } from '../lib/report.mjs';

const BIN = fileURLToPath(new URL('../bin/rejection-mining.mjs', import.meta.url));

function setupFakeGh(dir, prViews = {}) {
  const fakeGh = join(dir, 'gh');
  const prViewsJson = JSON.stringify(prViews);
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('gh version 2.40.0');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify([
    { number: 1, title: 'PR 1' },
    { number: 2, title: 'PR 2' }
  ]));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const prNumber = args[2];
  const views = ${prViewsJson};
  const view = views[prNumber] || {
    reviews: [
      { body: "don't expose raw errors to clients", author: { login: 'alice' } },
      { body: "never expose raw errors in responses", author: { login: 'bob' } }
    ],
    comments: []
  };
  console.log(JSON.stringify(view));
  process.exit(0);
}
console.error('Unknown gh invocation:', args);
process.exit(1);
`;
  writeFileSync(fakeGh, script, { mode: 0o755 });
}

test('AC1: rejection-mining --llm exits 1 with operational error when all cluster refinements fail (no provider)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-'));
  try {
    setupFakeGh(dir);

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      ADLC_AGY: 'off',
      ADLC_PROVIDER: '',
    };

    const res = spawnSync(process.execPath, [BIN, '--llm', '--min', '2'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      /LLM refinement failed for all clusters\. Use --prompt-only to inspect prompts\./,
      'stderr must contain expected operational error message'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1: rejection-mining --llm exits 1 when all cluster refinements fail during LLM calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-'));
  try {
    setupFakeGh(dir);

    const fakeAgy = join(dir, 'fake-agy');
    const agyScript = `#!/usr/bin/env node
console.error('LLM API error: rate limit exceeded');
process.exit(1);
`;
    writeFileSync(fakeAgy, agyScript, { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ADLC_AGY: fakeAgy,
      ADLC_PROVIDER: 'agy',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
    };

    const res = spawnSync(process.execPath, [BIN, '--llm', '--min', '2'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      /LLM refinement failed for all clusters\. Use --prompt-only to inspect prompts\./,
      'stderr must contain expected operational error message'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: rejection-mining --json CLI outputs refined: false per lens when --llm not requested', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-'));
  try {
    setupFakeGh(dir);

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
    };

    const res = spawnSync(process.execPath, [BIN, '--json', '--min', '2'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 0, `expected exit 0: stderr=${res.stderr}`);
    const json = JSON.parse(res.stdout);
    assert.strictEqual(json.lensCount, 1);
    assert.strictEqual(json.lenses.length, 1);
    assert.strictEqual(typeof json.lenses[0].refined, 'boolean');
    assert.strictEqual(json.lenses[0].refined, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: rejection-mining --json CLI outputs refined: true when --llm succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-'));
  try {
    setupFakeGh(dir);

    const fakeAgy = join(dir, 'fake-agy');
    const agyScript = `#!/usr/bin/env node
console.log(JSON.stringify({
  title: 'Expose Raw Errors Guard',
  charter: 'when prosecuting a diff, specifically attempt to refute: raw error exposure'
}));
`;
    writeFileSync(fakeAgy, agyScript, { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ADLC_AGY: fakeAgy,
      ADLC_PROVIDER: 'agy',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
    };

    const res = spawnSync(process.execPath, [BIN, '--llm', '--json', '--min', '2'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 0, `expected exit 0: stderr=${res.stderr}`);
    const json = JSON.parse(res.stdout);
    assert.strictEqual(json.lensCount, 1);
    assert.strictEqual(json.lenses.length, 1);
    assert.strictEqual(json.lenses[0].refined, true);
    assert.strictEqual(json.lenses[0].title, 'Expose Raw Errors Guard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: rejection-mining --json CLI outputs refined: true and refined: false on partial failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-'));
  try {
    // Two distinct clusters: one for error exposure, one for hardcoding secrets
    const prViews = {
      '1': {
        reviews: [
          { body: "don't expose raw errors to clients", author: { login: 'alice' } },
          { body: "never expose raw errors in responses", author: { login: 'bob' } }
        ],
        comments: []
      },
      '2': {
        reviews: [
          { body: "avoid hardcoded api keys in source", author: { login: 'carol' } },
          { body: "never hardcode api keys in source", author: { login: 'dave' } }
        ],
        comments: []
      }
    };
    setupFakeGh(dir, prViews);

    const fakeAgy = join(dir, 'fake-agy');
    // Succeed on the first prompt, fail on the second
    const agyScript = `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => input += d);
process.stdin.on('end', () => {
  if (input.includes('api keys') || input.includes('hardcoded')) {
    console.error('Simulated LLM failure on hardcoded cluster');
    process.exit(1);
  }
  console.log(JSON.stringify({
    title: 'Expose Raw Errors Guard',
    charter: 'when prosecuting a diff, specifically attempt to refute: raw error exposure'
  }));
});
`;
    writeFileSync(fakeAgy, agyScript, { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ADLC_AGY: fakeAgy,
      ADLC_PROVIDER: 'agy',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
    };

    const res = spawnSync(process.execPath, [BIN, '--llm', '--json', '--min', '2'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 0, `expected exit 0 on partial failure: stderr=${res.stderr}`);
    const json = JSON.parse(res.stdout);
    assert.strictEqual(json.lensCount, 2);
    const refinedLens = json.lenses.find((l) => l.refined === true);
    const unrefinedLens = json.lenses.find((l) => l.refined === false);
    assert.ok(refinedLens, 'one lens must be refined: true');
    assert.ok(unrefinedLens, 'one lens must be refined: false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejection-mining CLI human report outputs no LLM failure message when --llm not requested', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-'));
  try {
    setupFakeGh(dir);

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
    };

    const res = spawnSync(process.execPath, [BIN, '--min', '2'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 0, `expected exit 0: stderr=${res.stderr}`);
    assert.match(res.stdout, /rejection-mining results/);
    assert.doesNotMatch(res.stdout, /LLM refinement failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejection-mining CLI human report outputs partial failure line when --llm has partial failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-'));
  try {
    const prViews = {
      '1': {
        reviews: [
          { body: "don't expose raw errors to clients", author: { login: 'alice' } },
          { body: "never expose raw errors in responses", author: { login: 'bob' } }
        ],
        comments: []
      },
      '2': {
        reviews: [
          { body: "avoid hardcoded api keys in source", author: { login: 'carol' } },
          { body: "never hardcode api keys in source", author: { login: 'dave' } }
        ],
        comments: []
      }
    };
    setupFakeGh(dir, prViews);

    const fakeAgy = join(dir, 'fake-agy');
    const agyScript = `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => input += d);
process.stdin.on('end', () => {
  if (input.includes('api keys') || input.includes('hardcoded')) {
    console.error('Simulated LLM failure on hardcoded cluster');
    process.exit(1);
  }
  console.log(JSON.stringify({
    title: 'Expose Raw Errors Guard',
    charter: 'when prosecuting a diff, specifically attempt to refute: raw error exposure'
  }));
});
`;
    writeFileSync(fakeAgy, agyScript, { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ADLC_AGY: fakeAgy,
      ADLC_PROVIDER: 'agy',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
    };

    const res = spawnSync(process.execPath, [BIN, '--llm', '--min', '2'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 0, `expected exit 0 on partial failure: stderr=${res.stderr}`);
    assert.match(res.stdout, /LLM refinement failed for 1 of 2 clusters/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildJsonResult: sets refined boolean flag per lens matching cluster.refined', () => {
  const clusters = [
    { slug: 'refined-cluster', title: 'Refined Title', count: 2, prNumbers: new Set([1]), refined: true },
    { slug: 'fallback-cluster', title: null, count: 3, prNumbers: new Set([2]), refined: false },
    { slug: 'unspecified-cluster', title: null, count: 1, prNumbers: new Set([3]) },
  ];
  const lensPlans = [
    { path: '.adlc/lenses/lens-refined-cluster.md' },
    { path: '.adlc/lenses/lens-fallback-cluster.md' },
    { path: '.adlc/lenses/lens-unspecified-cluster.md' },
  ];
  const result = buildJsonResult({
    clusters,
    lensPlans,
    totalSignals: 6,
    totalPRs: 3,
    skippedPRs: 0,
  });

  assert.strictEqual(result.lenses[0].refined, true);
  assert.strictEqual(result.lenses[1].refined, false);
  assert.strictEqual(result.lenses[2].refined, false);
});

test('buildHumanReport: reports partial LLM refinement failure when partial failures occur', () => {
  const clusters = [
    { slug: 'c1', title: 'Refined Title 1', count: 2, prNumbers: new Set([1]), refined: true },
    { slug: 'c2', title: 'c2', count: 2, prNumbers: new Set([2]), refined: false },
    { slug: 'c3', title: 'c3', count: 2, prNumbers: new Set([3]), refined: false },
  ];
  const lensPlans = [
    { path: '.adlc/lenses/lens-c1.md' },
    { path: '.adlc/lenses/lens-c2.md' },
    { path: '.adlc/lenses/lens-c3.md' },
  ];
  const lines = buildHumanReport({
    clusters,
    lensPlans,
    totalSignals: 6,
    totalPRs: 3,
    skippedPRs: 0,
    failedRefinements: 2,
  });
  const text = lines.join('\n');
  assert.match(text, /LLM refinement failed for 2 of 3 clusters/);

  const lines1 = buildHumanReport({
    clusters: clusters.slice(0, 2),
    lensPlans: lensPlans.slice(0, 2),
    totalSignals: 4,
    totalPRs: 2,
    skippedPRs: 0,
    failedRefinements: 1,
  });
  assert.match(lines1.join('\n'), /LLM refinement failed for 1 of 2 clusters/);
});

test('buildHumanReport: does not report LLM failure line when no failures occurred or failedRefinements omitted', () => {
  const clusters = [
    { slug: 'c1', title: 'Refined Title 1', count: 2, prNumbers: new Set([1]), refined: true },
    { slug: 'c2', title: 'Refined Title 2', count: 2, prNumbers: new Set([2]), refined: true },
  ];
  const lensPlans = [
    { path: '.adlc/lenses/lens-c1.md' },
    { path: '.adlc/lenses/lens-c2.md' },
  ];
  const linesZero = buildHumanReport({
    clusters,
    lensPlans,
    totalSignals: 4,
    totalPRs: 2,
    skippedPRs: 0,
    failedRefinements: 0,
  });
  assert.doesNotMatch(linesZero.join('\n'), /LLM refinement failed/);

  const linesOmitted = buildHumanReport({
    clusters,
    lensPlans,
    totalSignals: 4,
    totalPRs: 2,
    skippedPRs: 0,
  });
  assert.doesNotMatch(linesOmitted.join('\n'), /LLM refinement failed/);
});
