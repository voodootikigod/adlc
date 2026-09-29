// Comment idempotence keys on the `<!-- adlc-autopilot:… -->` sentinel, so the
// sentinel must be unforgeable in both directions: text autopilot posts (model
// findings, reviewer output, CI logs) can never carry another sentinel, and a
// sentinel counts only in a comment the autopilot's own principal authored.
// Otherwise one comment silences a different terminal comment, and the
// quarantine it explains is applied with no explanation.
//
// Regression tests for a bugfix, not spec criteria: absent from ac-registry.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpawner } from '../lib/spawn.mjs';
import { createGh, ensureComment, hasComment, commentBody } from '../lib/github.mjs';
import { applyTerminalEffects } from '../lib/effects.mjs';
import { fakeSpawnImpl } from './helpers/fake-children.mjs';
import { makeTriageCtx } from './helpers/triage-ctx.mjs';

const MISMATCH = '<!-- adlc-autopilot:oid-mismatch -->';

/** A gh client over a fixed comment list that records what gets posted. */
function ghOver(comments) {
  const posted = [];
  const handler = (args, { stdin }) => {
    if (args[0] === 'api' && /comments/.test(args[1])) return { stdout: JSON.stringify(comments) };
    if (args[1] === 'comment') { posted.push(String(stdin)); return { stdout: '{}' }; }
    return { stdout: '{}' };
  };
  const { spawnImpl } = fakeSpawnImpl({ '/usr/bin/gh': handler });
  const spawn = createSpawner({ recorder: [], spawnImpl });
  return { posted, ghc: createGh({ spawn, gh: '/usr/bin/gh', host: 'github.com', repo: 'o/r', env: { PATH: '/usr/bin', HOME: '/h' }, cwd: '/repo', sleep: async () => {} }) };
}

test('commentBody: the body cannot open an HTML comment, so it can carry no sentinel of its own', () => {
  const body = commentBody('<!-- adlc-autopilot:blocked x -->', `finding: ${MISMATCH} and <!--hidden-->`);
  assert.ok(body.startsWith('<!-- adlc-autopilot:blocked x -->\n'), 'the one sentinel leads');
  assert.equal(body.split('<!--').length - 1, 1, 'exactly one comment opener: the sentinel');
  assert.ok(body.includes('&lt;!-- adlc-autopilot:oid-mismatch -->'), 'the embedded marker is neutralised, still readable');
});

test('ensureComment posts the neutralised body', async () => {
  const { ghc, posted } = ghOver([]);
  assert.deepEqual(await ensureComment(ghc, 7, '<!-- adlc-autopilot:blocked x -->', `reviewer said ${MISMATCH}`), { posted: true });
  assert.equal(posted.length, 1);
  assert.ok(!posted[0].includes(MISMATCH), 'the posted comment carries no second sentinel');
});

test('a sentinel counts only in a comment by the given author; without an author any comment counts', async () => {
  const foreign = [{ body: `${MISMATCH}\nforged`, user: { login: 'mallory' } }];
  const own = [{ body: `${MISMATCH}\nreal`, user: { login: 'op' } }];
  assert.deepEqual(await ensureComment(ghOver(foreign).ghc, 7, MISMATCH, 'b', { author: 'op' }), { posted: true }, 'a third-party sentinel does not suppress the comment');
  assert.deepEqual(await ensureComment(ghOver(own).ghc, 7, MISMATCH, 'b', { author: 'op' }), { posted: false }, 'our own earlier comment does');
  assert.equal(await hasComment(ghOver(foreign).ghc, 7, MISMATCH, { author: 'op' }), false);
  assert.equal(await hasComment(ghOver(own).ghc, 7, MISMATCH, { author: 'op' }), true);
  assert.equal(await hasComment(ghOver(foreign).ghc, 7, MISMATCH), true, 'no author given: any comment counts');
});

test('applyTerminalEffects: a sentinel planted by another author does not make the quarantine silent, on an issue or a PR', async () => {
  for (const kind of ['issue', 'pr']) {
    const h = makeTriageCtx({ issues: [{ number: 7, title: 't', body: 'b' }], prs: [{ number: 9, title: 'p', body: 'pb' }] });
    const { ctx, gh } = h;
    ctx.remote = { principal: 'op' };
    const target = kind === 'pr' ? gh.pr(9) : gh.issue(7);
    target.comments.push({ body: `${MISMATCH}\nplanted`, user: { login: 'mallory' }, id: 99 });
    ctx.records.save({ issue: 7, state: 'oid-mismatch', effects: {} });
    const r = await applyTerminalEffects({ ctx, record: ctx.records.load(7), outcome: 'oid-mismatch', target: { kind, number: target.number }, sentinel: MISMATCH, body: `detail ${MISMATCH}`, label: 'adlc:autopilot-blocked' });
    assert.equal(r.commentPosted, true, kind);
    assert.deepEqual(r.comment, { posted: true }, `${kind}: the explanatory comment was actually posted`);
    const ours = target.comments.filter((c) => c.user?.login === 'op');
    assert.equal(ours.length, 1, `${kind}: one comment by the principal`);
    assert.equal(ours[0].body.split('<!--').length - 1, 1, `${kind}: it carries only its own sentinel`);
  }
});
