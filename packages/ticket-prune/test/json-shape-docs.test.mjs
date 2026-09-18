import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJson } from '../lib/format.mjs';

// The `--json` shape is a contract consumers parse, and the docs are where they
// learn it. Three hand-maintained copies of the flag table drifted apart from the
// code and from each other: the README and docs/tools mirror omitted `archived`
// and `blocked`, and the site mirror listed a different subset again. A consumer
// on a sharded store reading the documented shape saw `tombstoned: []` and
// concluded nothing changed while `archived` held the removed tickets (#783).
// This guard derives the expected shape from `toJson` itself, so a key added in
// code without a docs update — or a mirror edited alone — fails here.

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(PKG, '..', '..');

const DOCS = [
  { name: 'README', path: join(PKG, 'README.md') },
  { name: 'docs/tools mirror', path: join(REPO, 'docs', 'tools', 'ticket-prune.md') },
  { name: 'docs site mirror', path: join(REPO, 'apps', 'docs', 'content', 'docs', 'toolkit', 'ticket-prune.mdx') },
];

const NOTE_PREFIX = '`--json` fields:';

/** The single flag-table row for `--json`, or a failure naming the file. */
function jsonRow(doc) {
  const rows = readFileSync(doc.path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('| `--json` |'));
  assert.equal(rows.length, 1, `${doc.name}: expected exactly one \`--json\` flag row, found ${rows.length}`);
  return rows[0];
}

/** The brace-delimited key list in a row, e.g. ['baseRef', 'stale[]']. */
function documentedKeys(row, docName) {
  const match = /`\{([^}`]*)\}`/.exec(row);
  assert.ok(match, `${docName}: the \`--json\` row has no \`{ … }\` shape`);
  return match[1].split(',').map((key) => key.trim()).filter(Boolean);
}

/** The shape `toJson` actually emits, with `[]` on exactly the array-valued keys. */
function emittedKeys() {
  const json = toJson({ baseRef: 'HEAD', write: false, stale: [], active: [] });
  return Object.entries(json).map(([key, value]) => (Array.isArray(value) ? `${key}[]` : key));
}

/** The one-line note under the flag table that says what each mutation array records. */
function fieldNote(doc) {
  const notes = readFileSync(doc.path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(NOTE_PREFIX));
  assert.equal(notes.length, 1, `${doc.name}: expected exactly one line starting with ${NOTE_PREFIX}, found ${notes.length}`);
  return notes[0];
}

for (const doc of DOCS) {
  test(`${doc.name}: the --json row lists exactly the keys toJson emits, in order, with [] on array keys`, () => {
    assert.deepEqual(documentedKeys(jsonRow(doc), doc.name), emittedKeys());
  });

  test(`${doc.name}: the field note says what archived, tombstoned, blocked and the ceremony fields record`, () => {
    const note = fieldNote(doc);
    for (const key of ['archived[]', 'tombstoned[]', 'blocked[]', 'ceremonyCompleted[]', 'ceremony']) {
      assert.ok(note.includes(`\`${key}\``), `${doc.name}: the field note does not mention \`${key}\``);
    }
    assert.match(note, /always empty/, `${doc.name}: the field note must say ceremonyCompleted[] is always empty`);
  });
}

test('the mirrors carry the same --json row and field note as the README', () => {
  const [readme, ...mirrors] = DOCS;
  for (const mirror of mirrors) {
    assert.equal(jsonRow(mirror), jsonRow(readme), `${mirror.name}: --json row differs from the README`);
    assert.equal(fieldNote(mirror), fieldNote(readme), `${mirror.name}: field note differs from the README`);
  }
});

test('the expected shape is derived from toJson, not restated', () => {
  // A guard that compared the docs to a hardcoded list would pass while toJson
  // and that list drifted together. Pin the derivation's two load-bearing facts:
  // it sees every key toJson returns, and it marks arrays by value, not by name.
  const keys = emittedKeys();
  assert.equal(keys.length, Object.keys(toJson({ baseRef: 'HEAD', write: false, stale: [], active: [] })).length);
  assert.ok(keys.includes('archived[]') && keys.includes('blocked[]'));
  assert.ok(keys.includes('baseRef') && keys.includes('ceremony'), 'scalar keys carry no [] marker');
});
