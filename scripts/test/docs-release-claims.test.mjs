// Binds operator-facing prose to the code or config it describes: each test reads
// the source of truth (a CLI's USAGE, a JSON declaration, a lib predicate) and
// fails when the prose claims something that source does not do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Text from the heading matching `start` up to the next heading of the same level. */
function section(body, start) {
  const lines = body.split('\n');
  const from = lines.findIndex((l) => start.test(l));
  assert.notEqual(from, -1, `no heading matching ${start}`);
  const level = /^#+/.exec(lines[from])[0];
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((l) => new RegExp(`^${level} `).test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

const SKILL = '.claude/skills/issue-lanes/SKILL.md';

test('issue-lanes selection rules do not say completed tickets tier a change', () => {
  const selection = section(read(SKILL), /^## 1\. /);
  // tier.mjs skips every ticket whose `completed` is strictly true.
  assert.match(read('packages/prosecute/lib/tier.mjs'), /if \(ticket\?\.completed === true\) continue;/);
  assert.doesNotMatch(selection, /COMPLETED tickets included/i);
  assert.doesNotMatch(selection, /ALWAYS tiered/);
  assert.doesNotMatch(selection, /t\.completed!==true\) return/);
});

test('issue-lanes names every blocking check in docs/ci/required-gates.json as required', () => {
  const gates = JSON.parse(read('docs/ci/required-gates.json'));
  const blocking = Object.values(gates.workflows)
    .flatMap((jobs) => Object.values(jobs))
    .filter((job) => job.blocking === true)
    .flatMap((job) => job.contexts);
  const skill = read(SKILL);
  assert.doesNotMatch(skill, /do not describe them to the user as blocking/);
  const bullet = skill.split('\n- ').find((b) => /REQUIRED checks/.test(b)) ?? '';
  assert.match(bullet, /docs\/ci\/required-gates\.json/);
  for (const context of blocking) assert.ok(bullet.includes(`\`${context}\``), `required-checks bullet omits ${context}`);
});

/** Every `--flag` token the ticket-prune bin's USAGE string advertises. */
function ticketPruneUsageFlags() {
  const bin = read('packages/ticket-prune/bin/ticket-prune.mjs');
  const usage = /const USAGE = '([^']+)'/.exec(bin)[1];
  return new Set(usage.match(/--[a-z-]+/g));
}

for (const doc of ['packages/ticket-prune/README.md', 'apps/docs/content/docs/toolkit/ticket-prune.mdx']) {
  test(`${doc}: flag table and usage line match the CLI's accepted flags`, () => {
    const accepted = ticketPruneUsageFlags();
    const body = read(doc);
    const rows = body.split('\n').filter((l) => /^\| `--[a-z-]+/.test(l));
    const documented = new Set(rows.map((l) => /`(--[a-z-]+)/.exec(l)[1]));
    const usageLine = body.split('\n').find((l) => /ticket-prune \[/.test(l));
    const phantom = [...documented, ...(usageLine?.match(/--[a-z-]+/g) ?? [])].filter((f) => !accepted.has(f));
    assert.deepEqual(phantom, [], 'documented flags the CLI rejects');
    assert.deepEqual([...accepted].filter((f) => !documented.has(f)), [], 'accepted flags with no table row');
    assert.doesNotMatch(body, /tickets\.archive\.json/);
  });
}

test('no plugin prompt says ticket-prune --write archives into tickets.archive.json', () => {
  const docs = execFileSync('git', ['ls-files', 'plugins/*.md', 'plugins/**/*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.ok(docs.length > 0);
  const offenders = docs.filter((rel) => /tickets\.archive\.json/.test(read(rel)));
  assert.deepEqual(offenders, []);
});

test('model-router README ties exit 2 to non-frontier-category tickets only', () => {
  // router.mjs excludes frontier categories from the P3 finding set.
  assert.match(read('packages/model-router/lib/router.mjs'), /!FRONTIER_CATEGORIES\.has\(ticket\?\.category\) && a\.railDensity < floor/);
  const readme = read('packages/model-router/README.md');
  const claims = readme.split('\n').filter((l) => /exit 2|P3 gate-fail/.test(l));
  assert.ok(claims.length > 0);
  for (const line of claims) assert.doesNotMatch(line, /regardless of category/, line);
});

test('operating-stack spec status names its shipped implementation', () => {
  assert.ok(existsSync(join(ROOT, 'packages/quartermaster/package.json')));
  const status = read('docs/specs/operating-stack.md').split('\n').slice(0, 12).find((l) => /^Status:/.test(l)) ?? '';
  assert.doesNotMatch(status, /proposed|pending|not yet/i);
  assert.ok(status.includes('packages/quartermaster'), status);
});

test('CODEOWNERS does not claim a review backstop the ruleset declaration lacks', () => {
  const { pullRequestReview } = JSON.parse(read('docs/ci/required-gates.json'));
  const owners = read('CODEOWNERS');
  if (pullRequestReview === 'none') {
    assert.doesNotMatch(owners.replace(/\n#\s*/g, ' '), /rely on branch-protection\s+review/);
    assert.match(owners, /code-owner review is not required/i);
  }
});

test('actionlint workflow header claims only the files actionlint reads', () => {
  const header = read('.github/workflows/actionlint.yml').split('\n').filter((l) => l.startsWith('#')).join('\n');
  // actionlint's repository mode discovers .github/workflows only; action
  // metadata under .github/actions is never an input.
  assert.doesNotMatch(header, /\.github\/actions\/\*\*/);
  assert.match(header, /not linted/i);
});

test('CHANGELOG records the breaking changes made since 1.11.1', () => {
  // Everything above the 1.11.1 heading: [Unreleased] before a release, the new version's section after.
  const log = read('CHANGELOG.md');
  const since = log.slice(0, log.indexOf('\n## [1.11.1]'));
  assert.ok(log.includes('\n## [1.11.1]'), 'the 1.11.1 section is missing');
  assert.match(since, /^### Breaking$/m);
  assert.match(since, /generation-descriptor\.mjs/);
  assert.match(since, /--record-verdict[^\n]*--ticket/);
});
