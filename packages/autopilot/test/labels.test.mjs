// The label vocabulary and the §9.5 preflight item (AC 11 — the module half:
// `missingLabels` names the absent labels for `labels-missing`, `ensureLabels`
// creates each one idempotently; the `once` exit 1 lives in preflight.test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpawner } from '../lib/spawn.mjs';
import { createGh } from '../lib/github.mjs';
import { LABELS, ALL_LABELS, STOP_LABELS, EXCLUDING_LABELS, LABEL_META, missingLabels, ensureLabels, listLabelNames } from '../lib/labels.mjs';
import { fakeSpawnImpl } from './helpers/fake-children.mjs';

function harness(handler) {
  const recorder = [];
  const { spawnImpl } = fakeSpawnImpl({ '/usr/bin/gh': handler });
  const spawn = createSpawner({ recorder, spawnImpl });
  const gh = createGh({ spawn, gh: '/usr/bin/gh', host: 'github.com', repo: 'o/r', env: { PATH: '/usr/bin', HOME: '/h' }, cwd: '/repo', sleep: async () => {} });
  return { recorder, gh };
}
const labelsPage = (names) => JSON.stringify(names.map((name, i) => ({ id: i + 1, name, color: '000000' })));

export async function ac11_missingLabelsNamesTheAbsentOnes() {
  assert.deepEqual([...ALL_LABELS], ['adlc:autopilot', 'adlc:autopilot-skip', 'adlc:needs-clarification', 'adlc:autopilot-blocked', 'adlc:autopilot-stale', 'adlc:autopilot-ci-red', 'adlc:needs-human', 'adlc:autopilot-log'], 'the eight §9.5 labels');
  assert.deepEqual([...STOP_LABELS], [LABELS.blocked, LABELS.stale, LABELS.ciRed, LABELS.clarify, LABELS.skip], 'the five --force lifts');
  assert.deepEqual([...EXCLUDING_LABELS], ['trust-root-change', 'question', 'wontfix', 'duplicate', 'invalid', LABELS.skip, LABELS.blocked, LABELS.stale, LABELS.ciRed, LABELS.clarify, LABELS.needsHuman, LABELS.log], 'the §4.2 set');
  // two of eight absent → exactly those two, in LABELS order
  const present = ALL_LABELS.filter((n) => n !== LABELS.stale && n !== LABELS.log).concat(['bug', 'P0-critical']);
  const { recorder, gh } = harness((args) => ({ stdout: /page=1\b/.test(args[1]) ? labelsPage(present) : '[]' }));
  assert.deepEqual(await missingLabels(gh), [LABELS.stale, LABELS.log]);
  assert.ok(recorder.every((r) => r.argv[1] === 'api' && /repos\/o\/r\/labels\?per_page=100&page=\d+/.test(r.argv[2]) && !r.argv.includes('--paginate')), 'one page per api call, never --paginate');
  // all present → nothing missing; a short page stops the walk
  const full = harness(() => ({ stdout: labelsPage(ALL_LABELS) }));
  assert.deepEqual(await missingLabels(full.gh), []);
  assert.equal(full.recorder.length, 1);
  // a full first page is followed by page 2
  const paged = harness((args) => ({ stdout: /page=1\b/.test(args[1]) ? labelsPage(Array.from({ length: 100 }, (_, i) => `l${i}`)) : labelsPage(ALL_LABELS) }));
  assert.deepEqual(await missingLabels(paged.gh), []);
  assert.equal(paged.recorder.length, 2);
  // unreadable → fail closed, never "nothing missing"
  await assert.rejects(missingLabels(harness(() => ({ status: 1, stderr: 'HTTP 401' })).gh), { code: 'labels-unreadable' });
  await assert.rejects(listLabelNames(harness(() => ({ stdout: '{"name":"x"}' })).gh), { code: 'labels-unreadable' });
  await assert.rejects(listLabelNames(harness(() => ({ stdout: '[{"id":1}]' })).gh), { code: 'labels-unreadable' });
}
test('AC11: §9.5 labels — missingLabels names exactly the absent autopilot labels via one-page-per-call enumeration and fails closed when the listing is unreadable; STOP/EXCLUDING sets are the spec lists', ac11_missingLabelsNamesTheAbsentOnes);

export async function ac11_ensureLabelsCreatesIdempotently() {
  const { recorder, gh } = harness(() => ({ stdout: '' }));
  const r = await ensureLabels(gh);
  assert.deepEqual(r.created, [...ALL_LABELS]);
  assert.equal(recorder.length, ALL_LABELS.length, 'one gh label create per label');
  for (const [i, rec] of recorder.entries()) {
    const name = ALL_LABELS[i];
    assert.deepEqual(rec.argv.slice(0, 4), ['/usr/bin/gh', 'label', 'create', name]);
    assert.ok(rec.argv.includes('--force'), `${name}: --force makes creation idempotent`);
    assert.equal(rec.argv[rec.argv.indexOf('--color') + 1], LABEL_META[name].color);
    assert.equal(rec.argv[rec.argv.indexOf('--repo') + 1], 'github.com/o/r', 'host-bound');
    assert.equal(rec.env.GH_HOST, 'github.com');
  }
  // a failing create names the label and stops
  const failing = harness((args) => (args[2] === LABELS.blocked ? { status: 1, stderr: 'HTTP 403 forbidden' } : { stdout: '' }));
  await assert.rejects(ensureLabels(failing.gh), (e) => e.code === 'label-create-failed' && e.message.includes(LABELS.blocked));
  assert.equal(failing.recorder.length, ALL_LABELS.indexOf(LABELS.blocked) + 1, 'stops at the failure');
  // only autopilot labels can be created through this path
  await assert.rejects(ensureLabels(gh, { labels: ['bug'] }), { code: 'label-create-failed' });
}
test('AC11: ensureLabels creates every §9.5 label with `gh label create <name> --force` (idempotent, host-bound) and fails naming the label when gh refuses', ac11_ensureLabelsCreatesIdempotently);
