// The triage gate chain (spec §5.3; AC 4, 26): ticket schema (dry-run
// `adlc ticket create`), scope rules (non-empty, no root wildcard, no
// protected-path intersection, every glob resolves at BASE_OID with the ONE
// bounded bootstrap exception) and spec-lint as a LINT ONLY. Each gate fails
// closed and its findings are collected verbatim; no gate short-circuits the
// others, so a CLARIFY comment names everything at once.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { globMatch } from '@adlc/core';
import { DEADLINES } from './spawn.mjs';
import { childEnv } from './keys.mjs';
import { validateIssueNumber } from './input.mjs';
import { active, registerSeams } from './mutations.mjs';

registerSeams([
  'triage.acceptRootWildcard', // a `**` at the root of a scope glob passes
  'triage.skipDenylist',       // the protected-path intersection is not checked
]);

/** The registry files the bijective/dispatcher guards require for a NEW top-level package (§14). */
export const REGISTRY_FILES = Object.freeze(['packages/cli/lib/registry.mjs', 'apps/docs/lib/toolkit-packages.mjs']);
export const NEW_PACKAGE_RE = /^(packages|plugins)\/([a-z][a-z0-9-]{1,40})\/\*\*$/;
export const FINDING_CAP = 8000;

/** spec-lint's criteria-heading regex (packages/spec-lint/lib/parse.mjs). */
export const CRITERIA_HEADING_RE = /acceptance|criteria|requirements|definition of done|success/i;
const HEADING_RE = /^#{1,6}\s+/;
const BOLD_HEADING_RE = /^\*\*((?:(?!\*\*).)+)\*\*:?\s*$/;
const LIST_ITEM_RE = /^[ \t]*(?:[-*]|\d+\.)(?:\s+\[[ xX]\])?\s+(.+)/;

/** The literal path prefix of a glob (everything before the first `*`, cut at the last `/`). */
export function literalPrefix(glob) {
  const star = glob.indexOf('*');
  if (star < 0) return glob.replace(/\/+$/, '');
  const head = glob.slice(0, star);
  return head.slice(0, head.lastIndexOf('/') + 1).replace(/\/+$/, '');
}

/** A wildcard in the first path segment (a bare `**`, a `**`-prefixed segment, or a bare `*`) — the scope would be the whole tree. */
export function rootWildcard(glob) {
  const first = glob.split('/')[0];
  return first.includes('**') || first === '*';
}

/** Conservative intersection of two globs: either matches the other's literal prefix, or the prefixes nest. */
export function globsIntersect(a, b) {
  const la = literalPrefix(a); const lb = literalPrefix(b);
  if (la === '' || lb === '') return true;
  if (globMatch(a, lb) || globMatch(b, la)) return true;
  return la === lb || la.startsWith(`${lb}/`) || lb.startsWith(`${la}/`);
}

/**
 * Scope rules of §5.3. `treePaths` = `git ls-tree -r --name-only <BASE_OID>` lines;
 * `denylist` = { globs, matches(path) } (lib/denylist.mjs).
 */
