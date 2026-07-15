#!/usr/bin/env node
// Maintain CHANGELOG.md for the lockstep @adlc release.
//
//   node scripts/changelog.mjs <version> [--date YYYY-MM-DD] [--from <ref>]
//
// Derives a new "## [version] - date" section from the conventional-commit
// subjects since the previous release tag and prepends it under the CHANGELOG
// header. Run this DURING the release ceremony (after the version bump, before
// the bump commit) so the changelog entry lands in the same commit as the bump.
//
// The output is a STARTING POINT: it groups feat/fix/perf/refactor commits and
// drops chore/test/ci/docs noise. Review and hand-edit the generated section
// before committing — a good changelog is curated, not just a commit dump.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

const HEADER = `# Changelog

All notable changes to the \`@adlc\` suite are documented here.

The suite is released in **lockstep** — every package shares one version and is
published together.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;

// Conventional-commit type → changelog section. Types not listed (chore, test,
// ci, build, docs) are treated as internal and omitted from the user-facing log.
const SECTIONS = [
  ['Added', new Set(['feat'])],
  ['Fixed', new Set(['fix'])],
  ['Performance', new Set(['perf'])],
  ['Changed', new Set(['refactor'])],
];

function git(args, { cwd = ROOT } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Highest v<semver> tag strictly below `version`, or null if none. */
export function previousTag(version, tags) {
  const parse = (t) => t.replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const target = parse(`v${version}`);
  return tags
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .filter((t) => cmp(parse(t), target) < 0)
    .sort((a, b) => cmp(parse(a), parse(b)))
    .pop() ?? null;
}

/** Parse a commit subject into { type, scope, description } (or null if not conventional). */
export function parseSubject(subject) {
  const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!m) return null;
  return { type: m[1], scope: m[2] ?? null, description: m[4] };
}

/** Build the markdown body (sections) for a set of commit subjects. */
export function buildSections(subjects) {
  const buckets = new Map(SECTIONS.map(([name]) => [name, []]));
  for (const subject of subjects) {
    const parsed = parseSubject(subject);
    if (!parsed) continue;
    // Skip the bump commit and pure ticket-bookkeeping chores.
    if (/^bump version to /.test(parsed.description)) continue;
    const section = SECTIONS.find(([, types]) => types.has(parsed.type))?.[0];
    if (!section) continue;
    const prefix = parsed.scope ? `**${parsed.scope}:** ` : '';
    buckets.get(section).push(`- ${prefix}${parsed.description}`);
  }
  const parts = [];
  for (const [name] of SECTIONS) {
    const items = buckets.get(name);
    if (items.length) parts.push(`### ${name}\n${items.join('\n')}`);
  }
  return parts.join('\n\n');
}

export function buildEntry({ version, date, subjects }) {
  const body = buildSections(subjects);
  const heading = `## [${version}] - ${date}`;
  return body ? `${heading}\n\n${body}\n` : `${heading}\n\n_No user-facing changes._\n`;
}

/** Insert `entry` directly under the header, above any existing version sections. */
export function insertEntry(existing, entry, version) {
  const base = existing && existing.includes('# Changelog') ? existing : `${HEADER}\n`;
  if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(base)) {
    return base; // already present — never duplicate
  }
  const idx = base.search(/^## \[/m);
  if (idx === -1) {
    return `${base.replace(/\s*$/, '')}\n\n${entry}`;
  }
  return `${base.slice(0, idx)}${entry}\n${base.slice(idx)}`;
}

function main(argv) {
  const version = argv[0];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('usage: changelog.mjs <version> [--date YYYY-MM-DD] [--from <ref>]');
    return 1;
  }
  const dateArg = argv[argv.indexOf('--date') + 1];
  const date = argv.includes('--date') && dateArg ? dateArg : new Date().toISOString().slice(0, 10);
  const fromArg = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : null;

  const tags = git(['tag', '--list']).split('\n').filter(Boolean);
  const from = fromArg ?? previousTag(version, tags);
  const range = from ? `${from}..HEAD` : 'HEAD';
  const subjects = git(['log', '--no-merges', '--pretty=format:%s', range])
    .split('\n')
    .filter(Boolean);

  const entry = buildEntry({ version, date, subjects });
  const existing = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : '';
  const next = insertEntry(existing, entry, version);
  writeFileSync(CHANGELOG, next.replace(/\s*$/, '') + '\n');
  console.log(`CHANGELOG.md: added [${version}] (${subjects.length} commits since ${from ?? 'repo start'}).`);
  console.log('Review and hand-edit the new section before committing.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
