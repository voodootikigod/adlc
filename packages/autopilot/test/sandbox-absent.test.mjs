// The end-to-end fixtures pin `bwrap` to a FAKE path and never run the real
// binary, so whether the HOST has a sandbox backend must not decide their
// outcome. Here the host backend probe is made to find nothing (an empty PATH
// for this process while the run executes) and a full fixture run must still
// complete: the fixture supplies the backend its fake bwrap stands for.
//
// Regression test for a bugfix, not a spec criterion: absent from ac-registry.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectBackend } from '@adlc/fleet/lib/sandbox.mjs';
import { runIssue } from '../lib/run.mjs';
import { createSequenceFixture } from './helpers/sequence-fixture.mjs';

/** Run `fn` with a PATH on which no sandbox backend can be found. */
async function withoutHostSandbox(fn) {
  const empty = mkdtempSync(join(tmpdir(), 'ap-nobwrap-'));
  const saved = process.env.PATH;
  process.env.PATH = empty;
  try {
    assert.equal(detectBackend(), null, 'the host probe really finds no backend');
    return await fn();
  } finally {
    process.env.PATH = saved;
    rmSync(empty, { recursive: true, force: true });
  }
}

test('a fake-bwrap fixture run completes on a host with no sandbox backend', { timeout: 120_000 }, async () => {
  const fx = await createSequenceFixture();
  try {
    const result = await withoutHostSandbox(() => runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } }));
    assert.equal(result.state, 'done', `the run ends done: ${JSON.stringify(result)}`);
  } finally { fx.cleanup(); }
});
