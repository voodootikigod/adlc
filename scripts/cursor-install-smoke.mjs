#!/usr/bin/env node
// cursor-install-smoke.mjs — local verification for the ADLC Cursor integration
// integration. Mirrors scripts/opencode-install-smoke.mjs: validates the package
// shape, the hooks.json wiring (preToolUse dispatcher + afterFileEdit audit +
// beforeShellExecution advisory), the rule registration, the command palette, the
// @adlc/core delegation (no inlined rail engine), the shipped documentation's
// honesty strings (T19), and runs the real enforcement unit tests. Does NOT
// require the Cursor binary and does not mutate the user environment. Exit 0 =
// all checks pass; exit 2 = a check failed.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const PLUGIN = join(ROOT, 'plugins', 'adlc-cursor');
let failures = 0;
const fail = (m) => { console.error(`cursor-install-smoke: FAIL — ${m}`); failures++; };
const ok = (m) => console.log(`  ok — ${m}`);
const read = (p) => readFileSync(p, 'utf8');

// ---- AC1: package + manifest shape ----
const pkgPath = join(PLUGIN, 'package.json');
if (!existsSync(pkgPath)) fail('plugins/adlc-cursor/package.json missing');
else {
  const pkg = JSON.parse(read(pkgPath));
  if (pkg.name !== '@adlc/cursor-package') fail(`package name is ${pkg.name}`); else ok('package name');
  if (pkg.type !== 'module') fail('package is not type:module'); else ok('type:module');
  if (!pkg.dependencies?.['@adlc/core']) fail('missing @adlc/core dependency'); else ok('dependency @adlc/core');
  // T18 AC2 companion: the buildgate/flail deep-subpath imports resolve via the
  // workspace root inside THIS repo even when undeclared, which would mask a
  // broken standalone install — the declarations must be asserted here.
  if (!pkg.dependencies?.['@adlc/build-gate']) fail('missing @adlc/build-gate dependency (deep-subpath imports would break on a standalone install)');
  else ok('dependency @adlc/build-gate declared');
  if (!pkg.dependencies?.['@adlc/flail-detector']) fail('missing @adlc/flail-detector dependency (deep-subpath imports would break on a standalone install)');
  else ok('dependency @adlc/flail-detector declared');
  if (!pkg.cursor?.hooks) fail('package.json cursor.hooks entry missing'); else ok('cursor.hooks manifest entry');
  if (!pkg.cursor?.rules) fail('package.json cursor.rules entry missing'); else ok('cursor.rules manifest entry');
}

