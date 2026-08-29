// AC 28 / 37 / 77 / 125 — configuration: operator-local precedence and bounds,
// the threshold ceiling, the ticketSync block validated with ticket-sync's own
// schema, and the §13 example read out of the committed spec.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRepoConfig, resolveOperatorLocal, applyLowering, ConfigError, AUTOPILOT_DEFAULTS, OPERATOR_LOCAL_KEYS } from '../lib/config.mjs';
import { validateAgainst } from '../lib/schema-lite.mjs';
import { withMutation } from '../lib/mutations.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TS_SCHEMA = JSON.parse(readFileSync(join(REPO, 'packages', 'ticket-sync', 'schemas', 'adlc-config.schema.json'), 'utf8'));

/** The §13 example block, read from the committed spec (AC 125 self-test). */
export function specExampleConfig() {
  const spec = readFileSync(join(REPO, 'docs', 'specs', 'issue-autopilot-local.md'), 'utf8');
  const start = spec.indexOf('Repo-committed (`.adlc/config.json`, trust root):');
  const fence = spec.indexOf('```json', start);
  const end = spec.indexOf('```', fence + 7);
  return JSON.parse(spec.slice(fence + 7, end));
}

export function ac28_operatorLocalPrecedence() {
  const example = specExampleConfig();
  const withRepoThreshold = { ...example, autopilot: { ...example.autopilot, quotaThreshold: 80 } };
  const v = validateRepoConfig(withRepoThreshold, { ticketSyncSchema: TS_SCHEMA });
  assert.ok(v.warnings.some((w) => /SECURITY.*autopilot\.quotaThreshold/.test(w)), 'a repo quotaThreshold is warned');
  assert.equal(v.autopilot.quotaThreshold, undefined, 'and ignored');
  assert.equal(resolveOperatorLocal({}, {}).quotaThreshold, 50, 'the gate uses 50');
  assert.equal(resolveOperatorLocal({ quotaThreshold: 30 }, { ADLC_AUTOPILOT_QUOTA_THRESHOLD: '40' }).quotaThreshold, 30, 'flag > env');
  assert.equal(resolveOperatorLocal({}, { ADLC_AUTOPILOT_QUOTA_THRESHOLD: '40' }).quotaThreshold, 40, 'env > default');
  assert.throws(() => resolveOperatorLocal({ quotaReserve: 50 }, {}), (e) => e instanceof ConfigError && /quota-reserve/.test(e.code));
  assert.throws(() => applyLowering(v.autopilot, { maxRounds: 20 }), (e) => e instanceof ConfigError && /maxRounds/.test(e.code));
  assert.equal(applyLowering(v.autopilot, { maxRounds: 10 }).maxRounds, 10, 'lowering is honoured');
  for (const k of OPERATOR_LOCAL_KEYS) assert.ok(!(k in AUTOPILOT_DEFAULTS), `${k} is not a repo default`);
}
test('AC28: repo quotaThreshold 80 is warned+ignored (gate 50); env 40 + flag 30 → 30; reserve 50 exits 1; max-rounds 20 vs 15 exits 1 and 10 is honoured', ac28_operatorLocalPrecedence);

export async function ac28_seamsBite() {
  const example = specExampleConfig();
  await withMutation('config.honourRepoOperatorKeys', () => {
    const v = validateRepoConfig({ ...example, autopilot: { ...example.autopilot, quotaThreshold: 80 } }, { ticketSyncSchema: TS_SCHEMA });
    assert.equal(v.autopilot.quotaThreshold, 80, 'seam: the repo value leaks through');
  });
  await withMutation('config.allowRaise', () => {
    const v = validateRepoConfig(example, { ticketSyncSchema: TS_SCHEMA });
    assert.equal(applyLowering(v.autopilot, { maxRounds: 20 }).maxRounds, 20, 'seam: the CLI may raise');
  });
}
test('AC28: the config.honourRepoOperatorKeys and config.allowRaise seams remove the two protections (the fixtures the gate injects)', ac28_seamsBite);

