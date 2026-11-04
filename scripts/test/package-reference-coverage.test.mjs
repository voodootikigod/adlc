// package-reference-coverage.test.mjs — every published package is findable.
//
// docs/package-reference.md says it is derived from packages/*/package.json, and
// the root README's package map is where a reader looks first. A new package
// that lands in neither is invisible to anyone not already reading its source,
// and nothing else in the suite compares the package set against either list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

/** `{dir, name}` for every non-private workspace package under packages/. */
function publishedPackages() {
  const base = join(ROOT, 'packages');
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, 'package.json')))
    .map((e) => ({ dir: e.name, pkg: JSON.parse(readFileSync(join(base, e.name, 'package.json'), 'utf8')) }))
    .filter(({ pkg }) => pkg.private !== true && typeof pkg.name === 'string')
    .map(({ dir, pkg }) => ({ dir, name: pkg.name }));
}

const PACKAGES = publishedPackages();

test('sanity: the package set is read from disk', () => {
  assert.ok(PACKAGES.length > 10, `expected many published packages, found ${PACKAGES.length}`);
});

test('every published package has a row in docs/package-reference.md', () => {
  const reference = readFileSync(join(ROOT, 'docs', 'package-reference.md'), 'utf8');
  const missing = PACKAGES.filter(({ name }) => !reference.includes(`| \`${name}\` |`)).map(({ name }) => name);
  assert.deepEqual(missing, [], `docs/package-reference.md has no table row for: ${missing.join(', ')}`);
});

test('every published package is linked from the README package map', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const missing = PACKAGES.filter(({ dir }) => !readme.includes(`](./packages/${dir})`)).map(({ dir }) => dir);
  assert.deepEqual(missing, [], `README.md's package map does not link: ${missing.join(', ')}`);
});

/**
 * Packages known to list LICENSE without shipping it. A ratchet, not an
 * allowance: each entry must still be a gap (the test below fails once it is
 * fixed, so the entry is removed), and nothing may be added.
 */
const LICENSE_GAPS = new Set([]);

function listsMissingLicense(dir) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'));
  return (pkg.files ?? []).includes('LICENSE') && !existsSync(join(ROOT, 'packages', dir, 'LICENSE'));
}

test('every published package ships the LICENSE its package.json lists', () => {
  const missing = PACKAGES.map(({ dir }) => dir).filter((dir) => listsMissingLicense(dir) && !LICENSE_GAPS.has(dir));
  assert.deepEqual(missing, [], `package.json "files" lists LICENSE but the file is absent in: ${missing.join(', ')}`);
});

test('every recorded LICENSE gap is still a gap — remove an entry once it is fixed', () => {
  const closed = [...LICENSE_GAPS].filter((dir) => !listsMissingLicense(dir));
  assert.deepEqual(closed, []);
  assert.ok(LICENSE_GAPS.size <= 1, 'the gap list only shrinks');
});

test('root README Use it in other editors list links GitHub Copilot integration guide (#853)', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\[GitHub Copilot\]\(\.\/docs\/integrations\/copilot\.md\)/);
});

test('CHANGELOG 1.11.0 section documents migration notes for build-gate, prosecute, premortem, and runner (#587, #615, #718, #761)', () => {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const start = changelog.indexOf('## [1.11.0]');
  const end = changelog.indexOf('## [1.10.0]');
  assert.ok(start !== -1 && end > start, '1.11.0 section exists');
  const sec = changelog.slice(start, end);
  assert.match(sec, /--bytes-threshold 262144/);
  assert.match(sec, /resolveChangeSetRevision/);
  assert.match(sec, /criss-cross/);
  assert.match(sec, /adlc premortem <spec\.md> --record-verdict <file> --ticket <id>/);
  assert.match(sec, /spec-approval/);
  assert.match(sec, /\{ok, operational, phase, ticket, errors\}/);
});
