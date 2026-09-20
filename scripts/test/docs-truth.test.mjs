import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ---- ground truth -----------------------------------------------------------
function hooksJsonMentions(rel, needle) {
  const cfg = JSON.parse(read(rel));
  return Object.values(cfg.hooks ?? {}).flat().flatMap((e) => e.hooks ?? [])
    .some((h) => String(h.command ?? '').includes(needle));
}
const WIRED = {
  'claude-code': /adlc-hook-run\.mjs\s+handoff\b/.test(read('plugins/adlc-claude-code/hooks/hooks.json')),
  codex: hooksJsonMentions('plugins/adlc-codex/hooks/hooks.json', 'adlc-handoff-gate'),
};
const OPT_IN_FLAG = "env.ADLC_CONTEXT_ROT_HANDOFF_ENABLED === '1'";
const OPT_IN = {
  pi: read('plugins/adlc-pi/lib/extension.mjs').includes(OPT_IN_FLAG),
  opencode: read('plugins/adlc-opencode/index.mjs').includes(OPT_IN_FLAG),
};
const STATUS = /1\.11\.1/;
const ISSUE = /#966|issues\/966/;
const FLAG = /ADLC_CONTEXT_ROT_HANDOFF_ENABLED/;

/** Text from a heading line up to the next heading of the same or higher level. */
function section(text, headingRe) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  assert.ok(start >= 0, `heading ${headingRe} not found`);
  const level = /^#+/.exec(lines[start])[0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => new RegExp(`^#{1,${level}} `).test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}
/** First blank-line-delimited block of a section. */
const firstBlock = (s) => s.trim().split(/\n\s*\n/)[0];