export async function ac37_thresholdCeiling() {
  assert.throws(() => resolveOperatorLocal({ quotaThreshold: 51 }, {}), (e) => e instanceof ConfigError && e.exitCode === 1);
  assert.throws(() => resolveOperatorLocal({}, { ADLC_AUTOPILOT_QUOTA_THRESHOLD: '60' }), (e) => e instanceof ConfigError && e.exitCode === 1);
  assert.equal(resolveOperatorLocal({ quotaThreshold: 50 }, {}).quotaThreshold, 50);
  assert.equal(resolveOperatorLocal({ quotaThreshold: 20 }, {}).quotaThreshold, 20);
  assert.throws(() => resolveOperatorLocal({ quotaThreshold: 0 }, {}), ConfigError);
  await withMutation('config.acceptAnyThreshold', () => { assert.equal(resolveOperatorLocal({ quotaThreshold: 51 }, {}).quotaThreshold, 51, 'seam: 51 accepted'); });
}
test('AC37: --quota-threshold 51 and env 60 exit 1; 50 and 20 are accepted', ac37_thresholdCeiling);

export function ac77_ticketSyncValidates() {
  const example = specExampleConfig();
  assert.deepEqual(validateAgainst(TS_SCHEMA, { ticketSync: example.ticketSync }), [], 'the §13 block passes ticket-sync\'s schema');
  const nullQuery = { ...example, ticketSync: { ...example.ticketSync, select: { ...example.ticketSync.select, query: null } } };
  assert.throws(() => validateRepoConfig(nullQuery, { ticketSyncSchema: TS_SCHEMA }), (e) => e.code === 'bad-config' && /query/.test(e.message));
  const noProvider = { ...example, ticketSync: { select: { state: 'open' } } };
  assert.throws(() => validateRepoConfig(noProvider, { ticketSyncSchema: TS_SCHEMA }), (e) => e.code === 'bad-config' && /provider/.test(e.message));
  // Cross-check against the validator ticket-sync itself uses (the test may import it; the runtime may not).
  return import(join(REPO, 'packages', 'ticket-sync', 'lib', 'validate.mjs')).then(({ validateConfig }) => {
    assert.deepEqual(validateConfig({ ticketSync: example.ticketSync }), []);
    assert.ok(validateConfig({ ticketSync: nullQuery.ticketSync }).length > 0);
  });
}
test('AC77: the §13 ticketSync block passes packages/ticket-sync\'s schema (same validator); query:null and a missing provider fail', ac77_ticketSyncValidates);

export function ac125_exampleIsValidJsonAndSchemaClean() {
  const example = specExampleConfig();
  const v = validateRepoConfig(example, { ticketSyncSchema: TS_SCHEMA });
  assert.deepEqual(v.warnings, []);
  assert.equal(v.autopilot.repo, 'voodootikigod/adlc');
  assert.equal(v.autopilot.dispatchApproval, 'owner-or-label');
  assert.equal(v.autopilot.maxRounds, 15); assert.equal(v.autopilot.wallClockMinutes, 90); assert.equal(v.autopilot.reviewMaxBytes, 262144);
  assert.equal(v.fleet.reviewProvider, 'codex');
  assert.throws(() => validateRepoConfig({ ...example, ticketSync: { ...example.ticketSync, select: { ...example.ticketSync.select, query: null } } }, { ticketSyncSchema: TS_SCHEMA }), /bad-config/, 'the example with an invalid ticketSync fails the same schema');
  const unknownKey = { ...example, autopilot: { ...example.autopilot, bogus: 1 } };
  assert.throws(() => validateRepoConfig(unknownKey, { ticketSyncSchema: TS_SCHEMA }), (e) => e.code === 'bad-config' && /bogus/.test(e.message));
  const badMode = { ...example, autopilot: { ...example.autopilot, dispatchApproval: 'anyone' } };
  assert.throws(() => validateRepoConfig(badMode, { ticketSyncSchema: TS_SCHEMA }), (e) => e.code === 'bad-config');
}
test('AC125: the §13 example parses with JSON.parse and validates against both schemas; an unknown key or mode is bad-config', ac125_exampleIsValidJsonAndSchemaClean);
