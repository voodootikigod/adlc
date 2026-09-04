// AC 24 / 72 / 98 (the parts creation owns) — the §6 path contract, the
// §6.3 coldstart/spec-lint record mechanics and the tracked criteria
// document, against a REAL temporary git repository (recover-fixture.mjs)
// with adlc / claude / npm / spec-lint faked by pinned path.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { createFixture, FAKE, GIT } from './helpers/recover-fixture.mjs';
import { createIssueWorktree, writeTicket, recordEvidence } from '../lib/create.mjs';
import { manifestLineHashes } from '../lib/evidence.mjs';
import { manifestLineSha256, canonicalTicketSha256, criteriaDocPath } from '../lib/diffcheck.mjs';
import { resolveRepoRoot } from '../lib/paths.mjs';
import { MANIFEST_KEY_VAR } from '../lib/keys.mjs';

const TICKET_ID = 'T-01M0ZTEST0000000000000000A';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const TICKET = { title: 'Add the thing', body: 'GitHub issue: https://x/1\n\nBuild it.\n\n=== ACCEPTANCE CRITERIA ===\n1. It works. VERIFY: node --test\n\n=== NOT IN SCOPE ===\nother', scope: ['packages/x/**'], rails: [], category: 'feature', duration: 1 };

/** Fakes for adlc / claude / spec-lint; `state.answer` is what claude returns; `state.calls` collects the record/lint invocations. */
function fakes() {
  const state = { answer: { gaps: [] }, calls: [], shard: null };
  const dirOf = (args) => args[args.indexOf('--dir') + 1];
  // The real ticket CLI takes --root <repoRoot> (store = <root>/.adlc/tickets), never --dir.
  const rootOf = (args) => { if (args.includes('--dir')) throw new Error('adlc ticket does not accept --dir'); return args[args.indexOf('--root') + 1]; };
  const manifestAppend = (dir, line) => { mkdirSync(join(dir, 'manifest.d'), { recursive: true }); appendFileSync(join(dir, 'manifest.d', 'test.jsonl'), `${JSON.stringify(line)}\n`); };
  const handlers = {
    [FAKE.adlc]: (args, { cwd, env, stdin }) => {
      if (args[0] === 'ticket' && args[1] === 'create') {
        const dir = join(rootOf(args), '.adlc'); const input = JSON.parse(stdin);
        mkdirSync(join(dir, 'tickets'), { recursive: true });
        const shard = JSON.stringify({ ...input, id: TICKET_ID }, null, 2) + '\n';
        state.shard = join(dir, 'tickets', `${TICKET_ID.toLowerCase()}--add-the-thing.json`); writeFileSync(state.shard, shard);
        manifestAppend(dir, { gate: 'ticket-mutation', ticket: TICKET_ID });
        return { stdout: `${JSON.stringify({ ticketId: TICKET_ID, dryRun: false }, null, 2)}\n${JSON.stringify({ applied: true, storeHash: 's', ticketHash: sha256(shard) }, null, 2)}\n` };
      }
      if (args[0] === 'ticket' && args[1] === 'show') { rootOf(args); return { stdout: JSON.stringify({ ticket: { id: args[2] }, ticketHash: sha256(readFileSync(state.shard, 'utf8')), storeHash: 's' }) }; }
      if (args[0] === 'coldstart' && !args.includes('--record-verdict')) { state.calls.push({ kind: 'prompt', args, cwd, env }); return { stdout: `PROMPT for ${args[1]}\n` }; }
      if (args[0] === 'coldstart') { state.calls.push({ kind: 'record', args, cwd, env, stdin }); manifestAppend(join(cwd, '.adlc'), { gate: 'coldstart', ticket: args[1] }); return { stdout: 'gate-manifest: recorded\n' }; }
      return { status: 1, stderr: `unexpected adlc ${args.join(' ')}` };
    },
    [FAKE.claude]: (args, { cwd, env, stdin }) => { state.calls.push({ kind: 'claude', args, cwd, env, stdin }); return { stdout: JSON.stringify({ result: JSON.stringify(state.answer) }) }; },
    [FAKE.node]: (args, { cwd, env }) => {
      const file = args[1]; const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
      state.calls.push({ kind: 'lint', args, cwd, env, exists: text !== null, head: text?.split('\n')[0] ?? null, fileHash: text === null ? null : sha256(text) });
      manifestAppend(dirOf(args), { gate: 'spec-lint', ticket: args[args.indexOf('--ticket') + 1], fileHash: sha256(text ?? '') });
      return { stdout: 'ok\n' };
    },
  };
  return { state, handlers };
}
async function withFx(fn) { const { state, handlers } = fakes(); const fx = createFixture({ handlers }); try { await fn(fx, state); } finally { fx.cleanup(); } }
async function shaped(fx, issue = 1) { await createIssueWorktree({ ctx: fx.ctx, issue, baseOid: fx.baseOid }); return writeTicket({ ctx: fx.ctx, issue, ticket: TICKET }); }

