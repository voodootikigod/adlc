// Git transport sanitization and the network repository (spec §9.1b, §9.1c;
// AC 124, 126, 127, 138, 143).
//
// A pinned URL is only as trustworthy as the transport git resolves it through.
// So EVERY git process the orchestrator spawns runs with the global/system
// config disabled, every inherited GIT_*/proxy/askpass variable removed, and an
// env-supplied configuration table (GIT_CONFIG_COUNT=7) that binds `origin` to
// the pinned URLs and the SSH command to the generated wrapper. And no NETWORK
// operation ever runs against the repository's own configuration: `ls-remote`,
// `fetch` and `push` run as `git --git-dir=<NET_GIT>` — a bare repository the
// orchestrator writes from a fixed template and re-verifies before every spawn.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['gitEnv.classifierNetworkBlind', 'gitEnv.keepInherited', 'gitEnv.auditPasses', 'gitEnv.dropIdentityRows']);

/** Variables removed from every git spawn (§9.1b). A name is stripped when it matches any entry. */
export const STRIPPED_GIT_VARS = Object.freeze([
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_PARAMETERS',
  'GIT_TERMINAL_PROMPT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'GIT_EXTERNAL_DIFF', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
]);
const STRIPPED_PREFIXES = Object.freeze(['GIT_CONFIG_', 'GIT_TRACE', 'GIT_ATTR_']);
const STRIPPED_CI = Object.freeze(['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ftp_proxy']);

