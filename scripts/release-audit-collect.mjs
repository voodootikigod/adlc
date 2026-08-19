#!/usr/bin/env node
// release-audit-collect — Phase A of /release-audit: gather everything the audit
// needs BEFORE any model runs, and emit it as one JSON document.
//
// WHY THIS IS A SEPARATE PHASE. The audit fans out through the Workflow tool, and
// a workflow script has no filesystem and no child_process — it can only read the
// `args` value handed to it. So every mechanical fact the agents need (which units
// exist, what changed since the last tag, which GitHub issue belongs to which
// package, whether the tree is even in a releasable state) has to be collected
// here, in real Node, and passed in. Nothing in this file asks a model anything.
//
// WHY THE MECHANICAL CHECKS ARE IMPORTED, NOT REIMPLEMENTED. release.mjs already
// owns version-drift, publish-metadata, host-manifest discovery and near-miss
// detection, and its own comments record what it cost to learn them: the Claude
// Code plugin stranded at 0.2.0 across three releases because a gate enumerated a
// DIFFERENT set of manifests than the bumper. Re-stating those rules here would
// recreate exactly that divergence, so this file imports them and reports what
// they say.
//
// FAIL-CLOSED DISCIPLINE. Borrowed verbatim from release.mjs's packaging gate: a
// probe that could not run is recorded as `unconsultable`, never as clean.
// "Could not check" must never render as "verified".
//
// Usage:
//   node scripts/release-audit-collect.mjs [version] [--since <tag>]
//                                          [--packages a,b,c] [--skip-issues]

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Source extensions a unit agent is asked to read. */
export const SOURCE_EXT = new Set(['.mjs', '.cjs', '.js', '.ts', '.json', '.md']);

/** Directories never worth walking into when inventorying a unit. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', '.worktrees']);

/** Labels that force an issue onto the sweep agent no matter where it routed. */
export const ESCALATE_LABELS = new Set(['P0-critical', 'P1-high', 'security']);

/**
 * Issues per sweep agent.
 *
 * Measured against the real backlog: 46 unrouted plus 25 escalated is ~63 unique
 * issues, and one agent asked to read the code behind 63 issues will skim or go
 * hollow — the precise failure the coverage rules exist to catch. Sharding keeps
 * each agent's job small enough to actually do.
 */
export const SWEEP_BATCH_SIZE = 12;

// ─── argument parsing ────────────────────────────────────────────────────────

/**
 * Parse the skill's four flags. Deliberately tiny: every additional mode is a way
 * to produce a weaker verdict that still looks like a verdict.
 *
 * @param {string[]} argv
 * @returns {{version: string|null, since: string|null, packages: string[]|null, skipIssues: boolean}}
 */
export function parseArgs(argv) {
  const out = { version: null, since: null, packages: null, skipIssues: false, workflowArgs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--since') { out.since = argv[i + 1] ?? null; i += 1; continue; }
    if (a === '--packages') {
      const raw = argv[i + 1] ?? '';
      i += 1;
      const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
      out.packages = names.length ? names : null;
      continue;
    }
    if (a === '--skip-issues') { out.skipIssues = true; continue; }
    if (a === '--workflow-args') { out.workflowArgs = true; continue; }
    if (a.startsWith('-')) continue;
    if (out.version === null) out.version = a;
  }
  return out;
}

/**
 * The version this release would cut, when the caller did not name one.
 * Minor bump, because the suite has never shipped a patch-only release and
 * guessing "patch" would make the version-drift probe compare against a target
 * nobody intends.
 *
 * @param {string} current e.g. "1.10.0"
 * @returns {string} e.g. "1.11.0"
 */
export function nextMinor(current) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(current ?? ''));
  if (!m) return String(current ?? '');
  return `${m[1]}.${Number(m[2]) + 1}.0`;
}

// ─── unit discovery ──────────────────────────────────────────────────────────

/**
 * Every file under `dir` worth showing an agent, repo-relative, sorted.
 * Bounded by extension and by SKIP_DIRS so a stray build artifact cannot make a
 * unit look enormous.
 */
