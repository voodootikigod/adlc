// The end-to-end fixture of AC 30 / 36 / 38 / 46 / 82 / 108 / 144: a REAL
// temporary repository with a bare `origin` and NET_GIT (S4's recover-fixture),
// the PRODUCTION context wiring (lib/context.mjs buildContext, so `ctx.deps` is
// exactly what the loop composes), and fake `adlc` / `gh` / `claude` /
// `npm` / `bwrap` / `adversarial-review` tools that record their argv and create
// the files the real tools would (ticket shards, manifest lines, the fleet
// integration branch, PRs, check rows).

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFixture, FAKE, GIT } from './recover-fixture.mjs';
import { fakeGithub } from './recover-gh.mjs';
import { buildContext } from '../../lib/context.mjs';
import { acquireLock, selfIdentity, defaultProbes } from '../../lib/lock.mjs';
import { ticketFilename } from '../../../tickets/lib/filename.mjs';
import { AUTOPILOT_DEFAULTS } from '../../lib/config.mjs';
import { STATIC_EXTRAS } from '../../lib/denylist.mjs';
import { CRITERIA_HEADING } from '../../lib/evidence.mjs';
import { credentialsPath } from '../../lib/token-refresh.mjs';
import { globMatch } from '@adlc/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const FAKE_TOOLS = Object.freeze({ ...FAKE, bwrap: '/fake/bin/bwrap', 'adversarial-review': '/fake/bin/adversarial-review' });
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const fakeTicketId = () => `T-${Array.from(randomBytes(26)).map((b) => CROCKFORD[b % 32]).join('')}`;

const flag = (args, name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const twoDocs = (a, b) => `${JSON.stringify(a, null, 2)}\n${JSON.stringify(b, null, 2)}\n`;

/** Append one signed-looking manifest line under `<cwd>/.adlc/manifest.d/` (what the key-bearing adlc commands do). */
export function appendManifestLine(cwd, entry) {
  const dir = join(cwd, '.adlc', 'manifest.d');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'autopilot-run.jsonl'), `${JSON.stringify({ ...entry, at: '2026-08-28T12:00:00.000Z', sig: `fake-${sha256(JSON.stringify(entry)).slice(0, 16)}` })}\n`);
}

/**
 * @param opts.gateStatus   (gateName, callIndex) → exit status of the sandboxed gate (default 0)
 * @param opts.reviewVerdict (callIndex) → 'approve' | 'needs-attention' | 'unavailable'
 * @param opts.checks       () → rows for `gh pr checks` (default all blocking jobs pass)
 * @param opts.fleet        (argv, meta, fx) → custom fleet behaviour; default = one worker commit + integration branch
 */
