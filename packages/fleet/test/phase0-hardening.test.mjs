import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { SANDBOX_MODES, NETWORK, READ_POLICY } from '../lib/sandbox.mjs';
import { SafeSandbox, buildSafeSeatbeltProfile } from '../lib/safe-sandbox.mjs';
import { resolveRunConfig, DEFAULTS } from '../lib/config.mjs';
import { inferBuilderFamily, inferProviderFamily } from '../lib/prosecutor-config.mjs';
import { resolveTrustedBin, sanitizeTrustedPath, makeReviewRunner } from '../lib/review-runner.mjs';
import { defaultIo, buildLiveDeps } from '../lib/live-deps.mjs';
import { parseFlags, prosecutorFlags } from '../bin/fleet.mjs';

// ---------------------------------------------------------------------------
// 1. SafeSandbox Seatbelt SBPL escaping (preserving frozen lib/sandbox.mjs)
// ---------------------------------------------------------------------------

test('SafeSandbox escapes quotes and backslashes in Seatbelt subpaths on both BOUNDED and HOST profiles', () => {
  const injectedWorktree = '/wt/quote") (allow default) (subpath "/x';
  const injectedHome = '/wt/back\\slash';

  const bounded = new SafeSandbox({
    mode: SANDBOX_MODES.SANDBOX,
    backend: { name: 'seatbelt' },
    worktree: injectedWorktree,
    syntheticHome: injectedHome,
    readOnlyPaths: ['/usr/local/"bin"'],
    network: NETWORK.DENY,
    readPolicy: READ_POLICY.BOUNDED,
  });
  const argv = bounded.wrap(['npm', 'test']);
  assert.equal(argv[0], 'sandbox-exec');
  assert.equal(argv[1], '-p');
  const profile = argv[2];
  assert.ok(profile.includes('(deny default)'), 'bounded profile starts deny-default');
  assert.ok(profile.includes('(deny network*)'), 'bounded profile denies network');
  assert.ok(!profile.includes('quote") (allow default)'), 'unescaped quote breakout must never appear');
  assert.ok(profile.includes('(subpath "/wt/quote\\") (allow default) (subpath \\"/x")'));
  assert.ok(profile.includes('(subpath "/wt/back\\\\slash")'));
  assert.ok(profile.includes('(subpath "/usr/local/\\"bin\\"")'));

  const hostProfile = buildSafeSeatbeltProfile({
    worktree: '/wt',
    writablePaths: ['/home/op/state" ) (allow file-write* (subpath "/")'],
    network: NETWORK.ALLOW,
    readPolicy: READ_POLICY.HOST,
  });
  assert.ok(hostProfile.includes('(allow network*)'));
  assert.ok(hostProfile.includes('(allow file-write* (subpath "/dev"))'));
  assert.ok(hostProfile.includes('(subpath "/home/op/state\\" ) (allow file-write* (subpath \\"/\\")")'));

  // Empty root lists MUST omit the allow clause rather than emitting unconditional `(allow file-write* )` / `(allow file-read* )`
  const emptyHost = buildSafeSeatbeltProfile({ readPolicy: READ_POLICY.HOST });
  assert.ok(!emptyHost.includes('(allow file-write* )'), `empty writeRoots must not emit bare allow: ${emptyHost}`);
  const emptyBounded = buildSafeSeatbeltProfile({ readPolicy: READ_POLICY.BOUNDED });
  assert.ok(!emptyBounded.includes('(allow file-write* )'), `empty bounded writeRoots must not emit bare allow: ${emptyBounded}`);
  assert.ok(!emptyBounded.includes('(allow file-read* )'), `empty bounded readRoots must not emit bare allow: ${emptyBounded}`);
});