test('handoff sections lead with the shipped status', () => {
  const cases = [
    ['apps/docs/content/docs/integrations/codex.mdx', /^## Context-rot handoff/, !WIRED.codex, false],
    ['plugins/adlc-codex/README.md', /^## Context-rot handoff gate/, !WIRED.codex, false],
    ['apps/docs/content/docs/integrations/opencode.mdx', /^## Context-rot handoff/, OPT_IN.opencode, true],
    ['apps/docs/content/docs/integrations/pi.mdx', /^## Context-rot handoff/, OPT_IN.pi, true],
    ['plugins/adlc-pi/README.md', /^## The handoff gate/, OPT_IN.pi, true],
    ['docs/integrations/pi.md', /^### 3\.5 /, OPT_IN.pi, true],
  ];
  const failures = [];
  for (const [file, heading, applies, needsFlag] of cases) {
    const lead = firstBlock(section(read(file), heading));
    if (applies) {
      if (!STATUS.test(lead) || !ISSUE.test(lead)) failures.push(`${file}: lead block lacks 1.11.1 + #966`);
      if (needsFlag && !FLAG.test(lead)) failures.push(`${file}: lead block does not name the opt-in flag`);
    } else {
      if (STATUS.test(lead) || ISSUE.test(lead)) failures.push(`${file}: lead block contains 1.11.1 / #966 but harness is wired`);
      if (FLAG.test(lead)) failures.push(`${file}: lead block contains opt-in flag but harness is wired`);
    }
  }
  assert.deepEqual(failures, []);
});

test('package-level pages state the status before their first section', () => {
  const failures = [];
  for (const file of ['apps/docs/content/docs/toolkit/context-handoff.mdx', 'packages/context-handoff/README.md']) {
    const intro = read(file).split(/^## /m)[0];
    if (!STATUS.test(intro) || !ISSUE.test(intro) || !FLAG.test(intro)) failures.push(file);
  }
  assert.deepEqual(failures, []);
});

test('every list item or table row that names the handoff gate carries a status marker', () => {
  const MARK = /1\.11\.1|#966|off by default|not wired|opt-in/i;
  const rows = [
    ['apps/docs/content/docs/toolkit/index.mdx', /^\| \[context-handoff\]/],
    ['docs/package-reference.md', /^\| `@adlc\/context-handoff`/],
    ['docs/integrations/pi.md', /^\| Context-rot handoff deny/],
    ['plugins/adlc-pi/README.md', /^- \*\*Context-rot handoff gate\*\*/],
  ];
  const failures = [];
  for (const [file, re] of rows) {
    const lines = read(file).split('\n');
    const i = lines.findIndex((l) => re.test(l));
    assert.ok(i >= 0, `${file}: row ${re} not found`);
    // a list item may wrap: take continuation lines (indented) too
    let item = lines[i];
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]); j++) item += `\n${lines[j]}`;
    if (!MARK.test(item)) failures.push(`${file}:${i + 1}`);
  }
  // claude-code.mdx: a line naming the handoff deny must carry the marker (or not name it at all)
  read('apps/docs/content/docs/integrations/claude-code.mdx').split('\n').forEach((l, i) => {
    if (/handoff/i.test(l) && !MARK.test(l)) failures.push(`claude-code.mdx:${i + 1}`);
  });
  assert.deepEqual(failures, []);
});

test('AGENTS.md describes the store this repo actually has', () => {
  const agents = read('AGENTS.md');
  const failures = [];
  if (!existsSync(join(ROOT, '.adlc/tickets.json')) && existsSync(join(ROOT, '.adlc/tickets/.store.json'))) {
    if (/\.adlc\/tickets\.json/.test(agents)) failures.push('names .adlc/tickets.json, which this repo does not have');
  }
  if (/(^|[\s`])\/(Users|home)\/[A-Za-z]/m.test(agents)) failures.push('hardcodes an absolute home path');
  if (/worktree shares[^.]*\bindex\b/i.test(agents)) failures.push('says a worktree shares an index');
  if (/this repo carries \*\*long-lived stashes/i.test(agents)) failures.push('asserts a checkout-state fact about stashes');
  assert.deepEqual(failures, []);
});

test('the three copies of the core rule agree with CONVENTIONS.md', () => {
  const rule2 = (text) => /^2\. [\s\S]*?(?=^3\. )/m.exec(text)?.[0] ?? '';
  const canon = rule2(read('CONVENTIONS.md'));
  assert.match(canon, /fixed in core/i, 'canon changed — re-read CONVENTIONS.md rule 2');
  const failures = [];
  for (const file of ['CONTRIBUTING.md', 'apps/docs/content/docs/reference/conventions.mdx']) {
    const copy = rule2(read(file));
    if (!/fixed in core/i.test(copy)) failures.push(`${file}: omits the defect-fix half`);
    if (/Never edit/i.test(copy)) failures.push(`${file}: says never edit core`);
  }
  assert.deepEqual(failures, []);
});

test('README project layout names only paths that exist and does not misstate .adlc tracking', () => {
  const table = section(read('README.md'), /^## Project layout/);
  const failures = [];
  for (const m of table.matchAll(/^\| `([^`]+)` \|(.*)$/gm)) {
    if (!existsSync(join(ROOT, m[1]))) failures.push(`missing path ${m[1]}`);
    if (m[1] === '.adlc/' && /!\.adlc\/tickets\//.test(read('.gitignore')) && /gitignored except/i.test(m[2])) {
      failures.push('.adlc row says gitignored except example, but .gitignore un-ignores the ticket store');
    }
  }
  assert.deepEqual(failures, []);
});

test('ADLC.md Appendix C does not call shipped tools missing', () => {
  const adlc = read('ADLC.md');
  const names = [...adlc.matchAll(/^### C\d+\. `([a-z-]+)`/gm)].map((m) => m[1]);
  assert.equal(names.length, 14);
  const allShip = names.every((n) => existsSync(join(ROOT, 'packages', n, 'package.json')));
  if (!allShip) return;
  const appendix = section(adlc, /^## Appendix C/);
  assert.doesNotMatch(firstBlock(appendix), /mostly don't/);
  assert.match(section(adlc, /^### Build priority/).concat(/^### Build priority.*$/m.exec(adlc)[0]), /historical|as built|shipped/i);
});

test('status headers of shipped designs do not say proposed or pending', () => {
  const docs = [
    ['docs/specs/fleet-orchestration.md', 'packages/fleet'],
    ['docs/specs/sharded-ticket-store.md', 'packages/tickets'],
    ['docs/superpowers/plans/2026-07-13-sharded-ticket-store.md', 'packages/tickets'],
    ['docs/herdr-integration-plan.md', 'plugins/adlc-herdr'],
    ['docs/specs/pi-native-flush.md', 'plugins/adlc-pi'],
    ['docs/specs/opencode-integration-continuation.md', 'plugins/adlc-opencode'],
    ['docs/intent/backlog-grooming.md', 'packages/backlog-groom'],
  ];
  const failures = [];
  for (const [file, impl] of docs) {
    if (!existsSync(join(ROOT, impl))) continue;
    const status = read(file).split('\n').slice(0, 12).find((l) => /Status:?\**/i.test(l)) ?? '';
    if (/PROPOSED|pending|not yet/i.test(status)) failures.push(`${file}: ${status.trim()}`);
  }
  assert.deepEqual(failures, []);
});

test('living docs state no package count', () => {
  const COUNT = /~?\b\d{2}\s+(?:independently built|zero-dependency|tools|packages|CLIs)\b/;
  const failures = [];
  for (const file of ['README.md', 'CONVENTIONS.md', 'CONTRIBUTING.md', 'AGENTS.md',
    'apps/docs/content/docs/reference/conventions.mdx', 'apps/docs/content/docs/reference/index.mdx',
    'docs/integrations/claude-code.md', 'apps/docs/content/docs/toolkit/cli.mdx',
    '.claude/skills/release-audit/SKILL.md']) {
    read(file).split('\n').forEach((l, i) => { if (COUNT.test(l)) failures.push(`${file}:${i + 1}`); });
  }
  assert.deepEqual(failures, []);
});

test('the three repaired relative links resolve', () => {
  const links = [
    ['docs/adr/0016-issue-autopilot-local-substrate.md', 'docs/adr'],
    ['docs/integrations/copilot-probe-appendix.md', 'docs/integrations'],
    ['docs/integrations/opencode.md', 'docs/integrations'],
  ];
  const failures = [];
  for (const [file, dir] of links) {
    for (const m of read(file).matchAll(/\]\((\.{1,2}\/[^)#\s]+)(#[^)]*)?\)/g)) {
      if (!existsSync(join(ROOT, dir, m[1]))) failures.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(failures, []);
});