export function checkScope({ scope, category, denylist, treePaths }) {
  const findings = [];
  if (!Array.isArray(scope) || scope.length === 0 || !scope.every((s) => typeof s === 'string' && s.trim().length > 0)) {
    return [{ gate: 'scope', detail: 'scope must be a non-empty array of path globs' }];
  }
  const tree = Array.isArray(treePaths) ? treePaths : [];
  const globs = denylist?.globs ?? [];
  const newDirs = [];
  for (const glob of scope) {
    if (rootWildcard(glob)) {
      // Mutation seam `triage.acceptRootWildcard`.
      if (!active('triage.acceptRootWildcard')) findings.push({ gate: 'scope', detail: `root wildcard is not allowed: ${glob}` });
      continue;
    }
    const hit = globs.find((d) => globsIntersect(glob, d)) ?? (denylist?.matches?.(literalPrefix(glob)) ? literalPrefix(glob) : null);
    // Mutation seam `triage.skipDenylist`.
    if (hit && !active('triage.skipDenylist')) findings.push({ gate: 'protected-path', detail: `${glob} intersects the protected-path denylist (${hit})` });
    let resolves = tree.some((p) => globMatch(glob, p));
    if (!resolves) {
      const m = /^(packages|plugins)\/([^/]+)(?:\/|$)/.exec(literalPrefix(glob));
      if (m && tree.some((p) => p.startsWith(`${m[1]}/${m[2]}/`))) resolves = true;
    }
    if (resolves) continue;
    const nm = NEW_PACKAGE_RE.exec(glob);
    if (nm && category === 'feature' && !tree.some((p) => p.startsWith(`${nm[1]}/${nm[2]}/`))) { newDirs.push(glob); continue; }
    findings.push({ gate: 'scope', detail: `${glob} resolves to no path at BASE_OID and is not under an existing packages/<x>/ or plugins/<x>/` });
  }
  if (newDirs.length > 1) findings.push({ gate: 'scope', detail: `at most one NEW top-level package/plugin directory is allowed, got ${newDirs.length}: ${newDirs.join(', ')}` });
  else if (newDirs.length === 1) {
    const missing = REGISTRY_FILES.filter((f) => !scope.some((s) => s === f || globMatch(s, f)));
    if (missing.length) findings.push({ gate: 'scope', detail: `new ${newDirs[0]} requires the registry files in scope: ${missing.join(', ')}` });
  }
  return findings;
}

/** The first criteria section of a markdown body: heading matching spec-lint's regex + ≥1 list item. */
export function extractCriteriaSection(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_RE.test(lines[i]) ? lines[i].replace(HEADING_RE, '').trim() : (BOLD_HEADING_RE.exec(lines[i])?.[1] ?? null);
    if (h === null || !CRITERIA_HEADING_RE.test(h)) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && !HEADING_RE.test(lines[j]) && !BOLD_HEADING_RE.test(lines[j]); j++) body.push(lines[j]);
    if (body.some((l) => LIST_ITEM_RE.test(l))) return { found: true, heading: lines[i].trim(), text: body.join('\n').trim() };
  }
  return { found: false, heading: null, text: null };
}

const detailOf = (res) => (res.timedOut ? `timeout: ${res.reason}` : `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim().slice(0, FINDING_CAP));

/** Ticket schema: pinned `adlc ticket create --input - --json` DRY RUN (no --write → not key-bearing). */
export async function schemaGate({ ctx, ticket }) {
  const res = await ctx.spawn({
    argv: [ctx.pinned.adlc, 'ticket', 'create', '--input', '-', '--json'],
    cwd: ctx.repoRoot, env: childEnv(ctx.env.base), stdinBytes: JSON.stringify(ticket),
    deadlineMs: DEADLINES.adlcRecorder, label: 'adlc ticket create (dry run)',
  });
  if (res.status === 0 && !res.error && !res.timedOut) return [];
  return [{ gate: 'ticket-schema', detail: detailOf(res) || `adlc ticket create exited ${res.status}` }];
}

/** spec-lint LINT ONLY over the criteria written to paths.triageCriteria(n) — never --record. */
export async function specLintGate({ ctx, issue, criteriaText }) {
  const n = validateIssueNumber(issue);
  if (typeof criteriaText !== 'string' || criteriaText.trim().length === 0) return [{ gate: 'spec-lint', detail: 'no acceptance-criteria section found in the ticket body' }];
  const file = ctx.paths.triageCriteria(n);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `## Acceptance criteria\n\n${criteriaText.trim()}\n`);
  const res = await ctx.spawn({
    argv: [ctx.pinned.adlc, 'spec-lint', file, '--json'],
    cwd: ctx.repoRoot, env: childEnv(ctx.env.base), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc spec-lint (lint only)',
  });
  if (res.status === 0 && !res.error && !res.timedOut) return [];
  return [{ gate: 'spec-lint', detail: detailOf(res) || `adlc spec-lint exited ${res.status}` }];
}