test('SafeSandbox rejects NUL/CR/LF control characters in Seatbelt paths and preserves bubblewrap / env-scrub-only', () => {
  for (const bad of ['/wt/nul\0x', '/wt/lf\nx', '/wt/cr\rx']) {
    const sb = new SafeSandbox({
      mode: SANDBOX_MODES.SANDBOX,
      backend: { name: 'seatbelt' },
      worktree: bad,
    });
    assert.throws(() => sb.wrap(['true']), /Seatbelt path|NUL|newline/i);
  }

  const bwrap = new SafeSandbox({
    mode: SANDBOX_MODES.SANDBOX,
    backend: { name: 'bubblewrap' },
    worktree: '/wt',
    syntheticHome: '/wt/.home',
  });
  assert.equal(bwrap.wrap(['true'])[0], 'bwrap');

  const scrub = new SafeSandbox({
    mode: SANDBOX_MODES.ENV_SCRUB_ONLY,
    worktree: '/wt/quote"',
  });
  assert.deepEqual(scrub.wrap(['npm', 'test']), ['npm', 'test']);

  // Leading-dash, empty, or NUL adapterCommand MUST throw; 1-char command name succeeds
  for (const badArgv of [[], [''], ['-p'], ['--flag', 'echo']]) {
    assert.throws(() => scrub.wrap(badArgv), /SafeSandbox\.wrap/);
  }
  for (const badCmd of ['', '-p', 'cmd\0evil', 42]) {
    assert.throws(() => resolveRunConfig({}, { adapterCommand: badCmd }), /--adapter-command/);
  }
  assert.equal(resolveRunConfig({}, { adapterCommand: 'x' }).adapterCommand, 'x');
});

// ---------------------------------------------------------------------------
// 2. Prosecutor config narrowing, cross-family enforcement, and CLI flags
// ---------------------------------------------------------------------------

test('prosecuteFailOn narrows in repo config (low/medium allowed, high/critical clamped) and honors CLI override', () => {
  assert.equal(resolveRunConfig({}, {}).prosecuteFailOn, 'medium');
  const tight = resolveRunConfig({ prosecuteFailOn: 'low' }, {});
  assert.equal(tight.prosecuteFailOn, 'low');
  assert.deepEqual(tight.warnings, []);

  const eq = resolveRunConfig({ prosecuteFailOn: 'medium' }, {});
  assert.equal(eq.prosecuteFailOn, 'medium');
  assert.deepEqual(eq.warnings, []);

  for (const weak of ['high', 'critical']) {
    const clamped = resolveRunConfig({ prosecuteFailOn: weak }, {});
    assert.equal(clamped.prosecuteFailOn, DEFAULTS.prosecuteFailOn, `repo cannot weaken threshold to ${weak}`);
    assert.ok(clamped.warnings.some((w) => /SECURITY:.*fleet\.prosecuteFailOn.*weaker/.test(w)));
  }

  for (const invalid of ['none', '', 123, false]) {
    const fallback = resolveRunConfig({ prosecuteFailOn: invalid }, {});
    assert.equal(fallback.prosecuteFailOn, DEFAULTS.prosecuteFailOn);
    assert.ok(fallback.warnings.some((w) => /fleet\.prosecuteFailOn/.test(w)));
  }

  // Operator CLI --prosecute-fail-on can set any valid severity, and rejects invalid ones.
  for (const sev of ['low', 'medium', 'high', 'critical']) {
    const p = prosecutorFlags(parseFlags(['--prosecute-fail-on', sev]));
    assert.equal(resolveRunConfig({ prosecuteFailOn: 'low' }, p).prosecuteFailOn, sev);
  }
  assert.throws(() => prosecutorFlags(parseFlags(['--prosecute-fail-on', 'off'])), /--prosecute-fail-on/);
  assert.throws(() => resolveRunConfig({}, { prosecuteFailOn: 'off' }), /--prosecute-fail-on/);
});

