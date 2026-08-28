// Fixture builder for the preflight / git-runner / ssh suites: a REAL
// temporary git repository (so `git show <oid>:…` reads are real), a fake
// `gh` / `adlc` / network-git handler table on the shared spawn wrapper, real
// `ssh-keygen` when present (fake otherwise), and a ctx shaped like the one
// preflight builds. Everything lives under one mkdtemp; call `fx.cleanup()`.

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpawner } from '../../lib/spawn.mjs';
import { autopilotPaths, EXCLUDE_ENTRIES } from '../../lib/paths.mjs';
import { writeNetGit, sha256 } from '../../lib/git-env.mjs';
import { createRedactor } from '../../lib/redact.mjs';
import { fakeSpawnImpl } from './fake-children.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const TEST_SPEC_PATH = 'docs/specs/issue-autopilot-local.md';
export const BUILD_TICKET = 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH';

function onPath(name) {
  for (const d of String(process.env.PATH ?? '').split(delimiter)) { const p = join(d, name); if (d && existsSync(p)) return p; }
  return null;
}
export const REAL = { git: onPath('git'), ssh: onPath('ssh'), sshKeygen: onPath('ssh-keygen'), sshAdd: onPath('ssh-add'), sshAgent: onPath('ssh-agent') };

/** Pinned executables: real git / ssh tools (fixtures need them), fake paths for everything else. */
export const PINNED = Object.freeze({
  adlc: '/opt/pinned/adlc', gh: '/opt/pinned/gh', claude: '/opt/pinned/claude', codex: '/opt/pinned/codex', 'adversarial-review': '/opt/pinned/adversarial-review',
  npm: '/opt/pinned/npm', node: '/opt/pinned/node', bwrap: '/opt/pinned/bwrap',
  git: REAL.git ?? '/opt/pinned/git', ssh: REAL.ssh ?? '/opt/pinned/ssh', 'ssh-add': REAL.sshAdd ?? '/opt/pinned/ssh-add', 'ssh-keygen': REAL.sshKeygen ?? '/opt/pinned/ssh-keygen',
  specLintBin: '/opt/pinned/spec-lint.mjs',
});