export function inventory(dir, { root = ROOT, readDir = readdirSync, stat = statSync } = {}) {
  const found = [];
  const walk = (abs) => {
    let entries;
    try { entries = readDir(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) { walk(child); continue; }
      const dot = entry.name.lastIndexOf('.');
      if (dot === -1 || !SOURCE_EXT.has(entry.name.slice(dot))) continue;
      let size = 0;
      try { size = stat(child).size; } catch { size = 0; }
      found.push({ path: relative(root, child).split(sep).join('/'), bytes: size });
    }
  };
  walk(join(root, dir));
  return found;
}

/**
 * Every shipped artifact that gets its own audit agent: the workspace packages,
 * the published host plugins, and adlc-claude-code — which ships through a
 * marketplace manifest rather than npm and therefore has no package.json. That
 * last one is included DELIBERATELY: it is the artifact release.mjs records as
 * having stranded at 0.2.0 across three releases, so an inventory that discovered
 * units only by package.json would omit precisely the unit with the worst record.
 */
export function discoverUnits({ root = ROOT, exists = existsSync, readDir = readdirSync, readFile = readFileSync } = {}) {
  const units = [];
  const readJson = (p) => { try { return JSON.parse(readFile(p, 'utf8')); } catch { return null; } };

  for (const kind of ['packages', 'plugins']) {
    const base = join(root, kind);
    let entries;
    try { entries = readDir(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const dir = `${kind}/${entry.name}`;
      const pkgPath = join(base, entry.name, 'package.json');
      const pkg = exists(pkgPath) ? readJson(pkgPath) : null;

      // A plugin without a package.json still ships — via .<host>-plugin/plugin.json.
      let manifest = null;
      if (!pkg && kind === 'plugins') {
        let inner;
        try { inner = readDir(join(base, entry.name)); } catch { inner = []; }
        for (const child of inner.slice().sort()) {
          const candidate = join(base, entry.name, child, 'plugin.json');
          if (/^\.[a-z0-9-]+-plugin$/.test(child) && exists(candidate)) {
            manifest = `${dir}/${child}/plugin.json`;
            break;
          }
        }
        if (!manifest) continue;
      }
      if (!pkg && !manifest) continue;

      const files = inventory(dir, { root, readDir, stat: statSync });
      units.push({
        id: `${kind === 'packages' ? 'pkg' : 'plugin'}:${entry.name}`,
        kind: kind === 'packages' ? 'package' : 'plugin',
        dir,
        slug: entry.name,
        name: pkg?.name ?? `(${manifest})`,
        version: pkg?.version ?? (manifest ? readJson(join(root, manifest))?.version ?? null : null),
        private: pkg ? pkg.private === true : true,
        published: pkg ? pkg.private !== true : Boolean(manifest),
        manifest,
        bin: pkg?.bin ?? null,
        filesField: pkg?.files ?? null,
        dependencies: pkg?.dependencies ?? {},
        engines: pkg?.engines ?? null,
        hasTests: ['test', 'cli-test', 'adapter-test'].some((d) => exists(join(base, entry.name, d))),
        fileCount: files.length,
        bytes: files.reduce((n, f) => n + f.bytes, 0),
        files: files.map((f) => f.path),
      });
    }
  }
  return units;
}

// ─── issue routing ───────────────────────────────────────────────────────────

/**
 * The unit a repo-relative path belongs to, or null.
 * Longest matching dir wins so a nested path cannot be claimed by a shorter
 * sibling prefix.
 */
export function unitForPath(path, units) {
  const p = String(path ?? '').split('\\').join('/').replace(/^\.\//, '');
  let best = null;
  for (const u of units) {
    if (p === u.dir || p.startsWith(`${u.dir}/`)) {
      if (!best || u.dir.length > best.dir.length) best = u;
    }
  }
  return best ? best.id : null;
}

/** The literal directory prefix of a glob — everything before the first wildcard. */
export function globPrefix(glob) {
  const g = String(glob ?? '').split('\\').join('/');
  const star = g.search(/[*?[]/);
  if (star === -1) return g;
  const literal = g.slice(0, star);
  const cut = literal.lastIndexOf('/');
  return cut === -1 ? '' : literal.slice(0, cut);
}

/** GitHub issue numbers a ticket body backlinks to. */
export function linkedIssueNumbers(body) {
  const out = new Set();
  const re = /github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/g;
  let m;
  while ((m = re.exec(String(body ?? ''))) !== null) out.add(Number(m[1]));
  return [...out];
}

/** True when an issue must reach the sweep agent regardless of where it routed. */
export function isEscalated(issue) {
  return (issue.labels ?? []).some((l) => ESCALATE_LABELS.has(typeof l === 'string' ? l : l?.name));
}

/**
 * Route one issue to a unit, by descending evidence strength:
 *   1. an explicit `packages/x` or `plugins/x` path in the title or body
 *   2. a linked ADLC ticket whose `scope` globs land in exactly one unit
 *   3. an `@adlc/<name>` package name in the title
 *   4. an `area:<x>` label where `<x>` is EXACTLY a unit directory name
 *
 * Every tier refuses to guess when the evidence points at more than one unit.
 * That asymmetry is deliberate and matches mutation-gate's rule for the same
 * problem: under-claiming is safe, over-claiming is the bug. An unrouted issue is
 * not lost — it goes to the sweep agent, which exists for exactly this residue.
 *
 * @returns {{unit: string|null, via: string}}
 */
export function routeIssue(issue, units, ticketsByIssue = new Map()) {
  const text = `${issue.title ?? ''}\n${issue.body ?? ''}`;

  const pathHits = new Set();
  const pathRe = /\b(packages|plugins)\/([A-Za-z0-9._-]+)/g;
  let m;
  while ((m = pathRe.exec(text)) !== null) {
    const id = unitForPath(`${m[1]}/${m[2]}`, units);
    if (id) pathHits.add(id);
  }
  if (pathHits.size === 1) return { unit: [...pathHits][0], via: 'path-mention' };

  const scopeHits = new Set();
  for (const ticket of ticketsByIssue.get(issue.number) ?? []) {
    for (const glob of ticket.scope ?? []) {
      const id = unitForPath(globPrefix(glob), units);
      if (id) scopeHits.add(id);
    }
  }
  if (scopeHits.size === 1) return { unit: [...scopeHits][0], via: 'ticket-scope' };

  const nameHits = new Set();
  for (const u of units) {
    if (u.name && !u.name.startsWith('(') && (issue.title ?? '').includes(u.name)) nameHits.add(u.id);
  }
  if (nameHits.size === 1) return { unit: [...nameHits][0], via: 'package-name' };

  const areaHits = new Set();
  for (const label of issue.labels ?? []) {
    const nm = typeof label === 'string' ? label : label?.name;
    if (!nm || !nm.startsWith('area:')) continue;
    const slug = nm.slice('area:'.length);
    for (const u of units) if (u.slug === slug) areaHits.add(u.id);
  }
  if (areaHits.size === 1) return { unit: [...areaHits][0], via: 'area-label' };

  if (pathHits.size > 1) return { unit: null, via: 'ambiguous-path' };
  if (scopeHits.size > 1) return { unit: null, via: 'ambiguous-ticket-scope' };
  return { unit: null, via: 'unrouted' };
}

/**
 * The sweep agents' workload: every unrouted issue, plus every escalated one
 * (which a package agent may also have seen), de-duplicated by number and split
 * into fixed-size batches. Always at least one batch, so the coverage contract
 * has something to expect even on an empty backlog.
 *
 * @returns {Array<Array<object>>}
 */
export function sweepBatches(unmapped, escalated, size = SWEEP_BATCH_SIZE) {
  const byNumber = new Map();
  for (const i of [...unmapped, ...escalated]) if (!byNumber.has(i.number)) byNumber.set(i.number, i);
  const all = [...byNumber.values()].sort((a, b) => a.number - b.number);
  if (all.length === 0) return [[]];
  const out = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}

/** How much of an issue body survives into the emitted document. */
export const ISSUE_EXCERPT = 200;

/**
 * Drop issue bodies from an issue record, keeping a short excerpt.
 *
 * Bodies are read for ROUTING and then never referenced again — no agent prompt
 * uses them. Emitting them anyway made them 75% of the collected document (392 KB
 * of 526 KB), and that document is passed verbatim as the workflow's `args`, so
 * every byte is paid for on the way in. The agent gets the issue URL and can read
 * the full text itself if the excerpt is not enough.
 */
export function stripBody(issue) {
  const { body, ...rest } = issue;
  const text = String(body ?? '').trim();
  return { ...rest, excerpt: text.length > ISSUE_EXCERPT ? `${text.slice(0, ISSUE_EXCERPT)}…` : text };
}

/**
 * Route every open issue, and separately collect the ones the sweep agent must
 * see regardless of routing (P0/P1/security).
 */
export function routeIssues(issues, units, ticketsByIssue = new Map()) {
  const byUnit = new Map();
  const unmapped = [];
  const escalated = [];
  for (const issue of issues) {
    const { unit, via } = routeIssue(issue, units, ticketsByIssue);
    const record = stripBody({ ...issue, routedVia: via, routedTo: unit });
    if (unit) {
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit).push(record);
    } else {
      unmapped.push(record);
    }
    if (isEscalated(issue)) escalated.push(record);
  }
  return { byUnit, unmapped, escalated };
}

// ─── repository probes ───────────────────────────────────────────────────────

/** Run a command, returning `{ok, out}` rather than throwing. */
export function tryRun(cmd, args, { run = execFileSync, cwd = ROOT } = {}) {
  try {
    return { ok: true, out: String(run(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim() };
  } catch (err) {
    return { ok: false, out: String(err?.stderr ?? err?.message ?? err).trim() };
  }
}

/** The newest `vX.Y.Z` tag, which is the default audit baseline. */
export function newestVersionTag({ run = execFileSync } = {}) {
  const r = tryRun('git', ['tag', '--sort=-v:refname', '--list', 'v*'], { run });
  if (!r.ok) return null;
  return r.out.split('\n').map((s) => s.trim()).find((s) => /^v\d+\.\d+\.\d+$/.test(s)) ?? null;
}

/**
 * What changed in a unit since the baseline tag — the delta hint that tells an
 * agent where to spend its attention. Not a scope restriction: the agent still
 * audits the whole unit.
 */
export function churnFor(dir, since, { run = execFileSync } = {}) {
  if (!since) return { since: null, commits: 0, subjects: [], filesChanged: 0, unconsultable: 'no baseline tag' };
  const log = tryRun('git', ['log', '--no-merges', '--format=%h %s', `${since}..HEAD`, '--', dir], { run });
  if (!log.ok) return { since, commits: 0, subjects: [], filesChanged: 0, unconsultable: log.out };
  const subjects = log.out ? log.out.split('\n') : [];
  const stat = tryRun('git', ['diff', '--name-only', `${since}..HEAD`, '--', dir], { run });
  const files = stat.ok && stat.out ? stat.out.split('\n') : [];
  return { since, commits: subjects.length, subjects: subjects.slice(0, 25), filesChanged: files.length, files: files.slice(0, 50) };
}

/** How many open issues a single fetch will ask for. */
export const ISSUE_FETCH_LIMIT = 500;

/**
 * Open GitHub issues, or an explicit unconsultable record when `gh` cannot answer.
 *
 * A response of exactly ISSUE_FETCH_LIMIT is reported as `truncated` rather than
 * accepted: a capped list is indistinguishable from a complete one, and silently
 * dropping the tail would let the audit report "no blocking issues" about issues
 * it never saw.
 */
export function fetchIssues({ run = execFileSync, skip = false } = {}) {
  if (skip) return { issues: [], unconsultable: 'skipped via --skip-issues', truncated: null };
  const r = tryRun('gh', ['issue', 'list', '--state', 'open', '--limit', String(ISSUE_FETCH_LIMIT), '--json', 'number,title,body,labels,url,milestone'], { run });
  if (!r.ok) return { issues: [], unconsultable: `gh issue list failed: ${r.out.slice(0, 400)}`, truncated: null };
  try {
    const parsed = JSON.parse(r.out);
    return {
      issues: parsed.map((i) => ({
        number: i.number,
        title: i.title,
        // Bodies run to thousands of words. Routing needs path mentions, which
        // cluster early; the agent gets the URL and can read the rest itself.
        body: String(i.body ?? '').slice(0, 4000),
        labels: (i.labels ?? []).map((l) => l.name),
        url: i.url,
        milestone: i.milestone?.title ?? null,
      })),
      unconsultable: null,
      truncated: parsed.length >= ISSUE_FETCH_LIMIT ? ISSUE_FETCH_LIMIT : null,
    };
  } catch (err) {
    return { issues: [], unconsultable: `gh issue list returned unparseable JSON: ${err.message}`, truncated: null };
  }
}

/** Every ADLC ticket, indexed by the GitHub issue its body backlinks to. */
export function ticketsByIssueNumber({ root = ROOT, readDir = readdirSync, readFile = readFileSync } = {}) {
  const index = new Map();
  let files;
  try { files = readDir(join(root, '.adlc', 'tickets')); } catch { return index; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let ticket;
    try { ticket = JSON.parse(readFile(join(root, '.adlc', 'tickets', f), 'utf8')); } catch { continue; }
    for (const n of linkedIssueNumbers(ticket.body)) {
      if (!index.has(n)) index.set(n, []);
      index.get(n).push({ id: ticket.id, title: ticket.title, scope: ticket.scope ?? [], completed: ticket.completed === true });
    }
  }
  return index;
}

/**
 * The cheap mechanical baseline, run synchronously while the agents fan out.
 *
 * Version drift is checked against the CURRENT root version, not the target: the
 * audit runs BEFORE the bump, when every artifact is legitimately still on the
 * released version. Comparing against the target here would report 38 spurious
 * problems on a perfectly healthy tree and train the reader to ignore the probe.
 */
export async function probes(currentVersion, { root = ROOT, run = execFileSync, loadRelease = () => import('./release.mjs') } = {}) {
  const out = { unconsultable: [] };

  const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { run });
  const status = tryRun('git', ['status', '--porcelain'], { run });
  const head = tryRun('git', ['rev-parse', 'HEAD'], { run });
  const originMain = tryRun('git', ['rev-parse', 'origin/main'], { run });
  out.git = {
    branch: branch.ok ? branch.out : null,
    clean: status.ok ? status.out === '' : null,
    dirtyPaths: status.ok && status.out ? status.out.split('\n').slice(0, 40) : [],
    head: head.ok ? head.out : null,
    originMain: originMain.ok ? originMain.out : null,
    syncedWithOriginMain: head.ok && originMain.ok ? head.out === originMain.out : null,
  };

  try {
    const rel = await loadRelease();
    out.versionDrift = rel.findVersionDrift(currentVersion, { root });
    out.publishMetadata = rel.findPublishMetadataProblems();
    out.hostDiscoveryNearMisses = rel.hostDiscoveryNearMisses({ root });
    out.publishTargetCount = rel.publishTargets().length;
  } catch (err) {
    // "Could not check" must never render as "verified" — release.mjs's own rule.
    out.unconsultable.push(`release.mjs mechanical checks: ${err.message}`);
  }
  return out;
}

// ─── assembly ────────────────────────────────────────────────────────────────

/**
 * Assemble the audit input document. Pure with respect to its injected readers so
 * the whole shape is assertable without a repo.
 */
export function assemble({ version, since, units, issues, routed, probeResults, churn, issuesUnconsultable, issuesTruncated = null }) {
  return {
    schema: 'release-audit-input/1',
    version,
    since,
    unitCount: units.length,
    units: units.map((u) => ({
      ...u,
      churn: churn.get(u.id) ?? null,
      issues: routed.byUnit.get(u.id) ?? [],
    })),
    issues: {
      open: issues.length,
      routed: [...routed.byUnit.values()].reduce((n, list) => n + list.length, 0),
      unmapped: routed.unmapped,
      escalated: routed.escalated,
      sweepBatches: sweepBatches(routed.unmapped, routed.escalated),
      unconsultable: issuesUnconsultable,
      truncated: issuesTruncated,
    },
    probes: probeResults,
  };
}

/**
 * The subset of the collected document the workflow script actually reads.
 *
 * `args` is passed inline in the Workflow tool call, so its size is a real cost
 * paid on every run. The full document is richer than the fan-out needs — the
 * per-unit `files` inventory alone is 47 KB, and no prompt references it (a unit
 * agent reads the repository itself; it is told the file COUNT and weight so it
 * knows what it is walking into). Projecting to what the prompts use keeps the
 * fan-out affordable without thinning the document the report is built from.
 *
 * Anything the workflow reads must appear here — a field dropped from this
 * projection becomes `undefined` inside a prompt, which renders as the literal
 * string "undefined" rather than failing.
 */
export function workflowArgs(doc) {
  // The prompts print an issue's number, labels, title, url and routing — not its
  // text. The excerpt exists for the report and for a human reading input.json; an
  // agent that wants the body runs `gh issue view`. Carrying it into `args` cost
  // ~35 KB per run for something no prompt renders.
  const slimIssue = ({ excerpt, ...rest }) => rest;
  return {
    version: doc.version,
    currentVersion: doc.currentVersion,
    since: doc.since,
    filtered: doc.filtered === true,
    units: (doc.units ?? []).map((u) => ({
      id: u.id, kind: u.kind, dir: u.dir, name: u.name, version: u.version,
      published: u.published, manifest: u.manifest, bin: u.bin, filesField: u.filesField,
      dependencies: u.dependencies, engines: u.engines, hasTests: u.hasTests,
      fileCount: u.fileCount, bytes: u.bytes, churn: u.churn,
      issues: (u.issues ?? []).map(slimIssue),
    })),
    issues: { sweepBatches: (doc.issues?.sweepBatches ?? [[]]).map((b) => b.map(slimIssue)) },
    probes: {
      versionDrift: doc.probes?.versionDrift ?? [],
      publishMetadata: doc.probes?.publishMetadata ?? [],
      hostDiscoveryNearMisses: doc.probes?.hostDiscoveryNearMisses ?? [],
    },
  };
}

export async function collectMain(argv = process.argv.slice(2), deps = {}) {
  const { root = ROOT, readFile = readFileSync, log = console.log } = deps;
  const args = parseArgs(argv);

  const rootPkg = JSON.parse(readFile(join(root, 'package.json'), 'utf8'));
  const currentVersion = rootPkg.version;
  const version = args.version ?? nextMinor(currentVersion);
  const since = args.since ?? newestVersionTag(deps);

  // Discover EVERY unit, then narrow. Routing must see the whole repository even
  // when the run does not: `--packages hollow-test` filtered the unit list first,
  // so an issue naming both packages/fleet and packages/hollow-test found only one
  // match left standing and routed to it with via=path-mention. The ambiguity that
  // should have sent it to the sweep agent was erased by the filter, and a narrowed
  // run presented a shared issue to one artifact as if it solely owned it — the
  // over-claiming this router is written to refuse.
  const allUnits = discoverUnits({ root });
  const units = args.packages
    ? allUnits.filter((u) => {
      const wanted = new Set(args.packages.map((n) => n.replace(/^@adlc\//, '')));
      return wanted.has(u.slug) || wanted.has(u.name) || wanted.has(u.id);
    })
    : allUnits;

  const churn = new Map(units.map((u) => [u.id, churnFor(u.dir, since, deps)]));
  const { issues, unconsultable: issuesUnconsultable, truncated: issuesTruncated } = fetchIssues({ ...deps, skip: args.skipIssues });
  const routed = routeIssues(issues, allUnits, ticketsByIssueNumber({ root }));
  const probeResults = await probes(currentVersion, { root, ...deps });

  const doc = assemble({ version, since, units, issues, routed, probeResults, churn, issuesUnconsultable, issuesTruncated });
  doc.currentVersion = currentVersion;
  doc.filtered = Boolean(args.packages);
  log(JSON.stringify(args.workflowArgs ? workflowArgs(doc) : doc, null, 2));
  return 0;
}

const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) process.exit(await collectMain());
