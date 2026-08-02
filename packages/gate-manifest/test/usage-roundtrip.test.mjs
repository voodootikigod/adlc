// usage-roundtrip.test.mjs — T152 read-side acceptance (operating-stack §8a).
//
// Every entry here is written through the REAL `record()` ledger path into a
// temp dir and read back through the REAL loader. Hand-constructing manifest
// entry objects and handing them straight to aggregateSpend would test the
// aggregator against a shape no producer has to actually emit — which is the
// test-integrity failure T152's acceptance criteria name explicitly.
//
// Offline, no API keys, temp dirs cleaned up per test (mirrors spend.test.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { record } from '../lib/record.mjs';
import { loadFiltered } from '../lib/show.mjs';
import { loadSpend } from '../lib/spend.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'gate-manifest-usage-roundtrip-'));
}

function cleanTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** The exact usage shape spend.mjs documents as the unit of account. */
function usage({ inputTokens = 0, outputTokens = 0, cachedTokens = 0 } = {}) {
  return { inputTokens, outputTokens, cachedTokens, provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'mid' };
}

/** Record through the real path; `data` lands verbatim under `entry.data`. */
function recordGate(dir, gate, data) {
  return record({ key: null, gate, dir, rawData: data === undefined ? undefined : JSON.stringify(data) });
}

describe('unknown is not zero (T152 no-fabrication rule)', () => {
  it('an unreported call and a genuine all-zero reported call are distinguishable, and only one is counted', () => {
    const dir = makeTmp();
    try {
      // The harness reported nothing: NO usage key at all, status says why.
      recordGate(dir, 'prosecute', { usageStatus: 'unreported' });
      // The provider genuinely reported zeros — a real, measured, free call.
      recordGate(dir, 'prosecute', { usage: usage(), usageStatus: 'reported' });

      const { entries } = loadFiltered({ dir });
      assert.equal(entries.length, 2);
      const [unreported, reportedZero] = entries;

      // The shapes must differ in the ONE way that matters to the aggregator:
      // presence of `data.usage`. Assert absence explicitly — a zeroed object
      // here would be indistinguishable from a measured free call downstream.
      assert.equal(unreported.data.usageStatus, 'unreported');
      assert.equal('usage' in unreported.data, false, 'an unreported call must carry NO usage key');

      assert.equal(reportedZero.data.usageStatus, 'reported');
      assert.deepEqual(
        { ...reportedZero.data.usage },
        { inputTokens: 0, outputTokens: 0, cachedTokens: 0, provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'mid' },
        'a genuine all-zero report is preserved verbatim, zeros and all'
      );

      // And the distinction survives aggregation: exactly ONE call is counted.
      // If the unreported entry had carried a zeroed usage object it would read
      // as 2 calls here, booking an unmeasured call as a measured free one and
      // collapsing "we don't know" into "it cost nothing".
      const { aggregate } = loadSpend({ dir });
      assert.equal(aggregate.entriesTotal, 2);
      assert.equal(aggregate.entriesWithUsage, 1);
      assert.equal(aggregate.total.calls, 1);
      assert.equal(aggregate.byPhase.P5.calls, 1);
      assert.equal(aggregate.byPhase.P5.inputTokens, 0);
      assert.equal(aggregate.byPhase.P5.outputTokens, 0);
    } finally {
      cleanTmp(dir);
    }
  });

  it('an unreported entry contributes a bucket that is EXPLICITLY unmeasured, never a zeroed one', () => {
    // This assertion was inverted deliberately. It used to require NO bucket,
    // on the reasoning that "nothing measured means no bucket, not a zeroed
    // one" — correct at the time, when the only alternatives were suppressing
    // the bucket or emitting one whose 0 tokens read as "this phase was free".
    //
    // A bucket can now say what it does not know (`unmeasuredCalls`), so the
    // hazard is addressed directly instead of by suppression — and suppression
    // was itself a defect: it made a --prompt-only workflow, where the harness
    // makes the model call and the tool never sees the tokens, aggregate to
    // literally nothing. The property below is STRICTER than the old one: the
    // bucket must exist AND prove it is unmeasured AND contribute no tokens.
    const dir = makeTmp();
    try {
      recordGate(dir, 'prosecute', { usageStatus: 'unreported' });
      const { aggregate } = loadSpend({ dir });
      assert.equal(aggregate.entriesWithUsage, 0, 'still nothing MEASURED');
      assert.equal(aggregate.total.calls, 0, '`calls` still counts measured calls only');
      assert.equal(aggregate.unmeasuredCalls, 1, 'and the call is visible as unmeasured');

      const p5 = aggregate.byPhase.P5;
      assert.ok(p5, 'the phase appears, so the shape of the work is visible');
      assert.equal(p5.unmeasuredCalls, 1);
      assert.equal(p5.calls, 0);
      assert.equal(p5.inputTokens, 0);
      assert.equal(p5.outputTokens, 0);
      assert.equal(p5.cachedTokens, 0);
    } finally {
      cleanTmp(dir);
    }
  });
});

describe('sibling fields (channel, transport, registryDigest)', () => {
  const SIBLINGS = {
    channel: 'gateway:opencode-go',
    transport: 'frontier-metered',
    registryDigest: 'sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  };

  it('are preserved verbatim through the real ledger roundtrip', () => {
    const dir = makeTmp();
    try {
      recordGate(dir, 'prosecute', { usage: usage({ inputTokens: 900, outputTokens: 150 }), usageStatus: 'claimed', ...SIBLINGS });

      const { entries } = loadFiltered({ dir });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].data.channel, SIBLINGS.channel);
      assert.equal(entries[0].data.transport, SIBLINGS.transport);
      assert.equal(entries[0].data.registryDigest, SIBLINGS.registryDigest);
    } finally {
      cleanTmp(dir);
    }
  });

  it('omit cleanly — an entry recorded without them carries no empty placeholders', () => {
    const dir = makeTmp();
    try {
      recordGate(dir, 'prosecute', { usage: usage({ inputTokens: 900, outputTokens: 150 }), usageStatus: 'claimed' });
      const { entries } = loadFiltered({ dir });
      for (const field of Object.keys(SIBLINGS)) {
        assert.equal(field in entries[0].data, false, `${field} must be absent, not null/empty`);
      }
    } finally {
      cleanTmp(dir);
    }
  });

  it('leave aggregateSpend byte-identical — siblings are recorded, never counted', () => {
    // The guarantee T152 owes the read side: enriching an entry with routing
    // provenance must not move a single number in the unit of account. Compared
    // as whole aggregates so a new counted field cannot slip in unnoticed.
    const withDir = makeTmp();
    const withoutDir = makeTmp();
    try {
      const spend = { usage: usage({ inputTokens: 900, outputTokens: 150, cachedTokens: 40 }), usageStatus: 'claimed' };
      recordGate(withDir, 'prosecute', { ...spend, ...SIBLINGS });
      recordGate(withoutDir, 'prosecute', spend);

      const a = loadSpend({ dir: withDir }).aggregate;
      const b = loadSpend({ dir: withoutDir }).aggregate;
      assert.deepEqual(a, b, 'sibling fields must not perturb the aggregate');
    } finally {
      cleanTmp(withDir);
      cleanTmp(withoutDir);
    }
  });
});
