// gitignore-parity.test.mjs — the manifest half of the ignore contract is
// hand-maintained in more than one place (@adlc/init's ADLC_GITIGNORE_LINES,
// @adlc/core's GITIGNORE_STANZA, and this repository's own .gitignore).
// They have already drifted once — core lacked every manifest line while
// init had them — which is exactly how a scaffolded repo ended up unable to
// commit its evidence ledger through the cursor/opencode/pi harnesses.
//
// This binds them: the manifest-related entries, and their relative order,
// must match. Entries outside that concern (init also tracks config.json)
// are deliberately not constrained.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADLC_GITIGNORE_LINES } from '../lib/gitignore-defaults.mjs';

const MANIFEST_RELATED = (line) => line.includes('manifest');

function gateManifestAdvice() {
  const src = readFileSync(new URL('../../gate-manifest/lib/enable.mjs', import.meta.url), 'utf8');
  return src
    .match(/export const MARKER_NEGATION_LINES = Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
    .split('\n').map((l) => l.trim().replace(/^'|',?$/g, '')).filter(Boolean);
}

function ticketsStanza() {
  const src = readFileSync(new URL('../../tickets/lib/migrate.mjs', import.meta.url), 'utf8');
  return src
    .match(/const GITIGNORE_STANZA = \[([\s\S]*?)\];/)[1]
    .split('\n')
    .map((l) => l.trim().replace(/^'|',?$/g, ''))
    .filter(Boolean);
}

function coreStanza() {
  const src = readFileSync(new URL('../../core/lib/scaffold-hygiene.mjs', import.meta.url), 'utf8');
  return src
    .match(/const GITIGNORE_STANZA = \[([\s\S]*?)\];/)[1]
    .split('\n')
    .map((l) => l.trim().replace(/^'|',?$/g, ''))
    .filter(Boolean);
}

test('all THREE stanzas agree on the manifest entries and their order', () => {
  const initManifest = ADLC_GITIGNORE_LINES.filter(MANIFEST_RELATED);
  assert.ok(initManifest.length > 0, 'the fixture would be vacuous if no list had manifest entries');
  // @adlc/tickets' migrationGitignoreText is the third copy — it rewrites a
  // repo's .gitignore during the legacy-store migration, so a stanza missing
  // the manifest.d lines leaves a just-migrated repo unable to use forest mode.
  for (const [label, stanza] of [['core', coreStanza()], ['tickets/migrate', ticketsStanza()]]) {
    assert.deepEqual(stanza.filter(MANIFEST_RELATED), initManifest,
      `${label} must emit the same manifest contract as init — a drift here silently breaks one path`);
  }
  // The FOURTH copy: gate-manifest's enable prints these lines as the fix when
  // it refuses. Advising a set that differs from what the scaffolders emit
  // sends operators in a circle — it omitted the *.tmp-* re-ignore.
  assert.deepEqual(gateManifestAdvice(), initManifest.filter((l) => l !== '!.adlc/manifest.jsonl'),
    "gate-manifest's remediation advice must match the manifest.d contract the scaffolders emit");
});

test('both stanzas anchor first and place every re-ignore after every negation', () => {
  for (const [label, stanza] of [['init', [...ADLC_GITIGNORE_LINES]], ['core', coreStanza()], ['tickets/migrate', ticketsStanza()]]) {
    assert.equal(stanza[0], '.adlc/*', `${label}: the anchor must come first`);
    const lastNegation = stanza.reduce((acc, line, i) => (line.startsWith('!') ? i : acc), -1);
    const firstReIgnore = stanza.findIndex((line, i) => i > 0 && !line.startsWith('!'));
    assert.ok(firstReIgnore > lastNegation,
      `${label}: every re-ignore must follow every negation, or it is dead under last-match-wins`);
    // Named explicitly: the invariant above passes vacuously if a re-ignore
    // is simply absent, which is how the *.tmp-* line went missing before.
    for (const required of ['.adlc/manifest.d/.lineage', '.adlc/manifest.d/*.lock', '.adlc/manifest.d/*.tmp-*']) {
      assert.ok(stanza.includes(required), `${label}: missing re-ignore ${required}`);
    }
  }
});

test("this repository's own .gitignore satisfies the same manifest contract", () => {
  // The reference implementation the ticket cites. If the repo's own file
  // drifts from what the scaffolders emit, one of them is wrong.
  const repoLines = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8').split('\n');
  for (const entry of ADLC_GITIGNORE_LINES.filter(MANIFEST_RELATED)) {
    assert.ok(repoLines.includes(entry), `this repo's .gitignore is missing ${entry}`);
  }
});