export async function ac24_pathResolution() {
  await withFx(async (fx, state) => {
    const wt = fx.paths.issueWorktree(1); const adlc = fx.paths.issueAdlc(1);
    await shaped(fx, 1);
    const ev = await recordEvidence({ ctx: fx.ctx, issue: 1, ticketId: TICKET_ID, ticket: TICKET });
    assert.equal(ev.verdict, 'PROCEED');
    const rec = fx.recorder;
    const add = rec.find((r) => r.argv[0] === GIT && r.argv[1] === 'worktree' && r.argv[2] === 'add');
    assert.equal(add.cwd, fx.repoRoot, 'git worktree add runs with cwd = REPO_ROOT'); assert.ok(isAbsolute(add.argv[3]) && add.argv[3].startsWith(fx.paths.worktreesDir), 'absolute target under REPO_ROOT');
    const moveIdx = rec.findIndex((r) => r.argv[0] === GIT && r.argv[1] === 'worktree' && r.argv[2] === 'move');
    const later = rec.slice(moveIdx + 1);
    assert.ok(later.length >= 8, 'npm ci, ticket create, coldstart ×2, claude, ticket show, spec-lint, git add/commit');
    for (const r of later) {
      assert.equal(r.cwd, wt, `${r.argv.slice(0, 3).join(' ')}: cwd = ISSUE_WT`);
      const d = r.argv.indexOf('--dir'); if (d !== -1) assert.equal(r.argv[d + 1], adlc, 'every --dir is <ISSUE_WT>/.adlc');
      const ro = r.argv.indexOf('--root'); if (ro !== -1) assert.equal(r.argv[ro + 1], wt, 'every ticket --root is ISSUE_WT');
    }
    assert.deepEqual(later.filter((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'ticket').map((r) => r.argv.slice(1)), [
      ['ticket', 'create', '--input', '-', '--write', '--root', wt, '--json'], ['ticket', 'show', 'T-01M0ZTEST0000000000000000A', '--json', '--root', wt],
    ], 'ticket commands use --root <ISSUE_WT> (the CLI ignores --dir)');
    assert.ok(later.some((r) => r.argv[0] === FAKE.npm && r.argv[1] === 'ci' && r.argv.includes('--ignore-scripts')));
    // key hygiene along the way: only the three key-bearing children see the key
    const keyed = later.filter((r) => r.env[MANIFEST_KEY_VAR] !== undefined).map((r) => r.argv.slice(1, 3).join(' '));
    assert.deepEqual(keyed, ['ticket create', 'coldstart T-01M0ZTEST0000000000000000A', `${fx.ctx.pinned.specLintBin} ${state.calls.find((c) => c.kind === 'lint').args[1]}`]);
    // invoking from inside a linked worktree → not-main-worktree
    const git = (args, { cwd }) => spawnSync(GIT, args, { cwd, env: fx.base, encoding: 'utf8' }).stdout;
    assert.throws(() => resolveRepoRoot({ cwd: wt, git }), (e) => e.code === 'not-main-worktree');
    assert.equal(resolveRepoRoot({ cwd: fx.repoRoot, git }), fx.repoRoot);
  });
}
test('AC24: git worktree add runs at REPO_ROOT with an absolute ISSUE_WT target; every later spawn has cwd = ISSUE_WT and --dir = <ISSUE_WT>/.adlc; a linked worktree is refused', ac24_pathResolution);

export async function ac72_p0p1RecordMechanics() {
  await withFx(async (fx, state) => {
    const wt = fx.paths.issueWorktree(1); const ticketsDir = fx.paths.issueTickets(1);
    await shaped(fx, 1);
    const evil = "'; touch /tmp/x; echo '$(id)";
    state.answer = { gaps: [{ what: evil, why_blocking: 'unclear' }] };
    const clar = await recordEvidence({ ctx: fx.ctx, issue: 1, ticketId: TICKET_ID, ticket: TICKET });
    assert.equal(clar.verdict, 'CLARIFY'); assert.equal(clar.gaps[0].what, evil, 'the answer is re-serialized byte-for-byte, never interpreted');
    assert.equal(state.calls.filter((c) => c.kind === 'record').length, 0, 'a gaps array with one entry → zero record calls');
    const allowed = new Set([GIT, FAKE.npm, FAKE.adlc, FAKE.claude, FAKE.node]);
    assert.ok(fx.recorder.every((r) => allowed.has(r.argv[0]) && r.shell === false), 'no extra process, shell:false everywhere');
    state.answer = { gaps: [] };
    const ok = await recordEvidence({ ctx: fx.ctx, issue: 1, ticketId: TICKET_ID, ticket: TICKET });
    assert.equal(ok.verdict, 'PROCEED');
    const prompt = state.calls.find((c) => c.kind === 'prompt'); const record = state.calls.find((c) => c.kind === 'record'); const lint = state.calls.find((c) => c.kind === 'lint');
    assert.deepEqual(prompt.args, ['coldstart', TICKET_ID, '--tickets', ticketsDir, '--prompt-only']); assert.equal(prompt.cwd, wt); assert.ok(!prompt.args.includes('--dir'));
    assert.deepEqual(record.args, ['coldstart', TICKET_ID, '--tickets', ticketsDir, '--prompt-only', '--record-verdict', '-']); assert.equal(record.cwd, wt);
    const recSpawn = fx.recorder.find((r) => r.argv[0] === FAKE.adlc && r.argv.includes('--record-verdict'));
    assert.equal(recSpawn.shell, false); assert.equal(recSpawn.env[MANIFEST_KEY_VAR], fx.ctx.key);
    const payload = JSON.parse(record.stdin);
    assert.deepEqual(Object.keys(payload).sort(), ['gaps', 'ticketHash']); assert.deepEqual(payload.gaps, []);
    assert.equal(payload.ticketHash, sha256(readFileSync(state.shard, 'utf8')), 'ticketHash equals what adlc ticket show returned');
    const idx = fx.recorder.indexOf(recSpawn); const show = fx.recorder[idx - 1];
    assert.deepEqual(show.argv.slice(1, 4), ['ticket', 'show', TICKET_ID], 'ticket show immediately before the record call');
    const claude = fx.recorder.filter((r) => r.argv[0] === FAKE.claude).at(-1);
    assert.deepEqual(claude.argv.slice(1), ['-p', '--model', 'sonnet', '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', '1']);
    assert.equal(claude.stdinBytes.toString(), `PROMPT for ${TICKET_ID}\n`, 'the prompt travels on stdin'); assert.equal(claude.env[MANIFEST_KEY_VAR], undefined); assert.equal(claude.stdoutCap ?? 65536, 65536);
    assert.equal(lint.exists, true); assert.equal(lint.head, '## Acceptance criteria');
    assert.deepEqual(lint.args, [fx.ctx.pinned.specLintBin, join(wt, '.adlc', 'specs', `${TICKET_ID}-ac.md`), '--record', '--ticket', TICKET_ID, '--dir', join(wt, '.adlc')]);
  });
}
test('AC72: coldstart runs at ISSUE_WT with --tickets and --prompt-only (never --dir); the record call carries {gaps,ticketHash} on stdin with the hash ticket show just returned; a gap → CLARIFY with zero record calls; spec-lint sees the criteria file', ac72_p0p1RecordMechanics);

export async function ac98_criteriaDocumentIsTracked() {
  await withFx(async (fx, state) => {
    const wt = fx.paths.issueWorktree(1);
    await shaped(fx, 1);
    const ev = await recordEvidence({ ctx: fx.ctx, issue: 1, ticketId: TICKET_ID, ticket: TICKET });
    assert.equal(ev.verdict, 'PROCEED');
    const show = (args) => spawnSync(GIT, args, { cwd: wt, env: fx.base, encoding: 'utf8' }).stdout.trim();
    const files = show(['show', '--name-only', '--format=', 'HEAD']).split('\n');
    const criteriaRel = `.adlc/specs/${TICKET_ID}-ac.md`;
    assert.ok(files.includes(criteriaRel), `the ticket commit contains ${criteriaRel}`); assert.ok(files.includes(`.adlc/tickets/${TICKET_ID.toLowerCase()}--add-the-thing.json`));
    assert.equal(show(['log', '-1', '--format=%s']), `chore(ticket): ${TICKET_ID} Add the thing (#1)`); assert.equal(show(['status', '--porcelain']), '');
    const text = readFileSync(join(wt, criteriaRel), 'utf8');
    assert.equal(text, '## Acceptance criteria\n\n1. It works. VERIFY: node --test\n'); assert.equal(ev.criteriaDocSha256, sha256(text));
    assert.equal(state.calls.find((c) => c.kind === 'lint').fileHash, ev.criteriaDocSha256, "the spec-lint record's file hash equals the committed document's sha256");
    const rec = fx.ctx.records.load(1);
    assert.equal(rec.localHead, show(['rev-parse', 'HEAD'])); assert.equal(rec.criteriaDocSha256, ev.criteriaDocSha256); assert.equal(rec.ticketId, TICKET_ID);
    assert.equal(criteriaRel, criteriaDocPath(TICKET_ID), 'the path diffcheck accepts');
    assert.deepEqual([...manifestLineHashes(join(wt, '.adlc'))].sort(), [...rec.manifestLinesWritten].sort(), 'every manifest line in the commit was written by this run');
    const lines = readFileSync(join(wt, '.adlc', 'manifest.d', 'test.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines.map(manifestLineSha256).sort(), [...rec.manifestLinesWritten].sort(), 'hashes follow diffcheck.manifestLineSha256');
    assert.equal(rec.ticketSnapshotSha256, canonicalTicketSha256({ ...JSON.parse(readFileSync(state.shard, 'utf8')), completed: true }), 'snapshot ignores `completed` and follows diffcheck.canonicalTicketSha256');
  });
}
test('AC98: the ticket commit carries .adlc/specs/<ULID>-ac.md and the shard, the spec-lint record hash equals the file sha256, and the record knows every manifest line it wrote', ac98_criteriaDocumentIsTracked);