test('reviewProvider enforces identifier grammar and blocks repo-configured same-family self-review', async () => {
  // Valid cross-family repo config (default adapter claude-code = anthropic, reviewer codex = openai)
  const cross = resolveRunConfig({ reviewProvider: 'codex' }, {});
  assert.equal(cross.reviewProvider, 'codex');
  assert.deepEqual(cross.warnings, []);

  // Repo-configured same-family self-review is warned and ignored across Anthropic, OpenAI, and Google
  for (const [cfg, flg, expectedFamily] of [
    [{ reviewProvider: 'claude' }, {}, 'anthropic'],
    [{ reviewProvider: 'anthropic' }, { adapter: 'opencode', model: 'claude-sonnet-4-6' }, 'anthropic'],
    [{ reviewProvider: 'codex' }, { adapter: 'codex' }, 'openai'],
    [{ reviewProvider: 'openai' }, { adapter: 'opencode', model: 'gpt-5' }, 'openai'],
    [{ reviewProvider: 'gemini' }, { adapter: 'gemini' }, 'google'],
    [{ reviewProvider: 'google' }, { adapter: 'agy', model: 'gemini-2.5-pro' }, 'google'],
  ]) {
    const r = resolveRunConfig(cfg, flg);
    assert.equal(r.reviewProvider, null, `same-family ${expectedFamily} repo config must be ignored`);
    assert.ok(r.warnings.some((w) => w.includes('same-family self-review') && w.includes(expectedFamily)));
  }

  // Operator CLI --review-provider explicitly overrides even when same-family
  const explicit = resolveRunConfig({}, { adapter: 'codex', reviewProvider: 'codex' });
  assert.equal(explicit.reviewProvider, 'codex');

  // Flag injection or malformed provider rejected in config, CLI flags, AND makeReviewRunner directly
  for (const bad of ['--allow-summary-review', '-p', 'codex;evil', '', 42]) {
    const r = resolveRunConfig({ reviewProvider: bad }, {});
    assert.equal(r.reviewProvider, null);
    assert.ok(r.warnings.some((w) => /SECURITY:.*fleet\.reviewProvider/.test(w)));
  }
  assert.throws(() => prosecutorFlags(parseFlags(['--review-provider', '--allow-summary-review'])), /--review-provider/);
  assert.throws(() => resolveRunConfig({}, { reviewProvider: '--bad' }), /--review-provider/);

  let spawned = false;
  const runner = makeReviewRunner({
    provider: '--allow-summary-review',
    resolveBin: () => process.execPath,
    spawn: async () => { spawned = true; return { status: 0, stdout: '{"findings":[]}' }; },
  });
  const res = await runner({ worktree: '/wt', startSha: 'SHA' });
  assert.equal(res.ok, false);
  assert.equal(spawned, false, 'invalid provider fails closed before spawning');

  assert.equal(inferProviderFamily('claude-code'), 'anthropic');
  assert.equal(inferProviderFamily('codex'), 'openai');
  assert.equal(inferProviderFamily('o3-mini'), 'openai');
  assert.equal(inferProviderFamily('o4-mini'), 'openai');
  assert.equal(inferProviderFamily('agy'), 'google');
  assert.equal(inferProviderFamily('custom-local'), null);
  assert.equal(inferBuilderFamily({ adapter: 'opencode', model: 'o3-mini' }), 'openai');
  assert.equal(inferBuilderFamily({ adapter: 'opencode', model: 'openrouter/anthropic/claude-3.7-sonnet' }), 'anthropic');
  assert.equal(inferBuilderFamily({ adapter: 'opencode', model: 'custom-slug', provider: 'openai' }), 'openai');
  assert.equal(inferBuilderFamily({ adapter: 'opencode' }), null);

  // Unresolved builder family (e.g. opencode/cursor without --model) MUST fail closed on repo reviewProvider
  const unresolvedBuilder = resolveRunConfig({ reviewProvider: 'codex' }, { adapter: 'opencode' });
  assert.equal(unresolvedBuilder.reviewProvider, null);
  assert.ok(unresolvedBuilder.warnings.some((w) => w.includes('unresolved model family')));

  // Repo config cannot select opaque router/unclassified provider names (e.g. opencode/cursor),
  // whereas operator CLI --review-provider still allows any grammar-valid provider token.
  const opaqueRepo = resolveRunConfig({ reviewProvider: 'opencode' }, {});
  assert.equal(opaqueRepo.reviewProvider, null);
  assert.equal(opaqueRepo.reviewProviderSource, null);
  assert.ok(opaqueRepo.warnings.some((w) => w.includes('canonical model family')));
  const opaqueCli = resolveRunConfig({}, { reviewProvider: 'opencode' });
  assert.equal(opaqueCli.reviewProvider, 'opencode');
  assert.equal(opaqueCli.reviewProviderSource, 'cli');
});