export async function createSequenceFixture({ issue = 7, gateStatus = () => 0, reviewVerdict = () => 'approve', checks = null, fleet = null, worker = null, claudeAnswer = null, config = {}, prsOpenAtStart = [], onManifestVerify = null, reviewerSideEffect = null, onColdstart = null, spawner = {}, quotaRead = undefined, local: localOverrides = {}, dryRun = false, flags = {}, fetchImpl = null } = {}) {
  const gh = fakeGithub({ permissions: { op: 'admin' } });
  const state = { fleetRuns: 0, gateCalls: 0, reviewCalls: 0, checkPolls: 0, updates: [], prs: [], nextPr: 41, completeCalls: 0, issue: { number: issue, title: `Add widget (#${issue})`, body: 'Please add the widget.', state: 'OPEN', updatedAt: '2026-08-28T10:00:00Z', createdAt: '2026-08-01T10:00:00Z', labels: [], author: { login: 'op' }, authorAssociation: 'OWNER' } };
  const handlers = {};
  const fx = createFixture({ gh, handlers, spawner });
  const { repoRoot, originPath, paths } = fx;
  // Every spawn advances the fixture clock one second, so timestamps (dead-end files, records) never collide.
  fx.hooks.push(() => fx.advance(1000));

  // The fixture repository at BASE_OID: the real scripts/preflight.mjs (the normative gate order), a workspace package, .adlc/ scaffolding.
  mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'scripts', 'preflight.mjs'), join(repoRoot, 'scripts', 'preflight.mjs'));
  cpSync(join(REPO, 'scripts', 'rails-guard-ci.mjs'), join(repoRoot, 'scripts', 'rails-guard-ci.mjs'));
  mkdirSync(join(repoRoot, 'packages', 'rails-guard', 'lib', 'ci'), { recursive: true });
  cpSync(join(REPO, 'packages', 'rails-guard', 'lib', 'ci', 'trust-roots.mjs'), join(repoRoot, 'packages', 'rails-guard', 'lib', 'ci', 'trust-roots.mjs'));
  mkdirSync(join(repoRoot, 'packages', 'x'), { recursive: true });
  writeFileSync(join(repoRoot, 'packages', 'x', 'package.json'), '{"name":"@adlc/x","version":"1.0.0"}\n');
  writeFileSync(join(repoRoot, 'packages', 'x', 'index.js'), 'export const x = 1;\n');
  mkdirSync(join(repoRoot, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(join(repoRoot, '.adlc', 'manifest.d', '.keep'), '');
  writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n.worktrees/\n.adlc/autopilot-runs/\n.adlc/autopilot-status.json\n.adlc/autopilot.lock/\n.adlc/net.git/\n');
  fx.sh(['add', '-A']); fx.sh(['commit', '-q', '-m', 'seed gates + package']);
  fx.sh(['push', '-q', originPath, 'main:refs/heads/main']);
  const baseOid = fx.sh(['rev-parse', 'main']);
  fx.baseOid = baseOid;

  // ---- fake adlc ----
  const shardPathFor = (wt, id) => join(wt, '.adlc', 'tickets', ticketFilename(id));
  const findShard = (wt) => { const dir = join(wt, '.adlc', 'tickets'); return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))[0] ?? null : null; };
  handlers[FAKE.adlc] = async (args, { cwd, stdin }) => {
    const [sub, verb] = args;
    if (sub === 'ticket' && verb === 'create' && !args.includes('--write')) {
      // the triage schema gate: a DRY RUN over stdin (never key-bearing, never a shard)
      try { const doc = JSON.parse(String(stdin ?? '')); if (!doc || typeof doc.title !== 'string') return { status: 2, stderr: 'schema: title required' }; } catch (e) { return { status: 2, stderr: `schema: ${e.message}` }; }
      return { stdout: JSON.stringify({ ticketId: 'T-<dry-run>', dryRun: true }) };
    }
    if (sub === 'spec-lint') return { stdout: JSON.stringify({ ok: true, findings: [] }) };
    if (sub === 'ticket' && verb === 'create') {
      const root = flag(args, '--root'); if (!root || args.includes('--dir')) return { status: 1, stderr: 'ticket create: --root required, --dir refused' };
      const doc = JSON.parse(String(stdin ?? '{}'));
      const id = fakeTicketId();
      const shard = shardPathFor(root, id);
      mkdirSync(dirname(shard), { recursive: true });
      writeFileSync(shard, `${JSON.stringify({ ...doc, id, completed: false }, null, 2)}\n`);
      appendManifestLine(root, { gate: 'ticket-create', ticket: id });
      return { stdout: twoDocs({ ticketId: id, dryRun: false }, { applied: true, storeHash: 's1', ticketHash: sha256(readFileSync(shard, 'utf8')) }) };
    }
    if (sub === 'ticket' && (verb === 'show' || verb === 'complete' || verb === 'update')) {
      const root = flag(args, '--root'); if (!root || args.includes('--dir')) return { status: 1, stderr: `ticket ${verb}: --root required` };
      const shard = findShard(root); if (!shard) return { status: 1, stderr: 'no shard' };
      const cur = JSON.parse(readFileSync(shard, 'utf8'));
      if (verb === 'show') return { stdout: JSON.stringify({ ticket: cur, ticketHash: sha256(readFileSync(shard, 'utf8')), storeHash: 's1' }) };
      if (verb === 'complete') {
        state.completeCalls++;
        writeFileSync(shard, `${JSON.stringify({ ...cur, completed: true }, null, 2)}\n`);
        appendManifestLine(root, { gate: 'ticket-complete', ticket: cur.id });
        return { stdout: twoDocs({ ticketId: cur.id }, { applied: true, storeHash: 's2', ticketHash: sha256(readFileSync(shard, 'utf8')) }) };
      }
      const expect = flag(args, '--expect');
      if (expect !== sha256(readFileSync(shard, 'utf8'))) return { status: 2, stderr: 'HASH_MISMATCH' };
      if (!args.includes('--authorize') && cur.completed) return { status: 2, stderr: 'AUTHORIZATION_REQUIRED' };
      const next = JSON.parse(String(stdin ?? '{}'));
      state.updates.push({ before: cur, stdin: next, args: [...args] });
      writeFileSync(shard, `${JSON.stringify({ ...next, id: cur.id }, null, 2)}\n`);
      appendManifestLine(root, { gate: 'ticket-update', ticket: cur.id });
      return { stdout: twoDocs({ ticketId: cur.id }, { applied: true, storeHash: 's3', ticketHash: sha256(readFileSync(shard, 'utf8')) }) };
    }
    if (sub === 'coldstart') {
      if (args.includes('--record-verdict')) { appendManifestLine(cwd, { gate: 'coldstart', ticket: args[1], verdict: 'PROCEED' }); return { stdout: '{"recorded":true}' }; }
      onColdstart?.(state, fx);
      return { stdout: `COLDSTART PROMPT for ${args[1]}\n` };
    }
    if (sub === 'prosecute' && verb === 'record-cross-model') {
      appendManifestLine(cwd, { gate: 'cross-model-review', ticket: flag(args, '--ticket'), verdict: 'approve', carryForward: flag(args, '--carry-forward') });
      state.recordCrossModel = (state.recordCrossModel ?? []).concat([{ argv: [...args], head: fx.sh(['rev-parse', 'HEAD'], cwd) }]);
      return { stdout: JSON.stringify({ ok: true, data: { revision: `rev-${state.recordCrossModel.length}` } }) };
    }
    if (sub === 'gate-manifest' && verb === 'verify') { onManifestVerify?.(cwd, state, fx); return { stdout: '{"ok":true}' }; }
    if (sub === 'gate-manifest' && verb === 'attest') return { stdout: 'evidence: fake' };
    if (sub === 'fleet' && verb === 'run') {
      state.fleetRuns++;
      try { return await (fleet ? fleet(args, { cwd }, fx, state) : defaultFleet(args, { cwd }, fx, state, worker)); }
      catch (e) { return { status: 1, stderr: `fleet fake threw: ${e.stack ?? e.message}` }; }
    }
    return { status: 1, stderr: `fake adlc: unhandled ${args.join(' ')}` };
  };
  // ---- fake node (spec-lint via the in-repo bin) ----
  handlers[FAKE.node] = (args, { cwd }) => {
    if (String(args[0]).endsWith('spec-lint.mjs') && args.includes('--record')) { appendManifestLine(cwd, { gate: 'spec-lint', ticket: flag(args, '--ticket') }); return { stdout: '{"ok":true}' }; }
    return { stdout: '' };
  };
  handlers[FAKE.claude] = (args, { stdin }) => {
    state.claudeCalls = (state.claudeCalls ?? []).concat([{ args: [...args], stdin: String(stdin ?? '') }]);
    if (claudeAnswer) return { stdout: JSON.stringify(claudeAnswer(args, stdin, state)) };
    if (String(stdin ?? '').includes('COLDSTART PROMPT')) return { stdout: JSON.stringify({ type: 'result', result: JSON.stringify({ gaps: [] }) }) };
    // the shaping answer (§5.2): a ticket whose body starts with the issue URL and carries the criteria marker
    const url = `https://github.com/o/r/issues/${state.issue.number}`;
    const shaped = { title: state.issue.title, category: 'feature', scope: ['packages/x/**'], rails: [], edges: [], duration: 1, body: `GitHub issue: ${url}\n\n${state.issue.body}\n\n${CRITERIA_HEADING}\n- widget exists\n- tests pass\n` };
    return { stdout: JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(shaped) }) };
  };
  handlers[FAKE.npm] = (args, { cwd }) => { mkdirSync(join(cwd, 'node_modules'), { recursive: true }); writeFileSync(join(cwd, 'node_modules', '.package-lock.json'), '{}'); return { stdout: '' }; };
  handlers[FAKE_TOOLS['adversarial-review']] = (args, { cwd }) => {
    const call = state.reviewCalls++;
    reviewerSideEffect?.(cwd, call, fx);
    const v = reviewVerdict(call);
    if (v === 'unavailable') return { status: 1, stderr: 'reviewer unavailable' };
    return { status: v === 'approve' ? 0 : 2, stdout: JSON.stringify({ verdict: v, findings: v === 'approve' ? [] : [{ severity: 'high', title: 'planted finding', file: 'packages/x/impl.js' }] }) };
  };
  handlers[FAKE_TOOLS.bwrap] = (args) => {
    const sep = args.lastIndexOf('--');
    const inner = sep === -1 ? args : args.slice(sep + 1);
    const script = inner.find((a) => /scripts\/[a-z-]+\.mjs$/.test(String(a))) ?? '';
    const name = script.replace(/^.*scripts\//, '').replace(/\.mjs$/, '');
    const st = gateStatus(name, state.gateCalls++);
    return st === 0 ? { stdout: `${name} ok\n` } : { status: st, stderr: `${name} failed (planted)\n` };
  };

  // ---- fake gh: PRs, checks, issue reads ----
  const base = gh.handler;
  gh.handler = (args) => {
    const [sub, verb] = args;
    if (sub === 'pr' && verb === 'create') {
      const head = flag(args, '--head');
      const pr = { number: state.nextPr++, head, state: 'OPEN', baseRefName: 'main', title: flag(args, '--title') };
      state.prs.push(pr); gh.prs.push(pr);
      return { stdout: `https://github.com/o/r/pull/${pr.number}\n` };
    }
    if (sub === 'pr' && verb === 'edit') { state.prEdits = (state.prEdits ?? 0) + 1; return { stdout: `https://github.com/o/r/pull/${args[2]}\n` }; }
    if (sub === 'pr' && verb === 'view') {
      const pr = state.prs.find((p) => String(p.number) === String(args[2]));
      if (!pr) return { status: 1, stderr: 'no pull requests found' };
      return { stdout: JSON.stringify({ number: pr.number, state: pr.state, headRefOid: fx.remoteOid(pr.head), baseRefName: pr.baseRefName, mergeStateStatus: 'CLEAN', headRefName: pr.head }) };
    }
    if (sub === 'pr' && verb === 'checks') {
      state.checkPolls++;
      const rows = checks ? checks(state) : ['test (18)', 'test (20)', 'test (22)', 'rails-guard', 'mutation-gate', 'cross-model-gate', 'ticket-store-platform (ubuntu-latest, 20)'].map((name) => ({ name, state: 'SUCCESS', bucket: 'pass', workflow: 'ci' }));
      return { status: rows.every((r) => r.bucket === 'pass') ? 0 : 8, stdout: JSON.stringify(rows) };
    }
    if (sub === 'issue' && verb === 'view') {
      const n = Number(args[2]);
      const labels = (gh.labels[n] ?? gh.labels[String(n)] ?? []).map((name) => ({ name }));
      const doc = n === state.issue.number ? { ...state.issue, labels, url: `https://github.com/o/r/issues/${n}` } : { number: n, labels, state: 'OPEN', title: `issue ${n}`, body: '', updatedAt: '2026-08-28T10:00:00Z' };
      return { stdout: JSON.stringify(doc) };
    }
    if (sub === 'issue' && verb === 'list') return { stdout: '[]' };
    if (sub === 'api' && /^repos\/[^/]+\/[^/]+\/issues\?state=open/.test(args[1] ?? '')) {
      const page = Number((args[1].match(/[?&]page=(\d+)/) ?? [])[1] ?? 1);
      if (page > 1) return { stdout: '[]' };
      const i = state.issue; const labels = (gh.labels[String(i.number)] ?? []).map((name) => ({ name }));
      return { stdout: JSON.stringify([{ number: i.number, title: i.title, body: i.body, state: 'open', labels, milestone: null, created_at: i.createdAt, updated_at: i.updatedAt, user: { login: i.author.login }, author_association: i.authorAssociation, html_url: `https://github.com/o/r/issues/${i.number}` }]) };
    }
    if (sub === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: null, userContentEdits: { nodes: [] } } } } }) };
    if (sub === 'issue' && verb === 'create') { state.logIssue = 900; return { stdout: 'https://github.com/o/r/issues/900\n' }; }
    if (sub === 'run' && verb === 'list') return { stdout: '[]' };
    if (sub === 'run' && verb === 'view') return { stdout: 'log line\n' };
    return base(args);
  };
  // createFixture COPIED the handler table at construction: install every fake registered since, and the wrapped gh.
  Object.assign(fx.table, handlers);
  fx.table[FAKE.gh] = gh.handler;
  for (const pr of prsOpenAtStart) { state.prs.push(pr); gh.prs.push(pr); }

  // The host credential file (8 h of lifetime → the §6.4 item 14 margin holds).
  const credFile = credentialsPath(fx.ctx.env.home);
  mkdirSync(dirname(credFile), { recursive: true, mode: 0o700 });
  writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access-token', refreshToken: 'fake-refresh', expiresAt: fx.clock.value + 8 * 60 * 60_000 } }), { mode: 0o600 });

  // ---- the PRODUCTION context wiring over the fixture ----
  const key = 'k'.repeat(48);
  const local = { model: 'opus', quotaThreshold: 50, quotaReserve: 5, adapter: 'claude-code', trustedBinDirs: null, sshIdentity: null, issue: null, force: false, dryRun, restMs: null, ...localOverrides };
  // quotaRead: undefined → the fixture's always-ok reader; null → the PRODUCTION reader (fetchImpl + claude fallback); a function → that reader.
  state.quotaRead = quotaRead === null ? null : (quotaRead ?? (async () => ({ ok: true, fiveHour: 10, sevenDay: 10, scoped: new Map([['opus', 10], ['sonnet', 10]]), resetsAt: { fiveHour: null } })));
  const ctx = await buildContext({
    flags, env: { PATH: process.env.PATH, HOME: fx.ctx.env.home }, cwd: repoRoot, local, dryRun,
    overrides: { spawn: fx.ctx.spawn, recorder: fx.recorder, repoRoot, now: () => fx.clock.value, key, log: (l) => fx.logs.push(l), iterationToken: 'e'.repeat(64), iterationId: 'it-seq-1', ...(state.quotaRead ? { quota: { read: () => state.quotaRead(state) } } : {}), ...(fetchImpl ? { fetchImpl } : {}), sleep: async () => { fx.advance(1000); } },
  });
  ctx.pinned = { ...fx.ctx.pinned, ...FAKE_TOOLS, git: GIT, 'git:realpath': GIT, node: FAKE.node, specLintBin: join(repoRoot, 'packages', 'spec-lint', 'bin', 'spec-lint.mjs') };
  ctx.remote = fx.ctx.remote;
  ctx.gh = fx.ctx.gh;
  ctx.git = { ...fx.ctx.git, overlayEnv: () => ({}), lsRemoteOid: async (url, ref) => { const r = await fx.ctx.git.net(['ls-remote', url, ref]); const line = r.stdout.split('\n').find((l) => l.endsWith(`\t${ref}`)); return line ? line.split('\t')[0] : null; }, assertIdentity: async () => true };
  ctx.config = { autopilot: { ...AUTOPILOT_DEFAULTS, repo: 'o/r', ...config }, fleet: { gate: { build: 'npm run build', test: 'npm test' }, init: 'npm ci --ignore-scripts', base: 'main', concurrency: 1, timeoutMinutes: 30, prosecuteFailOn: 'medium', reviewProvider: 'codex', reviewMaxBytes: 262144, allowedCommands: ['adlc *'] }, ticketSync: { provider: 'github', select: { state: 'open', labels: [] } } };
  ctx.baseOid = baseOid;
  ctx.lock = dryRun ? null : acquireLock(paths.adlc, { self: selfIdentity(), probes: defaultProbes(), now: () => fx.clock.value });
  ctx.denylist = { globs: STATIC_EXTRAS, matches: (p) => STATIC_EXTRAS.some((g) => globMatch(g, p)) };
  ctx.charterPath = join(REPO, 'packages', 'autopilot', 'lib', 'charter-adlc.md');

  const ticket = { title: `Add widget (#${issue})`, category: 'feature', scope: ['packages/x/**'], rails: [], edges: [], duration: 1, body: `Please add the widget.\n\n${CRITERIA_HEADING}\n- widget exists\n- tests pass\n` };
  return {
    ...fx, ctx, gh, state, issue, ticket, baseOid, key,
    argvsOf: (exe) => fx.recorder.filter((r) => r.argv[0] === exe).map((r) => r.argv.slice(1)),
    /** Fake loop-level collaborators around the real selection/triage/run: `iterate` can be driven with these. */
    loopDeps: (over = {}) => ({
      ...ctx.deps,
      preflight: { phaseA: async () => {}, resolveBaseline: async () => baseOid, phaseB: async () => { const { applyLowering } = await import('../../lib/config.mjs'); ctx.config = { ...ctx.config, autopilot: applyLowering(ctx.config.autopilot, ctx.flags ?? {}) }; return { complete: true, incomplete: [], tokenShort: false, checks: {} }; }, ...(over.preflight ?? {}) },
      recover: { recover: async () => ({ actions: [] }) },
      maintain: { maintainOpenPrs: async () => ({ actions: [] }), activePrCount: () => 0 },
      digest: { postDigest: async () => ({ ok: true, posted: false }) },
      effects: { ...ctx.deps.effects, reconcilePendingEffects: async () => ({ replayed: [], complete: true }) },
      maintenanceDeps: () => ({}),
      ...over,
    }),
    cleanup: () => { try { ctx.lock?.release(); } catch { /* released */ } fx.cleanup(); },
  };
}