// ---- AC1 + T18: hooks.json wiring (preToolUse DISPATCHER + afterFileEdit audit
// ---- + beforeShellExecution advisory; unpinned events absent) ----
const hooksJsonPath = join(PLUGIN, 'hooks.json');
if (!existsSync(hooksJsonPath)) fail('hooks.json missing');
else {
  const hj = JSON.parse(read(hooksJsonPath));
  if (hj.version !== 1) fail('hooks.json version is not 1'); else ok('hooks.json version 1');
  const pre = hj.hooks?.preToolUse ?? [];
  // T18 amendment 1: ONE dispatcher entry, not a rails-guard + buildgate pair —
  // Cursor's multi-entry permission-combination semantics are unpinned, so a
  // second entry could mask a rails deny.
  if (!pre.some((e) => /adlc-pretool\.mjs/.test(e.command ?? ''))) fail('preToolUse does not wire the adlc-pretool.mjs dispatcher');
  else ok('preToolUse wires the single dispatcher (rails first, buildgate second)');
  if (pre.some((e) => /adlc-rails-guard\.mjs/.test(e.command ?? ''))) fail('preToolUse still wires adlc-rails-guard.mjs directly (must be the single dispatcher — multi-entry semantics are unpinned)');
  else ok('preToolUse has no direct rails-guard entry (migrated into the dispatcher)');
  if (pre.filter((e) => /adlc-/.test(e.command ?? '')).length !== 1) fail('preToolUse must carry exactly ONE ADLC entry (the dispatcher)');
  else ok('preToolUse carries exactly one ADLC entry');
  const after = hj.hooks?.afterFileEdit ?? [];
  if (!after.some((e) => /adlc-audit\.mjs/.test(e.command ?? ''))) fail('afterFileEdit does not wire adlc-audit.mjs');
  else ok('afterFileEdit wires the observational audit hook');
  // T18: beforeShellExecution is a PINNED event — the advisory-only shell notice.
  const shell = hj.hooks?.beforeShellExecution ?? [];
  if (!shell.some((e) => /adlc-shell-advisory\.mjs/.test(e.command ?? ''))) fail('beforeShellExecution does not wire adlc-shell-advisory.mjs');
  else ok('beforeShellExecution wires the advisory-only shell notice');
  // T18 AC4: the UNPINNED events ship DISABLED — hooks.json must not reference
  // the stop/preflight scripts, and must contain ONLY verified event names.
  const raw = read(hooksJsonPath);
  if (/adlc-stop\.mjs|adlc-preflight\.mjs/.test(raw)) fail('hooks.json wires a DISABLED-by-default mode (adlc-stop/adlc-preflight) — stop/beforeSubmitPrompt are not pinned events');
  else ok('disabled modes (stop-audit, preflight) are absent from hooks.json');
  const VERIFIED_EVENTS = new Set(['preToolUse', 'afterFileEdit', 'beforeShellExecution', 'beforeReadFile']);
  const unverified = Object.keys(hj.hooks ?? {}).filter((k) => !VERIFIED_EVENTS.has(k));
  if (unverified.length) fail(`hooks.json references unverified event(s): ${unverified.join(', ')} (ADR 0006 pins only ${[...VERIFIED_EVENTS].join('/')})`);
  else ok('hooks.json references only ADR-0006-pinned events');
  // advisory: failClosed must be false so a hook bug cannot brick the editor
  if (pre[0]?.failClosed !== false) fail('preToolUse failClosed is not false (advisory layer must not brick the editor)');
  else ok('preToolUse is advisory (failClosed:false)');
  // F1: the matcher must ROUTE every tool to the guard (catch-all) so a novel
  // mutator name can't bypass the fail-closed classifier. Anything narrower is an
  // allowlist with a hole.
  const matcher = pre.find((e) => /adlc-pretool/.test(e.command ?? ''))?.matcher ?? '';
  const re = new RegExp(matcher, 'i');
  const routed = ['Write', 'str_replace', 'modify_file', 'frobnicate', 'Read'].every((t) => re.test(t));
  if (!routed) fail(`preToolUse matcher is an allowlist, not catch-all (matcher="${matcher}") — novel mutators bypass the guard`);
  else ok('preToolUse matcher is catch-all (every tool reaches the guard; classifier decides)');
}