test('buildLiveDeps neutralizes repo-configured reviewProvider when Quartermaster routes or escalates onto the same family', async () => {
  const capturedReviewArgv = [];
  const fakeIo = {
    git: () => () => 'deadbeef',
    adlc: () => ({ status: 0, stdout: '' }),
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (_cmd, args) => {
      capturedReviewArgv.push(args);
      return { status: 0, stdout: JSON.stringify({ verdict: 'approve', provider: 'claude', findings: [] }), stderr: '' };
    },
    readFile: () => '', exists: () => false, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {},
    ensureGitignore: () => {}, env: { PATH: '/usr/bin', HOME: '/h' }, hasGh: () => false, copyTree: () => {},
  };
  const cfg = resolveRunConfig({ reviewProvider: 'codex' }, {});
  assert.equal(cfg.reviewProvider, 'codex');
  assert.equal(cfg.reviewProviderSource, 'config');

  // Quartermaster routed T-OPENAI onto a codex seat, and T-GATEWAY onto an opencode seat whose family comes from seat.provider
  const seats = new Map([
    ['T-OPENAI', {
      seat: { adapter: 'codex', model: 'gpt-5', provider: 'openai', transport: 'subscription:codex' },
      channel: 'openai-sub',
    }],
    ['T-GATEWAY', {
      seat: { adapter: 'opencode', model: 'gateway-custom-model', provider: 'openai', transport: 'api:OPENAI_API_KEY' },
      channel: 'openai-gateway',
    }],
    ['T-UNKNOWN', {
      seat: { adapter: 'opencode', model: 'local-mystery', provider: 'router', transport: 'api:ROUTER_KEY' },
      channel: 'opaque-router',
    }],
  ]);
  const deps = buildLiveDeps({
    repo: '/repo',
    statusDir: undefined,
    sandboxSpec: { mode: 'i-am-in-a-disposable-container', backend: null },
    seats,
    io: fakeIo,
    config: { ...cfg, reviewBin: process.execPath },
  });
  for (const id of ['T-OPENAI', 'T-GATEWAY', 'T-UNKNOWN']) {
    capturedReviewArgv.length = 0;
    const res = await deps.prosecute({ ticket: { id, scope: ['src/**'] }, worktree: `/wt/${id}`, startSha: 'BASE' });
    assert.equal(res.verdict, 'pass');
    assert.equal(capturedReviewArgv.length, 1);
    assert.ok(!capturedReviewArgv[0].includes('--provider'), `repo provider must be stripped for ${id}: ${capturedReviewArgv[0]}`);
  }

  // Quartermaster run WITHOUT --adapter when repo sets "reviewProvider": "claude":
  // cross-family OpenAI seat keeps --provider claude, while same-family Anthropic seat strips it!
  const claudeRepoCfg = resolveRunConfig({ reviewProvider: 'claude' }, {});
  assert.equal(claudeRepoCfg.reviewProvider, null, 'non-Quartermaster default adapter still strips claude');
  assert.equal(claudeRepoCfg.repoReviewProvider, 'claude', 'preserved for Quartermaster seat-aware resolution');
  const qmSeats = new Map([
    ['T-ON-CODEX', { seat: { adapter: 'codex', model: 'gpt-5', provider: 'openai', transport: 'subscription:codex' }, channel: 'openai-sub' }],
    ['T-ON-CLAUDE', { seat: { adapter: 'claude-code', model: 'sonnet', provider: 'anthropic', transport: 'subscription:claude' }, channel: 'anthropic-sub' }],
  ]);
  const qmDeps = buildLiveDeps({
    repo: '/repo',
    statusDir: undefined,
    sandboxSpec: { mode: 'i-am-in-a-disposable-container', backend: null },
    seats: qmSeats,
    io: fakeIo,
    config: { ...claudeRepoCfg, reviewBin: process.execPath },
  });
  capturedReviewArgv.length = 0;
  await qmDeps.prosecute({ ticket: { id: 'T-ON-CODEX', scope: ['src/**'] }, worktree: '/wt/codex', startSha: 'BASE' });
  assert.ok(capturedReviewArgv[0].includes('--provider') && capturedReviewArgv[0].includes('claude'), 'OpenAI Quartermaster seat keeps cross-family claude prosecutor');
  capturedReviewArgv.length = 0;
  await qmDeps.prosecute({ ticket: { id: 'T-ON-CLAUDE', scope: ['src/**'] }, worktree: '/wt/claude', startSha: 'BASE' });
  assert.ok(!capturedReviewArgv[0].includes('--provider'), 'Anthropic Quartermaster seat strips same-family claude prosecutor');

  // Multi-strike escalation: Strike 1 (codex/openai) -> Strike 2 (claude-code/anthropic)
  // MUST still strip repo "reviewProvider": "codex" because Strike 1's commits remain on the branch!
  const escSeats = new Map([
    ['T-ESCALATED', {
      seat: { adapter: 'codex', model: 'gpt-5', provider: 'openai', transport: 'subscription:codex' },
      channel: 'openai-sub',
      escalateTo: { seat: { adapter: 'claude-code', model: 'opus', provider: 'anthropic', transport: 'subscription:claude' }, channel: 'anthropic-sub' },
    }],
  ]);
  const escDeps = buildLiveDeps({
    repo: '/repo',
    statusDir: undefined,
    sandboxSpec: { mode: 'i-am-in-a-disposable-container', backend: null },
    seats: escSeats,
    io: fakeIo,
    config: { ...cfg, gate: { test: 'npm test' }, reviewBin: process.execPath },
  });
  await escDeps.dispatch({ ticket: { id: 'T-ESCALATED', scope: ['src/**'], body: 'spec', acceptanceCriteria: ['ac'] }, worktree: '/wt/esc', strike: 1 });
  await escDeps.dispatch({ ticket: { id: 'T-ESCALATED', scope: ['src/**'], body: 'spec', acceptanceCriteria: ['ac'] }, worktree: '/wt/esc', strike: 2, deadEnds: ['strike 1 failed'] });
  capturedReviewArgv.length = 0;
  await escDeps.prosecute({ ticket: { id: 'T-ESCALATED', scope: ['src/**'] }, worktree: '/wt/esc', startSha: 'BASE' });
  assert.ok(!capturedReviewArgv[0].includes('--provider'), 'multi-strike branch with Strike 1 openai commits must strip repo codex reviewer');

  // Resumed run starting directly at strike 2 (no in-process strike 1 dispatch) ALSO backfills strike 1 from Quartermaster seat
  const resumedDeps = buildLiveDeps({
    repo: '/repo',
    statusDir: undefined,
    sandboxSpec: { mode: 'i-am-in-a-disposable-container', backend: null },
    seats: escSeats,
    io: fakeIo,
    config: { ...cfg, gate: { test: 'npm test' }, reviewBin: process.execPath },
  });
  await resumedDeps.dispatch({ ticket: { id: 'T-ESCALATED', scope: ['src/**'], body: 'spec', acceptanceCriteria: ['ac'] }, worktree: '/wt/esc', strike: 2, deadEnds: ['resumed after strike 1'] });
  capturedReviewArgv.length = 0;
  await resumedDeps.prosecute({ ticket: { id: 'T-ESCALATED', scope: ['src/**'] }, worktree: '/wt/esc', startSha: 'BASE' });
  assert.ok(!capturedReviewArgv[0].includes('--provider'), 'resumed strike-2 run backfills strike-1 openai builder and strips repo codex reviewer');
});