/**
 * The default fleet fake: a worker commit in scope on top of the issue branch,
 * published as the integration branch `fleet/run-<id>` in the caller repository
 * (cut from ISSUE_WT's branch, exactly what `--base <branch>` yields), and the
 * total `--json` result document with the bounded/mirror/allowlist policy echo.
 */
export function defaultFleet(args, { cwd }, fx, state, worker = null) {
  const runId = `${20260828120000 + state.fleetRuns}`;
  const branch = flag(args, '--base');
  const integration = `fleet/run-${runId}`;
  const wt = join(fx.root, `fleet-wt-${runId}`);
  fx.sh(['worktree', 'add', '-q', wt, '-b', integration, branch], cwd);
  if (worker) worker(wt, { round: state.fleetRuns, args });
  else { mkdirSync(join(wt, 'packages', 'x'), { recursive: true }); writeFileSync(join(wt, 'packages', 'x', 'impl.js'), `export const widget = ${state.fleetRuns};\n`); }
  fx.sh(['add', '-A'], wt); fx.sh(['commit', '-q', '--allow-empty', '-m', `feat(x): widget (round ${state.fleetRuns})`], wt);
  fx.sh(['worktree', 'remove', '--force', wt], cwd);
  const ticketId = flag(args, '--tickets');
  return { stdout: JSON.stringify({ fleetRunId: runId, exitCode: 0, reason: null, integrationBranch: integration, readPolicy: 'bounded', gitSource: 'mirror', egress: 'allowlist', strikesConsumed: 1, merged: 1, tickets: { [ticketId]: { state: 'merged', strikes: 1 } } }) };
}