// ---- AC1: hook scripts present + contract ----
const guardPath = join(PLUGIN, 'hooks', 'adlc-rails-guard.mjs');
const auditPath = join(PLUGIN, 'hooks', 'adlc-audit.mjs');
if (!existsSync(guardPath)) fail('hooks/adlc-rails-guard.mjs missing');
else {
  const g = read(guardPath);
  if (!/permission/.test(g)) fail('rails-guard does not emit a Cursor {permission} verdict'); else ok('rails-guard emits {permission} verdict');
  if (!/export function decide\b/.test(g)) fail('rails-guard does not export decide()'); else ok('rails-guard exports decide()');
}
if (!existsSync(auditPath)) fail('hooks/adlc-audit.mjs missing');
else {
  const a = read(auditPath);
  if (/permission['"]?\s*:\s*['"]deny/.test(a)) fail('afterFileEdit audit must NOT emit a deny (it cannot block)');
  else ok('afterFileEdit audit never denies (observational only)');
  // T18 AC3 companion: the flail heuristic must be IMPORTED from
  // @adlc/flail-detector's lib subpath, never hand-copied.
  if (!a.includes('@adlc/flail-detector/lib/')) fail('audit hook does not import the flail heuristics from @adlc/flail-detector lib subpaths');
  else ok('audit hook imports flail heuristics from @adlc/flail-detector');
  if (/function\s+detectEditChurn\s*\(/.test(a)) fail('audit hook hand-copies detectEditChurn (must delegate to @adlc/flail-detector)');
  else ok('no inlined flail heuristic in the audit hook');
}

// ---- T18: the dispatcher + shell advisory hook scripts ----
const pretoolPath = join(PLUGIN, 'hooks', 'adlc-pretool.mjs');
if (!existsSync(pretoolPath)) fail('hooks/adlc-pretool.mjs missing');
else {
  const d = read(pretoolPath);
  if (!/import \{ decide[^}]*\} from '\.\/adlc-rails-guard\.mjs'/.test(d)) fail('dispatcher does not delegate the rails verdict to the frozen guard decide()');
  else ok('dispatcher delegates the rails verdict to the frozen guard decide()');
  if (!/ADLC_BUILD_GATE_ENFORCEMENT/.test(d)) fail('dispatcher is missing the ADLC_BUILD_GATE_ENFORCEMENT default-off flag');
  else ok('buildgate is default-off behind ADLC_BUILD_GATE_ENFORCEMENT=1');
  if (!/@adlc\/build-gate\/lib\//.test(d)) fail('dispatcher does not import @adlc/build-gate lib subpaths');
  else ok('dispatcher imports @adlc/build-gate deep subpaths');
  if (/function\s+(deriveRiskSignals|computeRiskTier|isDegraded|decideBuildGate)\s*\(/.test(d)) fail('dispatcher hand-copies build-gate risk/decide logic (must delegate to @adlc/build-gate)');
  else ok('no inlined risk/decide copy in the dispatcher');
  if (!/NO unbypassable backstop/.test(d)) fail('dispatcher does not state the buildgate no-backstop fact (honesty requirement)');
  else ok('dispatcher states the buildgate has no unbypassable backstop');
}
const shellAdvisoryPath = join(PLUGIN, 'hooks', 'adlc-shell-advisory.mjs');
if (!existsSync(shellAdvisoryPath)) fail('hooks/adlc-shell-advisory.mjs missing');
else {
  const s = read(shellAdvisoryPath);
  if (/permission['"]?\s*:\s*['"]deny/.test(s)) fail('shell advisory must NEVER emit a deny (advisory by design)');
  else ok('shell advisory never denies');
  if (!/TRIVIALLY BYPASSABLE/i.test(s)) fail('shell advisory does not document that the string match is trivially bypassable');
  else ok('shell advisory documents its trivial bypassability');
}
// The disabled-by-default scripts must still SHIP (opt-in via wireUnpinned).
for (const f of ['adlc-stop.mjs', 'adlc-preflight.mjs']) {
  if (!existsSync(join(PLUGIN, 'hooks', f))) fail(`hooks/${f} missing (disabled-by-default mode must still ship)`);
  else ok(`hooks/${f} ships (disabled by default, opt-in wiring)`);
}

// ---- AC1: rule registration ----
if (!existsSync(join(PLUGIN, 'rules', 'adlc.mdc'))) fail('rules/adlc.mdc missing');
else {
  const r = read(join(PLUGIN, 'rules', 'adlc.mdc'));
  if (!/^---\n[\s\S]*?description:[\s\S]*?\n---/.test(r)) fail('rules/adlc.mdc lacks frontmatter'); else ok('rules/adlc.mdc has frontmatter');
}

// ---- AC2: delegate to @adlc/core, do NOT re-implement the rail engine ----
const checkerPath = join(PLUGIN, 'rails-checker.mjs');
if (!existsSync(checkerPath)) fail('rails-checker.mjs missing');
else {
  const chk = read(checkerPath);
  if (!/from '@adlc\/core'/.test(chk)) fail('rails-checker does not import @adlc/core'); else ok('rails-checker imports @adlc/core');
  if (!/globMatch/.test(chk) || !/loadTickets/.test(chk)) fail('rails-checker does not use globMatch+loadTickets from core'); else ok('delegates globMatch+loadTickets to core');
  if (/function\s+globMatch\s*\(/.test(chk)) fail('rails-checker RE-IMPLEMENTS globMatch (must delegate to @adlc/core)'); else ok('no inlined globMatch (engine delegated)');
  // deny-path source must not pull a third-party runtime dependency
  const imports = [...chk.matchAll(/from '([^']+)'/g), ...read(guardPath).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  const thirdParty = imports.filter((s) => !s.startsWith('node:') && !s.startsWith('.') && s !== '@adlc/core');
  if (thirdParty.length) fail(`deny path imports third-party deps: ${thirdParty.join(', ')}`); else ok('deny path: only node: builtins + @adlc/core');
}

// ---- AC1: scaffolder registers the integration ----
const scaffoldPath = join(PLUGIN, 'lib', 'scaffold.mjs');
if (!existsSync(scaffoldPath)) fail('lib/scaffold.mjs missing');
else {
  const sc = read(scaffoldPath);
  if (!/export function ensurePluginRegistered\b/.test(sc)) fail('scaffold does not register the integration (hooks would not wire)');
  else ok('scaffold registers the integration (.cursor/hooks.json + rule)');
}
if (!existsSync(join(PLUGIN, 'lib', 'scaffold-cli.mjs'))) fail('lib/scaffold-cli.mjs missing'); else ok('scaffold-cli present');
if (!existsSync(join(PLUGIN, 'command', 'adlc-init.md'))) fail('command/adlc-init.md missing'); else ok('command/adlc-init.md present');

// ---- T16 AC1: the scaffolder must DEPLOY command/ into .cursor/commands/ ----
if (existsSync(scaffoldPath)) {
  const sc = read(scaffoldPath);
  if (!/export function deployCommands\b/.test(sc)) fail('scaffold does not export deployCommands() (command palette would be unreachable)');
  else ok('scaffold deploys the command palette (deployCommands)');
}

// ---- T16 AC3: full phase-command suite, mirroring the OpenCode per-command checks ----
const cmdDir = join(PLUGIN, 'command');
const CURSOR_CMDS = [
  'adlc-init.md',
  'adlc-ticket.md',
  'adlc-spec.md',
  'adlc-approve-spec.md',
  'adlc-decompose.md',
  'adlc-verify-build.md',
  'adlc-prosecute.md',
  'adlc-distill.md',
  'adlc-maintain.md',
];
for (const c of CURSOR_CMDS) {
  const p = join(cmdDir, c);
  if (!existsSync(p)) { fail(`command/${c} missing`); continue; }
  const body = read(p);
  if (!/^---\n[\s\S]*?description:\s*\S+[\s\S]*?\n---/.test(body)) fail(`command/${c} lacks description frontmatter`);
  else ok(`command/${c} valid`);
  // Binding design decision 1 (cursor-native-parity spec): Cursor has no plugin
  // namespace — command bodies must use the bare /adlc-<name> form, never the
  // Claude Code /adlc:adlc-<name> form.
  if (/\/adlc:adlc-/.test(body)) fail(`command/${c} uses the namespaced /adlc:adlc-* form (Cursor commands are bare /adlc-*)`);
}
// The generated router rule must reference the bare command palette (T16 AC4 companion).
const rulePath = join(PLUGIN, 'rules', 'adlc.mdc');
if (existsSync(rulePath)) {
  const rule = read(rulePath);
  const missing = CURSOR_CMDS.map((c) => `/${c.replace(/\.md$/, '')}`).filter((name) => !rule.includes(name));
  if (missing.length) fail(`rules/adlc.mdc does not reference: ${missing.join(', ')}`);
  else ok('rules/adlc.mdc references every /adlc-* command');
}

// ---- T17 AC5 + AC7: /adlc-prosecute is the full sequential multi-lens loop ----
const prosecutePath = join(cmdDir, 'adlc-prosecute.md');
if (!existsSync(prosecutePath)) fail('command/adlc-prosecute.md missing (T17)');
else {
  const pr = read(prosecutePath);
  // All five lens briefs + the verifier must live INLINE in the command body
  // (T17 amendment: no separate lens files — the scaffolder would deploy them
  // as fake palette commands).
  for (const lens of ['Correctness', 'Security', 'Contract conformance', 'Spec-vs-implementation diff', 'Test audit']) {
    if (!pr.includes(lens)) fail(`adlc-prosecute.md missing the ${lens} lens brief`);
    else ok(`adlc-prosecute.md has the ${lens} lens`);
  }
  // Lens COUNT derives from @adlc/core's registry, not a hardcoded number: a
  // lens added to or removed from the shared registry must be reflected in
  // the command, and a shrink of the hardcoded title list above cannot
  // silently weaken this assertion (the titles are a readability check; this
  // is the load-bearing one).
  const { LENSES } = await import('@adlc/core');
  const lensBriefCount = (pr.match(/^### Lens \d+ —/gm) ?? []).length;
  if (lensBriefCount !== LENSES.length) {
    fail(`adlc-prosecute.md has ${lensBriefCount} lens briefs; @adlc/core's registry declares ${LENSES.length}`);
  } else ok(`adlc-prosecute.md lens-brief count matches the @adlc/core registry (${LENSES.length})`);
  if (!/verifier/i.test(pr)) fail('adlc-prosecute.md missing the verifier pass');
  else ok('adlc-prosecute.md has the verifier pass');
  // Binding honesty requirement (spec decision 3): sequential same-context
  // lenses must be labeled as weaker than the siblings' fresh-context fan-out,
  // with the cross-model gate recommended.
  if (!/weaker independence/.test(pr)) fail('adlc-prosecute.md missing the weaker-independence honesty caveat');
  else ok('adlc-prosecute.md states the weaker-independence caveat');
  if (!/adversarial-review --providers/.test(pr)) fail('adlc-prosecute.md does not recommend `npx adversarial-review --providers` for the cross-model risk gate');
  else ok('adlc-prosecute.md recommends the cross-model adversarial review');
  // AC7: the command must instruct recording the adversarial-review outcome so
  // the risk-tier stop-audit (decideAdversarialReviewNotice) has a satisfiable
  // record instead of nagging unconditionally.
  // --ticket is load-bearing on both record forms (P5 round-1 finding): a
  // ticketless adversarial-review entry satisfies the risk-tier stop-audit
  // for ANY later ticket touching the same files, so the pinned assertion
  // includes the flag — the bare pre-round-1 form must not silently return.
  if (!/gate-manifest record adversarial-review --ticket/.test(pr)) fail('adlc-prosecute.md missing the `adlc gate-manifest record adversarial-review --ticket` instruction (ticket-scoped form required)');
  else ok('adlc-prosecute.md instructs recording the adversarial-review gate, ticket-scoped');
  if (!/gate-manifest record prosecution --ticket/.test(pr)) fail('adlc-prosecute.md missing the `adlc gate-manifest record prosecution --ticket` instruction (ticket-scoped form required)');
  else ok('adlc-prosecute.md instructs recording the prosecution gate, ticket-scoped');
}

// ---- AC3: run the real enforcement unit tests (always-on proof) ----
try {
  execFileSync(process.execPath, ['--test', ...globTests(join(PLUGIN, 'test'))], { cwd: ROOT, stdio: 'pipe' });
  ok('plugin unit tests pass (rails-guard adapter + audit + scaffold)');
} catch (e) {
  fail(`enforcement unit test failed:\n${e.stdout?.toString() ?? e.message}`);
}

// ---- AC4: two-layer framing in the doc; no competing CI workflow ----
const docPath = join(ROOT, 'docs', 'integrations', 'cursor.md');
if (!existsSync(docPath)) fail('docs/integrations/cursor.md missing');
else {
  const doc = read(docPath);
  if (!/ci\/rails-guard\.yml/.test(doc)) fail('cursor.md does not point at the mandatory CI gate (docs/ci/rails-guard.yml)'); else ok('links the unbypassable CI gate');
  if (!/advisor/i.test(doc)) fail('cursor.md does not frame the in-session hook as advisory'); else ok('frames in-session hook as advisory');
  if (!/Formal ADLC Coverage/.test(doc)) fail('cursor.md missing the Formal ADLC Coverage table'); else ok('has Formal ADLC Coverage table');
}

// ---- AC5: ADR exists and pins the Cursor hook facts ----
const adrPath = join(ROOT, 'docs', 'adr', '0006-adlc-cursor-integration.md');
if (!existsSync(adrPath)) fail('docs/adr/0006-adlc-cursor-integration.md missing');
else {
  const adr = read(adrPath);
  for (const needle of ['preToolUse', 'afterFileEdit', '## Threat Model']) {
    if (!adr.includes(needle)) fail(`ADR 0006 does not pin "${needle}"`); else ok(`ADR pins ${needle}`);
  }
}

// ---- T19: the docs must tell the exact truth about T16-T18 — the honesty
// ---- strings are ENFORCED here (mirrors how opencode-install-smoke asserts doc
// ---- language). Strip any one of these from docs/integrations/cursor.md and
// ---- this smoke fails (RED-probed).
if (existsSync(docPath)) {
  const doc = read(docPath);
  // buildgate honesty string (spec decision 7): advisory, default-off behind the
  // enforcement flag, and NO unbypassable backstop (unlike the rails guard).
  if (!/buildgate is advisory/i.test(doc)) fail('cursor.md does not state the buildgate is advisory');
  else ok('cursor.md states the buildgate is advisory');
  if (!/ADLC_BUILD_GATE_ENFORCEMENT=1/.test(doc)) fail('cursor.md does not state the buildgate default-off flag (ADLC_BUILD_GATE_ENFORCEMENT=1)');
  else ok('cursor.md states the buildgate default-off flag');
  if (!/no unbypassable backstop/i.test(doc)) fail('cursor.md does not state the buildgate has NO unbypassable backstop (honesty requirement)');
  else ok('cursor.md states the buildgate has no unbypassable backstop');
  // HARDENING (review loop): the honesty checks above pin that the required
  // phrases EXIST, but a future edit could keep them AND add a contradictory
  // overclaim. "unbypassable" is truthful ONLY for the commit-time CI
  // rail-freeze gate — it must NEVER be applied to the in-session
  // hook/buildgate/advisory, which are advisory/best-effort. A NEGATIVE guard.
  //
  // Design (v2, cross-model review): DON'T allowlist CI-context phrases — that
  // was both leaky (a generic "required check" nearby excused an overclaim) and
  // brittle (exact hyphenation + a fixed char window false-failed honest text).
  // Instead isolate the CLAUSE containing each occurrence and fail only a
  // POSITIVE assertion about an IN-SESSION subject. Honest CI-gate uses ("the
  // commit-time CI gate is unbypassable") and negated uses ("no unbypassable
  // backstop", "not unbypassable") pass regardless of phrasing.
  {
    const DELIMS = '.;\n—';
    let overclaim = 0;
    for (const m of doc.matchAll(/unbypassable/gi)) {
      let s = 0, e = doc.length;
      for (let i = m.index - 1; i >= 0; i--) { if (DELIMS.includes(doc[i])) { s = i + 1; break; } }
      for (let i = m.index + 'unbypassable'.length; i < doc.length; i++) { if (DELIMS.includes(doc[i])) { e = i; break; } }
      const clause = doc.slice(s, e).replace(/\s+/g, ' ').trim();
      const before = clause.slice(0, clause.toLowerCase().indexOf('unbypassable'));
      const negated = /\b(no|not|never)\b/i.test(before) || /unbypassable\s+backstop/i.test(clause);
      const inSession = /\b(in-session|buildgate|hook|advisory|pretooluse|shell)\b/i.test(clause);
      if (!negated && inSession) { overclaim++; fail(`cursor.md calls the in-session layer "unbypassable" — it is advisory/best-effort; only the commit-time CI rail-freeze gate is unbypassable: "…${clause}…"`); }
    }
    if (!overclaim) ok('cursor.md never positively calls the in-session layer "unbypassable" (clause-scoped negative guard)');
  }
  // Sequential-lens independence caveat (spec decision 3).
  if (!/weaker independence/i.test(doc)) fail('cursor.md does not state the sequential-lens weaker-independence caveat');
  else ok('cursor.md states the sequential-lens weaker-independence caveat');
  if (!/adversarial-review --providers/.test(doc)) fail('cursor.md does not recommend `npx adversarial-review --providers` for the cross-model gate');
  else ok('cursor.md recommends the cross-model adversarial review');
  // Shell writes are advisory-only (spec decision 8): beforeShellExecution never
  // denies and the match is trivially bypassable.
  if (!/Shell writes are advisory-only/i.test(doc)) fail('cursor.md does not state that shell writes are advisory-only');
  else ok('cursor.md states shell writes are advisory-only');
  if (!/never denies/i.test(doc)) fail('cursor.md does not state the shell advisory never denies');
  else ok('cursor.md states the shell advisory never denies');
  // The command palette is deployed by the scaffolder (T16) — no more "run
  // /adlc-init and the suite is follow-on" lie.
  if (!/\.cursor\/commands\//.test(doc)) fail('cursor.md does not describe the .cursor/commands/ palette deployment');
  else ok('cursor.md describes the command palette deployment');
  if (/prosecutor subagents/i.test(doc)) fail('cursor.md still calls the P5 prosecution a follow-on "prosecutor subagents" gap (shipped in T17)');
  else ok('cursor.md no longer lists the prosecutor as a follow-on gap');
}

if (failures) { console.error(`\ncursor-install-smoke: ${failures} failure(s)`); process.exit(2); }
console.log('\ncursor-install-smoke: PASS');

function globTests(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(dir, f)) : [];
}