test('prosecutorFlags validates --adlc-bin and --review-bin and rejects empty or NUL strings', () => {
  const ok = prosecutorFlags(parseFlags(['--adlc-bin', '/usr/local/bin/adlc', '--review-bin', '/usr/local/bin/adversarial-review']));
  assert.equal(ok.adlcBin, '/usr/local/bin/adlc');
  assert.equal(ok.reviewBin, '/usr/local/bin/adversarial-review');
  assert.throws(() => prosecutorFlags(parseFlags(['--adlc-bin', ''])), /--adlc-bin/);
  assert.throws(() => prosecutorFlags(parseFlags(['--review-bin', ''])), /--review-bin/);
  assert.throws(() => prosecutorFlags({ 'adlc-bin': '/bin/adlc\0evil' }), /--adlc-bin/);
});

// ---------------------------------------------------------------------------
// 3. resolveTrustedBin and defaultIo().adlc / adlcAsync boundary hardening
// ---------------------------------------------------------------------------

test('resolveTrustedBin rejects directories, relative paths with slashes, worktree-interior absolute paths, symlinks into worktree, and trailing slashes', (t) => {
  const root = tmp(t, 'fleet-trusted-bin-');
  const wt = join(root, 'wt');
  const outsideBinDir = join(root, 'bin');
  mkdirSync(wt, { recursive: true });
  mkdirSync(outsideBinDir, { recursive: true });

  const planted = join(wt, 'planted-bin');
  writeFileSync(planted, '#!/bin/sh\nexit 0\n');
  chmodSync(planted, 0o755);

  const trusted = join(outsideBinDir, 'trusted-bin');
  writeFileSync(trusted, '#!/bin/sh\nexit 0\n');
  chmodSync(trusted, 0o755);

  const symIntoWt = join(outsideBinDir, 'link-to-wt');
  symlinkSync(planted, symIntoWt);

  // Absolute path inside worktree MUST be rejected even though it exists and is a file
  assert.equal(resolveTrustedBin(planted, outsideBinDir, wt), null);
  assert.equal(resolveTrustedBin(planted, outsideBinDir, `${wt}/`), null, 'trailing slash on worktree still excludes it');

  // Symlink in a trusted dir whose realpath lands inside the worktree MUST be rejected
  assert.equal(resolveTrustedBin(symIntoWt, outsideBinDir, wt), null);
  assert.equal(resolveTrustedBin('link-to-wt', outsideBinDir, wt), null);

  // Directories, empty strings, NUL, and relative paths with slashes MUST be rejected
  assert.equal(resolveTrustedBin(outsideBinDir, outsideBinDir, wt), null, 'directory rejected');
  assert.equal(resolveTrustedBin('', outsideBinDir, wt), null, 'empty string must not join to directory');
  assert.equal(resolveTrustedBin('./trusted-bin', outsideBinDir, wt), null, 'relative path with slash rejected');
  assert.equal(resolveTrustedBin('sub/trusted-bin', outsideBinDir, wt), null);
  assert.equal(resolveTrustedBin(`${trusted}\0x`, outsideBinDir, wt), null);

  // Non-executable (0644) file earlier on PATH must NOT shadow an executable later on PATH
  const shadowDir = join(root, 'shadow-bin');
  mkdirSync(shadowDir, { recursive: true });
  const nonExecShadow = join(shadowDir, 'trusted-bin');
  writeFileSync(nonExecShadow, 'not executable\n');
  chmodSync(nonExecShadow, 0o644);
  if (process.platform !== 'win32') {
    assert.equal(resolveTrustedBin(nonExecShadow, '', wt), null, '0644 file rejected');
    assert.equal(resolveTrustedBin('trusted-bin', `${shadowDir}:${outsideBinDir}`, wt), trusted, '0644 file skipped in favor of 0755 binary');
  }

  // Genuine regular executable file outside worktree succeeds (both absolute and via trusted PATH)
  assert.equal(resolveTrustedBin(trusted, '', wt), trusted);
  assert.equal(resolveTrustedBin('trusted-bin', `${wt}:${outsideBinDir}:.`, wt), trusted);

  // node_modules/.bin and leading-dash binaries MUST be rejected even when worktree is undefined
  const nmBinDir = join(root, 'node_modules', '.bin');
  mkdirSync(nmBinDir, { recursive: true });
  const nmPlanted = join(nmBinDir, 'trusted-bin');
  writeFileSync(nmPlanted, '#!/bin/sh\nexit 0\n');
  chmodSync(nmPlanted, 0o755);
  assert.equal(resolveTrustedBin('trusted-bin', `${nmBinDir}:${outsideBinDir}`, undefined), trusted, 'node_modules/.bin skipped even without worktree');
  assert.equal(resolveTrustedBin(nmPlanted, outsideBinDir, undefined), null, 'absolute path inside node_modules rejected');
  assert.equal(resolveTrustedBin('-flag', outsideBinDir, undefined), null, 'leading-dash binary rejected');

  // sanitizeTrustedPath strips relative dirs, node_modules, and worktree even when worktree has trailing slash or cwd is omitted
  assert.equal(sanitizeTrustedPath(`.:${wt}:${nmBinDir}:${wt}/node_modules/.bin:${outsideBinDir}`, `${wt}/`), outsideBinDir);
  assert.equal(sanitizeTrustedPath(`.:rel/bin:${nmBinDir}:${outsideBinDir}`, undefined), outsideBinDir);
});

