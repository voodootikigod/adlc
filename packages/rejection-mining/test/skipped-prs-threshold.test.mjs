// Tests for issue #744: fail operationally when 100% of PR details fail to fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fetchSignals } from '../lib/mine.mjs';

const BIN = fileURLToPath(new URL('../bin/rejection-mining.mjs', import.meta.url));

function writeFakeGh(dir, { prList = [{ number: 1, title: 'PR 1' }, { number: 2, title: 'PR 2' }], prViews = {}, viewFailures = {} }) {
  const fakeGh = join(dir, 'gh');
  const prListJson = JSON.stringify(prList);
  const prViewsJson = JSON.stringify(prViews);
  const viewFailuresJson = JSON.stringify(viewFailures);

  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('gh version 2.40.0');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify(${prListJson}));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const prNumber = args[2];
  const failures = ${viewFailuresJson};
  if (failures[prNumber]) {
    console.error(failures[prNumber]);
    process.exit(1);
  }
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

// ---------------------------------------------------------------------------
// Acceptance Criterion 1: When all PRs fail to fetch details, exit 1 with operational error
// ---------------------------------------------------------------------------

test('AC1: rejection-mining CLI exits 1 with operational error when 100% of PR details fail to fetch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-all-fail-'));
  try {
    writeFakeGh(dir, {
      prList: [
        { number: 1, title: 'PR 1' },
        { number: 2, title: 'PR 2' },
      ],
      viewFailures: {
        '1': 'API rate limit exceeded',
        '2': 'Resource not accessible by integration',
      },
    });

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
    };

    const res = spawnSync(process.execPath, [BIN], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      /All 2 PR\(s\) failed to fetch details\. Check GitHub API rate limits or token permissions\. \(cause: API rate limit exceeded\)/,
      'stderr must indicate all PRs failed to fetch details with first error cause',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1: rejection-mining CLI exits 1 when exactly 1 PR is found and its detail fetch fails (off-by-one defense)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-single-fail-'));
  try {
    writeFakeGh(dir, {
      prList: [
        { number: 1, title: 'PR 1' },
      ],
      viewFailures: {
        '1': 'API rate limit exceeded',
      },
    });

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
    };

    const res = spawnSync(process.execPath, [BIN], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      /All 1 PR\(s\) failed to fetch details\. Check GitHub API rate limits or token permissions\./,
      'stderr must indicate 1 PR failed to fetch details',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1: rejection-mining CLI exits 1 with operational error in --json mode when 100% of PR details fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-all-fail-json-'));
  try {
    writeFakeGh(dir, {
      prList: [
        { number: 1, title: 'PR 1' },
        { number: 2, title: 'PR 2' },
        { number: 3, title: 'PR 3' },
      ],
      viewFailures: {
        '1': 'network error',
        '2': 'network error',
        '3': 'network error',
      },
    });

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
    };

    const res = spawnSync(process.execPath, [BIN, '--json'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      /All 3 PR\(s\) failed to fetch details\. Check GitHub API rate limits or token permissions\./,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 2: When at least one PR succeeds, proceed normally and report skippedPRs
// ---------------------------------------------------------------------------

test('AC2: rejection-mining CLI succeeds and reports skipped PRs when at least one PR succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-partial-fail-'));
  try {
    writeFakeGh(dir, {
      prList: [
        { number: 1, title: 'PR 1' },
        { number: 2, title: 'PR 2' },
      ],
      prViews: {
        '1': {
          reviews: [
            { body: "don't expose raw errors to client", author: { login: 'alice' } },
            { body: "never expose raw error to client", author: { login: 'bob' } },
          ],
          comments: [],
        },
      },
      viewFailures: {
        '2': 'API rate limit exceeded',
      },
    });

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
    };

    const res = spawnSync(process.execPath, [BIN, '--min', '2'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}: stderr=${res.stderr}`);
    assert.match(res.stdout, /PRs scanned:\s+2/);
    assert.match(res.stdout, /PRs skipped:\s+1 \(fetch errors\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: rejection-mining CLI with --json outputs totalPRs and skippedPRs on partial success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-fake-partial-json-'));
  try {
    writeFakeGh(dir, {
      prList: [
        { number: 1, title: 'PR 1' },
        { number: 2, title: 'PR 2' },
      ],
      prViews: {
        '1': {
          reviews: [
            { body: "don't expose raw errors to client", author: { login: 'alice' } },
            { body: "never expose raw error to client", author: { login: 'bob' } },
          ],
          comments: [],
        },
      },
      viewFailures: {
        '2': 'API rate limit exceeded',
      },
    });

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
    assert.strictEqual(json.totalPRs, 2);
    assert.strictEqual(json.skippedPRs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unit tests for fetchSignals: firstError retention
// ---------------------------------------------------------------------------

test('fetchSignals: retains firstError on fetch error and returns null when no errors', async () => {
  const allFailRunner = (args) => {
    const key = args.join(',');
    if (key === 'pr,list,--state,all,--limit,10,--json,number,title') {
      return JSON.stringify([
        { number: 1, title: 'PR 1' },
        { number: 2, title: 'PR 2' },
      ]);
    }
    if (key.includes('pr,view,1')) {
      throw new Error('first error: unauthorized');
    }
    throw new Error('second error: rate limited');
  };

  const failResult = await fetchSignals({ limit: 10, ghRunner: allFailRunner });
  assert.strictEqual(failResult.totalPRs, 2);
  assert.strictEqual(failResult.skippedPRs, 2);
  assert.strictEqual(failResult.signals.length, 0);
  assert.strictEqual(failResult.firstError, 'first error: unauthorized');

  const cleanRunner = (args) => {
    const key = args.join(',');
    if (key === 'pr,list,--state,all,--limit,10,--json,number,title') {
      return JSON.stringify([{ number: 1, title: 'PR 1' }]);
    }
    return JSON.stringify({ reviews: [], comments: [] });
  };

  const cleanResult = await fetchSignals({ limit: 10, ghRunner: cleanRunner });
  assert.strictEqual(cleanResult.totalPRs, 1);
  assert.strictEqual(cleanResult.skippedPRs, 0);
  assert.strictEqual(cleanResult.firstError, null);
});