export const GIT_ENV = { PATH: process.env.PATH, HOME: tmpdir(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
export function git(cwd, args, opts = {}) {
  const r = spawnSync(REAL.git, ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A handler that runs the real executable synchronously (keeps the recorder in the loop). */
export const realExec = (exe) => (args, { cwd, env, stdin }) => {
  const r = spawnSync(exe, args, { cwd, env, input: stdin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : ''), status: r.status ?? 1 };
};

/** The §13 example config block from the committed spec, with `autopilot.repo` patched. */
export function exampleConfig(repo) {
  const spec = readFileSync(join(REPO, TEST_SPEC_PATH), 'utf8');
  const start = spec.indexOf('Repo-committed (`.adlc/config.json`, trust root):');
  const fence = spec.indexOf('```json', start);
  const end = spec.indexOf('```', fence + 7);
  const doc = JSON.parse(spec.slice(fence + 7, end));
  return { ...doc, autopilot: { ...doc.autopilot, repo } };
}

export const FIXTURE_SPEC = [
  '# Fixture spec', '', '## 11. Threat model', '', 'Prose that does not bind.', '', '### 11.1 Accepted residuals (canonical, hashed)', '',
  'This numbered list is the ONLY input of the binding.', '',
  '1. The model API host is the one permitted model-plane egress', '   destination; content can leave inside model requests (§6.4).',
  '2. The worker holds the harness OAuth token in its synthetic home', '   because the CLI has no external auth broker.', '',
  '3. The quota gate makes overshoot visible; it never prevents a single', '   step\'s overshoot (§3.4).', '', '## 12. Failure policy', '', '1. not an item of 11.1', '',
].join('\n') + '\n';

export function approvalRecord({ ticket = BUILD_TICKET, specHash, items, seq = 3, ts = '2026-08-27T17:58:38.616Z', approver = 'octo', overrides = {} }) {
  const assumptionsHash = sha256(JSON.stringify(items));
  return {
    seq, gate: 'spec-approval', ts, ticket,
    data: { approver, spec_hash: specHash, verdict: 'approved', date: '2026-08-26', phase: 'P1 G1', rounds: 81, questions: 11, sources: ['grill-me interview'], unresolved: 0, approved_assumptions: items, assumptions_hash: assumptionsHash, ...overrides },
    files: { [TEST_SPEC_PATH]: specHash },
  };
}

/**
 * Build the fixture. Returns fx with repoRoot, home, baseOid, keyPath, pubLine, netGitSha, paths, cleanup().
 * @param opts.pluginVersion  version committed in plugin.json (installed defaults to the same)
 * @param opts.manifest       array of manifest entries for the spec segment (default: lint+premortem+approval)
 */
export function makeFixture({ repo = 'o/r', originUrl = 'git@github.com:o/r.git', pluginVersion = '1.11.0', installedVersion = pluginVersion, installedShape = 'object', specText = FIXTURE_SPEC, manifest = null, manifestLayout = 'segment', config = null, credentialsExpiresInMs = 8 * 3_600_000, now = Date.now() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ap-preflight-'));
  const repoRoot = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repoRoot, { mode: 0o755 }); chmodSync(repoRoot, 0o755); // §9.3: the key file's parent must not be group/world-writable (umask-proof)
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  git(repoRoot, ['init', '-q', '-b', 'main']);
  const write = (rel, text) => { const p = join(repoRoot, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
  write('plugins/adlc-claude-code/.claude-plugin/plugin.json', JSON.stringify({ name: 'adlc', version: pluginVersion }, null, 2) + '\n');
  write('.adlc/config.json', JSON.stringify(config ?? exampleConfig(repo), null, 2) + '\n');
  write('packages/ticket-sync/schemas/adlc-config.schema.json', readFileSync(join(REPO, 'packages', 'ticket-sync', 'schemas', 'adlc-config.schema.json'), 'utf8'));
  write(TEST_SPEC_PATH, specText);
  const specHash = sha256(specText);
  const items = residualsOf(specText);
  const entries = manifest ?? [
    { seq: 1, gate: 'spec-lint', ts: '2026-08-27T17:00:00.000Z', ticket: BUILD_TICKET, files: { [TEST_SPEC_PATH]: specHash }, data: { verified: true } },
    { seq: 2, gate: 'premortem', ts: '2026-08-27T17:10:00.000Z', ticket: BUILD_TICKET, files: { [TEST_SPEC_PATH]: specHash }, data: {} },
    approvalRecord({ specHash, items }),
  ];
  // `segment`: a manifest.d segment (what this repository uses); `root`: the flat manifest.jsonl (readable by
  // the real `adlc run p1` from a DETACHED checkout, which refuses committed segments without a branch identity).
  write(manifestLayout === 'root' ? '.adlc/manifest.jsonl' : '.adlc/manifest.d/spec-fixture-01M0Z3K7XHDGH94J0E7WT2RSQA.jsonl', entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'baseline']);
  const baseOid = git(repoRoot, ['rev-parse', 'HEAD']);
  git(repoRoot, ['remote', 'add', 'origin', originUrl]);
  const envLocal = join(repoRoot, '.env.local');
  writeFileSync(envLocal, 'ADLC_MANIFEST_KEY=0123456789abcdef0123456789abcdef\n', { mode: 0o600 }); chmodSync(envLocal, 0o600);
  writeFileSync(join(repoRoot, '.git', 'info', 'exclude'), EXCLUDE_ENTRIES.join('\n') + '\n');
  const paths = autopilotPaths(repoRoot);
  mkdirSync(paths.runsDir, { recursive: true });
  writeFileSync(paths.knownHosts, 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n', { mode: 0o600 }); chmodSync(paths.knownHosts, 0o600);
  const { configSha256 } = writeNetGit({ netGit: paths.netGit, repoRoot, remoteFetchUrl: originUrl, remotePushUrl: originUrl, sshWrapperPath: '/placeholder/wrapper' });
  // Host files.
  const plugins = installedShape === 'array' ? [{ name: 'adlc@adlc', version: installedVersion }] : { 'adlc@adlc': [{ scope: 'user', version: installedVersion }, { scope: 'project', version: installedVersion }] };
  if (installedVersion !== null) writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { expiresAt: now + credentialsExpiresInMs } }));
  // An SSH key pair (real when ssh-keygen exists; otherwise a fixed public line and a fake private file).
  const keyPath = join(root, 'id_ed25519');
  let pubLine;
  if (REAL.sshKeygen) { spawnSync(REAL.sshKeygen, ['-t', 'ed25519', '-N', '', '-q', '-C', 'operator@laptop', '-f', keyPath]); pubLine = readFileSync(`${keyPath}.pub`, 'utf8').trim(); }
  else { writeFileSync(keyPath, 'fake private key\n'); pubLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILCIZMUVuVYs6hh1OOH/Mhz1TCJNs2O32J5Hl0Qt1JaP operator@laptop'; writeFileSync(`${keyPath}.pub`, pubLine + '\n'); }
  chmodSync(keyPath, 0o600);
  return { root, repoRoot, home, paths, baseOid, specHash, items, keyPath, pubLine, netGitSha: configSha256, repo, originUrl, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The §11.1 extractor restated for fixture construction (the production one is under test). */
export function residualsOf(specText) {
  const lines = specText.split('\n'); const i = lines.findIndex((l) => /^### 11\.1/.test(l)); const out = []; let cur = null;
  for (let k = i + 1; k < lines.length; k++) { const l = lines[k]; if (/^##(#)?\s/.test(l)) break; const m = /^(\d+)\.\s+(.*)$/.exec(l); if (m) { if (cur !== null) out.push(cur); cur = m[2]; continue; } if (!l.trim()) { if (cur !== null) out.push(cur); cur = null; continue; } if (cur !== null) cur += ' ' + l; }
  if (cur !== null) out.push(cur);
  return out.map((s) => s.replace(/\s+/g, ' ').trim());
}

/** Default gh answers for a healthy repository; `override(args)` may return a response first. */
export function ghHandler(fx, { host = 'github.com', login = 'octo', permission = 'admin', override = () => undefined, labels = null, keys = null, pulls = null } = {}) {
  const LABELS = ['adlc:autopilot', 'adlc:autopilot-skip', 'adlc:needs-clarification', 'adlc:autopilot-blocked', 'adlc:autopilot-stale', 'adlc:autopilot-ci-red', 'adlc:needs-human', 'adlc:autopilot-log'];
  return (args) => {
    const o = override(args); if (o !== undefined) return o;
    const a = args.join(' ');
    const json = (v, status = 0) => ({ stdout: JSON.stringify(v), status });
    if (args[0] === 'auth' && args[1] === 'status') return json({ hosts: { [host]: [{ state: 'success', active: true, host, login }] } });
    if (a.startsWith('api user/keys')) return json(keys ?? [{ id: 1, key: fx.pubLine }]);
    if (a.startsWith('api user ')) return json({ login, email: null });
    if (a.startsWith('api users/')) return json({ login, email: 'octo@example.com' });
    if (/^api repos\/[^/]+\/[^/]+\/collaborators\//.test(a)) return json({ permission });
    if (args[0] === 'repo' && args[1] === 'view') return json({ nameWithOwner: fx.repo, defaultBranchRef: { name: 'main' } });
    if (/^api repos\/[^/]+\/[^/]+\/labels/.test(a)) return json((labels ?? LABELS).map((name) => ({ name })));
    if (/^api repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]{40}\/pulls/.test(a)) return json(pulls ?? [{ number: 7, merged_at: '2026-08-27T18:00:00Z', merged_by: { login } }]);
    return { stdout: '', stderr: `unhandled gh ${a}`, status: 1 };
  };
}

/** Network git (`--git-dir=<NET_GIT> ls-remote|fetch|push`) is faked; everything else is the real git. */
export function gitHandler(fx, { net = null } = {}) {
  const real = realExec(REAL.git);
  return (args, o) => {
    if (args[0]?.startsWith('--git-dir=') && ['ls-remote', 'fetch', 'push'].includes(args[1])) {
      if (net) { const r = net(args.slice(1), o); if (r !== undefined) return r; }
      if (args[1] === 'ls-remote') return { stdout: `${fx.baseOid}\trefs/heads/main\n`, status: 0 };
      return { stdout: '', status: 0 };
    }
    return real(args, o);
  };
}

export function adlcHandler(fx, { override = () => undefined } = {}) {
  return (args, o) => {
    const r = override(args, o); if (r !== undefined) return r;
    if (args[0] === 'run' && args[1] === 'p1') return { stdout: JSON.stringify({ ok: true }), status: 0 };
    if (args[0] === 'fleet') { const i = args.indexOf('--base'); return { stdout: JSON.stringify({ baseSha: args[i + 1] }), status: 0 }; }
    return { stdout: '', stderr: `unhandled adlc ${args.join(' ')}`, status: 1 };
  };
}

/** A ctx like the one the orchestrator hands to phaseA. */
export function buildCtx(fx, { handlers = {}, gh = {}, net = null, adlc = {}, local = {}, inherited = {}, dryRun = false, uid = process.getuid(), fs = null, toolchain = null, pinned = PINNED, now = Date.now, iterationToken = randomBytes(32).toString('hex') } = {}) {
  const recorder = [];
  const table = {
    [pinned.git]: gitHandler(fx, { net }),
    [pinned.gh]: ghHandler(fx, gh),
    [pinned.adlc]: adlcHandler(fx, adlc),
    [pinned['ssh-keygen']]: REAL.sshKeygen ? realExec(REAL.sshKeygen) : fakeKeygen(fx),
    [pinned['ssh-add']]: () => ({ stdout: `${fx.pubLine}\n`, status: 0 }),
    ...handlers,
  };
  const { spawnImpl } = fakeSpawnImpl(table);
  const spawn = createSpawner({ recorder, spawnImpl });
  const base = { PATH: '/usr/bin', HOME: fx.home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
  return {
    repoRoot: fx.repoRoot, paths: fx.paths, spawn, recorder, pinned, uid, now, dryRun, iterationToken,
    env: { path: '/usr/bin', home: fx.home, base },
    key: '0123456789abcdef0123456789abcdef',
    redactor: createRedactor({ secretValues: [] }),
    local: { repo: fx.repo, model: 'opus', adapter: 'claude-code', adapterSupported: true, sshIdentity: fx.keyPath, trustedBinDirs: null, ...local },
    inherited: { PATH: '/usr/bin', HOME: fx.home, XDG_RUNTIME_DIR: join(fx.root, 'xdg'), ...inherited },
    netGit: fx.paths.netGit, netGitConfigSha256: fx.netGitSha,
    fs, toolchain, log: () => {}, sleep: async () => {},
  };
}

function fakeKeygen(fx) {
  return (args) => {
    if (args[0] === '-y') return { stdout: `${fx.pubLine}\n`, status: 0 };
    if (args[0] === '-lf') return { stdout: `256 SHA256:${'A'.repeat(43)} operator@laptop (ED25519)\n`, status: 0 };
    return { status: 1 };
  };
}

/** A real unix socket for agent-mode fixtures; returns { path, close }. */
export function listenSocket(dir) {
  const path = join(dir, 'agent.sock');
  const server = createServer();
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, () => resolve({ path, close: () => new Promise((r) => server.close(() => r())) })); });
}

export const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? `thrown:${e.message}`; } };
export const gitSpawns = (recorder, pinned = PINNED) => recorder.filter((r) => r.argv[0] === pinned.git);
export const netSpawns = (recorder, pinned = PINNED) => gitSpawns(recorder, pinned).filter((r) => r.argv[1]?.startsWith('--git-dir=') && ['ls-remote', 'fetch', 'push'].includes(r.argv[2]));