export function isStrippedGitVar(name) {
  // Mutation seam `gitEnv.keepInherited`: nothing is stripped.
  if (active('gitEnv.keepInherited')) return false;
  if (name.startsWith('GIT_')) {
    // EVERY GIT_* variable inherited from the orchestrator's own environment is removed.
    return true;
  }
  if (STRIPPED_CI.includes(name.toLowerCase())) return true;
  return STRIPPED_GIT_VARS.includes(name) || STRIPPED_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * The base env for ANY git spawn: the sanitized PATH/HOME/locale only, plus the
 * fixed config-isolation variables. Never the raw inherited environment.
 */
export function gitBaseEnv({ path, home, lang = 'C.UTF-8', tz = 'UTC' }) {
  return {
    PATH: path, HOME: home, LANG: lang, LC_ALL: lang, TZ: tz,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Strip the inherited GIT_* / proxy / askpass set from a copy of `source` (defence in depth). */
export function stripGitVars(source) {
  const out = {};
  for (const [k, v] of Object.entries(source ?? {})) if (!isStrippedGitVar(k) && k !== 'GIT_TERMINAL_PROMPT') out[k] = v;
  return out;
}

/** POSIX single-quote escaping: `'…'` with `'\''` for embedded quotes. */
export function shellQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }

/**
 * The §9.1b env-supplied configuration table, numbered in this exact order
 * (GIT_CONFIG_COUNT=7). Applied ONLY to processes that perform network
 * operations (and the bracketed preflight/fleet); observation reads never carry it.
 */
export function boundGitConfig({ remoteFetchUrl, remotePushUrl, sshWrapperPath }) {
  const identityRows = active('gitEnv.dropIdentityRows') ? [] : [
    [`url.${remoteFetchUrl}.insteadOf`, remoteFetchUrl],
    [`url.${remotePushUrl}.pushInsteadOf`, remotePushUrl],
    [`url.${remotePushUrl}.insteadOf`, remotePushUrl],
  ];
  const rows = [
    ['remote.origin.url', remoteFetchUrl],
    ['remote.origin.pushurl', remotePushUrl],
    ['core.hooksPath', '/dev/null'],
    ...identityRows,
    ['core.sshCommand', shellQuote(sshWrapperPath)],
  ];
  const env = { GIT_CONFIG_COUNT: String(rows.length) };
  rows.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return { rows, env };
}

/** The env for a NETWORK git spawn: base + bound table + GIT_SSH wrapper. */
export function networkGitEnv({ base, remoteFetchUrl, remotePushUrl, sshWrapperPath }) {
  const { env } = boundGitConfig({ remoteFetchUrl, remotePushUrl, sshWrapperPath });
  return { ...base, ...env, GIT_SSH: sshWrapperPath };
}

// ---- repo-local config audit (§9.1b) ----
const FORBIDDEN_KEY_RE = /^(url\..*\.(insteadof|pushinsteadof)|core\.sshcommand|core\.gitproxy|http\..*|https\..*|remote\..*\.proxy|remote\..*\.uploadpack|remote\..*\.receivepack|credential\..*|include\..*|includeif\..*|core\.hookspath)$/i;

/** Audit `git config --file <REPO_ROOT>/.git/config --list` output. Returns { ok, offending[] }. */
export function auditRepoConfig(listOutput) {
  const offending = [];
  for (const line of String(listOutput ?? '').split('\n')) {
    if (!line.trim()) continue;
    const key = line.split('=')[0].trim();
    // Mutation seam `gitEnv.auditPasses`: forbidden keys are not reported.
    if (!active('gitEnv.auditPasses') && FORBIDDEN_KEY_RE.test(key)) offending.push(key);
  }
  return { ok: offending.length === 0, offending, code: offending.length ? 'git-config-untrusted' : null };
}

// ---- the network repository NET_GIT (§9.1c) ----
export const NET_GIT_CONFIG_TEMPLATE = ({ remoteFetchUrl, remotePushUrl, sshWrapperPath }) =>
  `[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tsshCommand = ${shellQuote(sshWrapperPath)}\n\thooksPath = /dev/null\n[remote "origin"]\n\turl = ${remoteFetchUrl}\n\tpushurl = ${remotePushUrl}\n`;

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Create (init --write) or verify (phase A) the network repository. Its config
 * is orchestrator-written from the template; `objects/info/alternates` names
 * the primary repository's object store so pushes read attested objects
 * without copying; `hooks/` is empty; it has no refs/heads.
 */
export function writeNetGit({ netGit, repoRoot, remoteFetchUrl, remotePushUrl, sshWrapperPath }) {
  for (const d of ['objects', 'objects/info', 'refs', 'refs/autopilot', 'hooks', 'info']) mkdirSync(join(netGit, d), { recursive: true });
  writeFileSync(join(netGit, 'HEAD'), 'ref: refs/autopilot/HEAD\n');
  const config = NET_GIT_CONFIG_TEMPLATE({ remoteFetchUrl, remotePushUrl, sshWrapperPath });
  writeFileSync(join(netGit, 'config'), config);
  writeFileSync(join(netGit, 'objects', 'info', 'alternates'), `${join(repoRoot, '.git', 'objects')}\n`);
  return { configSha256: sha256(config) };
}

/** Re-verify NET_GIT immediately before every network spawn. Returns { ok, code, detail }. */
export function verifyNetGit({ netGit, expectedConfigSha256, repoRoot }) {
  const cfg = join(netGit, 'config');
  if (!existsSync(cfg)) return { ok: false, code: 'net-config-tampered', detail: 'config missing' };
  const actual = sha256(readFileSync(cfg, 'utf8'));
  if (actual !== expectedConfigSha256) return { ok: false, code: 'net-config-tampered', detail: 'config sha256 differs' };
  const hooks = join(netGit, 'hooks');
  if (existsSync(hooks) && readdirSync(hooks).length > 0) return { ok: false, code: 'net-config-tampered', detail: 'hooks not empty' };
  const alt = join(netGit, 'objects', 'info', 'alternates');
  if (!existsSync(alt) || readFileSync(alt, 'utf8').trim() !== join(repoRoot, '.git', 'objects')) return { ok: false, code: 'net-config-tampered', detail: 'alternates differ' };
  const heads = join(netGit, 'refs', 'heads');
  if (existsSync(heads) && statSync(heads).isDirectory() && readdirSync(heads).length > 0) return { ok: false, code: 'net-config-tampered', detail: 'refs/heads present' };
  return { ok: true, code: null, detail: null };
}

/** The argv prefix of every network git operation: `git --git-dir=<NET_GIT>`. */
export function netGitArgv(gitPath, netGit, ...rest) { return [gitPath, `--git-dir=${netGit}`, ...rest]; }

/** Classify a git argv: is it a network operation, and what repository does it target? (spawn-recorder rule, AC 31/143) */
export function classifyGitSpawn(argv) {
  const gitDirArg = argv.find((a) => a.startsWith('--git-dir='));
  const cIdx = argv.indexOf('-C');
  const verbIdx = argv.findIndex((a, i) => i > 0 && !a.startsWith('-') && (cIdx === -1 || i !== cIdx + 1));
  const verb = verbIdx === -1 ? null : argv[verbIdx];
  // Mutation seam `gitEnv.classifierNetworkBlind`: the recorder cannot tell a network op apart.
  const network = !active('gitEnv.classifierNetworkBlind') && ['ls-remote', 'fetch', 'push'].includes(verb);
  return { verb, network, gitDir: gitDirArg ? gitDirArg.slice('--git-dir='.length) : null, cwdArg: cIdx === -1 ? null : argv[cIdx + 1], remoteArg: network ? argv.slice(verbIdx + 1).find((a) => !a.startsWith('-')) ?? null : null };
}
