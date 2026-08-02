// The §5/F8 ladder contract: which channel one ATTEMPT runs on (issue #401).
//
// Pure rules only — no registry, no dispatch. The fleet-side plumbing that
// turns these channels into seats and argv is exercised in
// packages/fleet/test/ladder-escalation.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LADDER_TIER_CHANNELS } from '../lib/channels.mjs';
import {
  LADDER_CHANNELS,
  channelForAttempt,
  escalationRungs,
  rungForAttempt,
} from '../lib/escalate.mjs';

const ladder = { job: 'build.ladder-start', mode: 'ladder' };

test('the ladder climbs cheap → mid → frontier, in that order', () => {
  assert.deepEqual([...LADDER_CHANNELS], ['cheap', 'mid', 'frontier']);
});

test('the ladder holds EXACTLY the channels routeJob can start a ladder on', () => {
  // The escalation list is ordered, so it cannot be read off the tier map at
  // runtime without depending on object key order. This pins the coupling
  // instead: add a ladder tier without adding its rung here (or vice versa) and
  // escalation would either skip a channel or climb onto one routing never
  // selects, and this fails.
  assert.deepEqual(
    [...LADDER_CHANNELS].sort(),
    [...new Set(Object.values(LADDER_TIER_CHANNELS))].sort(),
  );
});

test('attempt 1 is always the starting channel — the first strike never escalates', () => {
  for (const channel of LADDER_CHANNELS) {
    assert.equal(channelForAttempt({ ...ladder, channel, attempt: 1 }), channel);
  }
});

test('each later attempt climbs exactly one rung', () => {
  assert.equal(channelForAttempt({ ...ladder, channel: 'cheap', attempt: 2 }), 'mid');
  assert.equal(channelForAttempt({ ...ladder, channel: 'cheap', attempt: 3 }), 'frontier');
  assert.equal(channelForAttempt({ ...ladder, channel: 'mid', attempt: 2 }), 'frontier');
});

test('escalation STOPS at frontier rather than running off the end of the ladder', () => {
  // The two-strike policy only ever asks for attempt 2 today, but the rule has
  // to be total: a maxStrikes bump must not index past the ladder and return
  // undefined, which downstream would read as "no seat" and fail the dispatch.
  for (const channel of LADDER_CHANNELS) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const got = channelForAttempt({ ...ladder, channel, attempt });
      assert.ok(LADDER_CHANNELS.includes(got), `attempt ${attempt} from ${channel} → ${got}`);
    }
    assert.equal(channelForAttempt({ ...ladder, channel, attempt: 6 }), 'frontier');
  }
});

test('a ladder already at frontier stays at frontier for every attempt', () => {
  for (let attempt = 1; attempt <= 6; attempt++) {
    assert.equal(channelForAttempt({ ...ladder, channel: 'frontier', attempt }), 'frontier');
  }
});

test('direct mode does NOT escalate, even when the derived job is build.ladder-start', () => {
  // assign.mjs routes a ticket below the rail-density floor to
  // {tier: 'frontier', mode: 'direct'} while routeJob still DERIVES
  // build.ladder-start from its non-zero float. Keying escalation on the job
  // alone would climb a ladder the router deliberately refused to start.
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.equal(channelForAttempt({ job: 'build.ladder-start', mode: 'direct', channel: 'cheap', attempt }), 'cheap');
  }
  assert.deepEqual(escalationRungs({ job: 'build.ladder-start', mode: 'direct', channel: 'cheap' }), []);
});

test('a non-ladder job does NOT escalate, whatever its mode says', () => {
  for (const job of ['build.spec-class', 'build.critical-path', 'prosecute.lens']) {
    assert.equal(channelForAttempt({ job, mode: 'ladder', channel: 'mid', attempt: 3 }), 'mid');
    assert.deepEqual(escalationRungs({ job, mode: 'ladder', channel: 'mid' }), []);
  }
});

test('escalationRungs lists exactly the channels above the start, in climb order', () => {
  assert.deepEqual(escalationRungs({ ...ladder, channel: 'cheap' }), ['mid', 'frontier']);
  assert.deepEqual(escalationRungs({ ...ladder, channel: 'mid' }), ['frontier']);
  assert.deepEqual(escalationRungs({ ...ladder, channel: 'frontier' }), []);
});

test('an escalating seat on a channel that is not on the ladder fails closed', () => {
  // frontier-metered is a real §4a channel, but it is reached by a §7 fallback
  // traversal, never by climbing. Guessing a rung for it would silently move
  // spend onto a transport the ladder never sanctioned.
  assert.throws(
    () => escalationRungs({ ...ladder, channel: 'frontier-metered' }),
    /frontier-metered/,
  );
  assert.throws(
    () => channelForAttempt({ ...ladder, channel: 'frontier-metered', attempt: 2 }),
    /frontier-metered/,
  );
});

test('a non-positive or non-integer attempt fails closed rather than defaulting', () => {
  // A caller that lost track of the strike number must not silently be handed
  // the cheap starting seat — that is the silent downgrade routeJob refuses
  // for an absent float, and it fails the same way here.
  for (const attempt of [0, -1, 1.5, NaN, '2', undefined, null]) {
    assert.throws(
      () => channelForAttempt({ ...ladder, channel: 'cheap', attempt }),
      /attempt/,
      `attempt ${JSON.stringify(attempt)} should throw`,
    );
  }
});

test('rungForAttempt is generic over the rung payload, so seats and channels share ONE index rule', () => {
  // fleet resolves each rung to a SEAT and indexes the same way. Sharing this
  // function is what makes "the channel recorded" and "the seat dispatched"
  // incapable of disagreeing.
  const first = { channel: 'cheap', seat: { adapter: 'opencode' } };
  const rest = [
    { channel: 'mid', seat: { adapter: 'opencode' } },
    { channel: 'frontier', seat: { adapter: 'claude-code' } },
  ];
  assert.deepEqual(rungForAttempt(first, rest, 1), { value: first, escalated: false });
  assert.deepEqual(rungForAttempt(first, rest, 2), { value: rest[0], escalated: true });
  assert.deepEqual(rungForAttempt(first, rest, 3), { value: rest[1], escalated: true });
  assert.deepEqual(rungForAttempt(first, rest, 9), { value: rest[1], escalated: true });
  assert.deepEqual(rungForAttempt(first, [], 3), { value: first, escalated: false });
});