test('defaultIo().adlc and defaultIo().adlcAsync fail closed on untrusted/relative/worktree binaries and honor configured adlcBin across live-deps', async (t) => {
  const root = tmp(t, 'fleet-io-adlc-');
  const wt = join(root, 'wt');
  mkdirSync(wt, { recursive: true });
  const planted = join(wt, 'adlc');
  writeFileSync(planted, '#!/bin/sh\necho PWNED\n');
  chmodSync(planted, 0o755);

  const io = defaultIo();
  io.env = { PATH: `.:${wt}` };

  // Sync adlc refuses relative path and worktree-planted binary
  const syncRel = io.adlc(['--version'], { bin: './adlc', cwd: wt });
  assert.equal(syncRel.status, null);
  assert.ok(syncRel.error instanceof Error);

  const syncPlanted = io.adlc(['--version'], { bin: planted, cwd: wt });
  assert.equal(syncPlanted.status, null);
  assert.ok(syncPlanted.error instanceof Error);

  // Async adlcAsync likewise refuses worktree-planted binary and PATH shadowing
  const asyncShadow = await io.adlcAsync(['rails-guard'], { cwd: wt });
  assert.equal(asyncShadow.status, null);
  assert.ok(asyncShadow.error instanceof Error);

  // buildLiveDeps forwards config.adlcBin to railsGuard, recordGate, and recordDispatchUsage
  const seenBins = [];
  const fakeIo = {
    git: () => () => '',
    adlc: (_args, opts) => { seenBins.push(`sync:${opts?.bin}`); return { status: 0, stdout: '' }; },
    adlcAsync: async (_args, opts) => { seenBins.push(`async:${opts?.bin}`); return { status: 0, stdout: '' }; },
    spawnWorker: async () => ({ status: 0, stdout: '', stderr: '' }),
    readFile: () => '', exists: () => false, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {},
    ensureGitignore: () => {}, env: { PATH: '/usr/bin', HOME: '/h' }, hasGh: () => false, copyTree: () => {},
  };
  const deps = buildLiveDeps({
    repo: '/repo',
    statusDir: undefined,
    sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    io: fakeIo,
    config: { gate: {}, adlcBin: '/opt/pinned/adlc' },
  });
  await deps.gate({ ticket: { id: 'T1', scope: ['src/**'] }, worktree: '/wt/T1', startSha: 'SHA' });
  deps.recordGate({ ticket: { id: 'T1' }, phase: 'p4', ok: true });
  deps.recordDispatchUsage({ ticket: { id: 'T1' }, result: { usageStatus: 'reported', usage: { inputTokens: 1, outputTokens: 2 } } });
  assert.deepEqual(seenBins, ['async:/opt/pinned/adlc', 'sync:/opt/pinned/adlc', 'sync:/opt/pinned/adlc']);

  // flailExec with repo cwd rejects a repo-interior PATH shadow (<wt>/adlc)
  const { flailExec } = await import('../lib/live-deps.mjs');
  assert.throws(() => flailExec(io, null, wt)('adlc', ['flail-detector']), /no trusted adlc binary/);

  // runPreflight forwards cwd: repo, bin: config.adlcBin, timeout: remainingMs(), and exact ['merge-forecast', '--json'] argv
  const { runPreflight } = await import('../lib/preflight.mjs');
  const seenPreflightCalls = [];
  const preflightRes = await runPreflight({
    repo: wt,
    config: { operatorOverride: true, gate: { test: 'npm test' }, adlcBin: '/opt/pinned/adlc' },
    statusDir: root,
    remainingMs: () => 4321,
    io: {
      git: () => () => '',
      adlc: (args, opts) => {
        seenPreflightCalls.push({ args, opts });
        const stdout = args[0] === 'merge-forecast' && args[1] === '--json' ? '{"pairs":["T1-T2"]}' : 'human output';
        return { status: 0, stdout };
      },
    },
    self: { pid: 99, host: 'h', runId: 'r', startedAt: 't', procStartTime: 'p' },
    probes: { host: 'h', pidAlive: () => false, procStartTimeOf: () => null },
    railHookInstalled: () => true,
    platform: 'linux',
    hasCmd: () => false,
  });
  assert.equal(seenPreflightCalls.length, 1);
  assert.deepEqual(seenPreflightCalls[0].args, ['merge-forecast', '--json']);
  assert.equal(seenPreflightCalls[0].opts?.cwd, wt);
  assert.equal(seenPreflightCalls[0].opts?.bin, '/opt/pinned/adlc');
  assert.equal(seenPreflightCalls[0].opts?.timeout, 4321);
  assert.deepEqual(preflightRes.forecast, { pairs: ['T1-T2'] });

  // runPreflight fails closed (and releases the lock) when no trusted adlc binary resolves, naming --adlc-bin
  const { releaseLock } = await import('../lib/lock.mjs');
  releaseLock(root);
  const missingAdlcPreflight = await runPreflight({
    repo: wt,
    config: { operatorOverride: true, gate: { test: 'npm test' } },
    statusDir: root,
    io: {
      git: () => () => '',
      adlc: () => ({ status: null, stdout: '', stderr: '', error: new Error('no trusted adlc binary resolved for "adlc"') }),
    },
    self: { pid: 100, host: 'h', runId: 'r2', startedAt: 't', procStartTime: 'p' },
    probes: { host: 'h', pidAlive: () => false, procStartTimeOf: () => null },
    railHookInstalled: () => true,
    platform: 'linux',
    hasCmd: () => false,
  });
  assert.equal(missingAdlcPreflight.ok, false);
  assert.equal(missingAdlcPreflight.exitCode, 1);
  assert.equal(missingAdlcPreflight.lockHeld, false);
  assert.match(missingAdlcPreflight.reason, /--adlc-bin/);
  assert.match(missingAdlcPreflight.reason, /outside the repo and node_modules/);
  const readmeText = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readmeText, /repo-local installs inside `<repo>` or `node_modules\/\.bin` are intentionally rejected/);

  // recordGate logs a warning rather than silently swallowing an unresolved adlc error
  const loggedWarnings = [];
  const origConsoleError = console.error;
  const warnDeps = buildLiveDeps({
    repo: '/repo',
    statusDir: root,
    sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    io: {
      ...fakeIo,
      adlc: () => ({ status: null, stdout: '', stderr: '', error: new Error('no trusted adlc binary resolved for "adlc"') }),
    },
    config: { gate: {} },
  });
  console.error = (...args) => loggedWarnings.push(args.join(' '));
  try {
    warnDeps.recordGate({ ticket: { id: 'T1' }, phase: 'p4', ok: true });
  } finally {
    console.error = origConsoleError;
  }
  assert.ok(loggedWarnings.some((l) => l.includes('no trusted adlc binary resolved')));

  // CLI bin/fleet.mjs run refuses invalid --prosecute-fail-on and invalid --adapter-command cleanly with exit 1
  const { spawnSync } = await import('node:child_process');
  const fleetBin = new URL('../bin/fleet.mjs', import.meta.url).pathname;
  for (const badCli of [
    ['run', '--prosecute-fail-on', 'invalid', '--json'],
    ['run', '--adapter-command', '-p', '--json'],
  ]) {
    const cliRes = spawnSync(process.execPath, [fleetBin, ...badCli], { cwd: wt, encoding: 'utf8' });
    assert.equal(cliRes.status, 1);
    assert.equal(JSON.parse(cliRes.stdout).exitCode, 1);
    assert.match(cliRes.stderr, /^fleet:/);
  }
});
