// RAIL (t-herdr-8): fleet-status.json is a VERSIONED read-only observation
// surface. Every run's status carries `schemaVersion`, it round-trips through
// persistence, and the spec documents the versioning + degrade contract so an
// external observer (the herdr plugin, t-herdr-9) can depend on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newStatus, saveStatus, loadStatus, FLEET_STATUS_SCHEMA_VERSION } from '../lib/status.mjs';

test('AC1 newStatus stamps the exported schema version, which is a positive integer', () => {
  assert.ok(Number.isInteger(FLEET_STATUS_SCHEMA_VERSION) && FLEET_STATUS_SCHEMA_VERSION > 0, 'version is a positive integer');
  assert.equal(FLEET_STATUS_SCHEMA_VERSION, 1, 'the current fleet-status schema version is 1');
  const status = newStatus({ runId: 'r1', integrationBranch: 'adlc/run-r1', baseSha: 'abc' });
  assert.equal(status.schemaVersion, FLEET_STATUS_SCHEMA_VERSION);
});

test('AC2 the schema version round-trips through save/load persistence unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-fleet-schema-'));
  saveStatus(dir, newStatus({ runId: 'r2' }));
  const loaded = loadStatus(dir);
  assert.equal(loaded.schemaVersion, FLEET_STATUS_SCHEMA_VERSION);
});

test('AC3 the spec documents fleet-status.json as a versioned observation surface with a degrade contract', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const spec = readFileSync(join(repo, 'docs/specs/fleet-orchestration.md'), 'utf8');
  assert.match(spec, /schemaVersion/, 'spec names the schemaVersion field');
  assert.match(spec, /observ(ation|er)/i, 'spec frames the file as a read-only observation surface');
  assert.match(spec, /fleet status --json/, 'spec states the unknown-version degrade-to-polling fallback');
});
