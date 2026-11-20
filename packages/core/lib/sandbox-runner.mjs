// @adlc/core sandbox runner: synchronous OS-sandbox (bwrap / sandbox-exec)
// spawning, filesystem secret-masking, Seatbelt SBPL builders, and candidate
// environment scrubbing shared by every tool that runs untrusted commands.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { escapeSeatbeltPath } from './primitives.mjs';

export { escapeSeatbeltPath };

export const SENSITIVE_HOME_DIRS = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.config/adlc',
  '.config/opencode', '.config/github-copilot', '.config/pi', '.local/share/cursor-agent',
  '.azure', '.kube', '.docker', '.claude', '.codex', '.gemini', '.cursor', '.copilot', '.pi',
]);

export const SENSITIVE_HOME_FILES = Object.freeze([
  '.netrc', '.npmrc', '.git-credentials', '.claude.json', '.claude.json.backup',
]);

export const USER_EPHEMERAL_ROOTS = Object.freeze([
  '/home', '/Users', '/root', '/tmp', '/var/tmp', '/srv', '/opt', '/var', '/run', '/mnt',
]);

const SYSTEM_KEEP_ROOTS = new Set([
  'usr', 'bin', 'sbin', 'lib', 'lib64', 'lib32', 'libx32', 'etc', 'dev', 'proc', 'sys', 'nix', 'private',
]);

const DOT_ENV_RE = /^\.env(\..+)?$/;
const MAX_ENV_SCAN_DIRS = 16384;
const DEFAULT_ENV_MASK_CACHE = new Map();
function defaultMaxEnvScanDirs() {
  const raw = process.env.ADLC_MAX_ENV_SCAN_DIRS;
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : MAX_ENV_SCAN_DIRS;
}
function rootCacheStamp(p) {
  const real = realpathSafe(p);
  try { return `${real}@${statSync(real, { bigint: true }).mtimeNs}`; } catch { return real; }
}
export function resolveEnvMasks(roots, cloneDir, { flatRoots = [], skipDirs = [], maxDirs, envMaskCache } = {}) {
  const cloneLogical = resolve(cloneDir);
  const cloneReal = realpathSafe(cloneDir);
  const hostRoots = roots.filter((r) => r && !isInsideClone(cloneLogical, cloneReal, r));
  const explicitCache = envMaskCache instanceof Map;
  const cache = explicitCache ? envMaskCache : DEFAULT_ENV_MASK_CACHE;
  const stampFn = explicitCache ? realpathSafe : rootCacheStamp;
  const effMax = maxDirs ?? defaultMaxEnvScanDirs();
  const cacheKey = JSON.stringify([hostRoots.map(stampFn), flatRoots.filter(Boolean).map(stampFn), skipDirs, effMax]);
  const now = Date.now();
  const entry = cache.get(cacheKey);
  let files = entry && (explicitCache || now - entry.at < 5_000) ? entry.files : null;
  if (!files) {
    files = collectMaskedEnvFiles(hostRoots, cloneDir, { flatRoots, skipDirs, maxDirs: effMax });
    if (!explicitCache && cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { files, at: now });
  }
  return files.filter((f) => !isInsideClone(cloneLogical, cloneReal, f));
}

export function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isUnderOrEqual(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

export function isInsideClone(cloneLogical, cloneReal, target) {
  const tLogical = resolve(target);
  if (isUnderOrEqual(cloneLogical, tLogical) || isUnderOrEqual(cloneReal, tLogical)) return true;
  const tReal = realpathSafe(target);
  return isUnderOrEqual(cloneLogical, tReal) || isUnderOrEqual(cloneReal, tReal);
}

function ancestorDirsOf(startDir) {
  const dirs = [];
  let cur = resolve(startDir);
  for (;;) {
    dirs.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/**
 * Resolve the common git directory and primary checkout root even when `startDir`
 * is a linked git worktree whose `.git` entry is a `gitdir: .../.git/worktrees/<lane>` file.
 */
export function resolveCommonGitInfo(startDir) {
  if (!startDir) return { commonGitDir: null, commonGitRoot: null };
  for (const dir of ancestorDirsOf(realpathSafe(startDir))) {
    const dotGit = join(dir, '.git');
    let st;
    try {
      st = statSync(dotGit);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const realGit = realpathSafe(dotGit);
      return { commonGitDir: realGit, commonGitRoot: dirname(realGit) };
    }
    if (st.isFile()) {
      try {
        const raw = readFileSync(dotGit, 'utf8').trim();
        if (!raw.startsWith('gitdir:')) continue;
        const target = raw.slice('gitdir:'.length).trim();
        const gitDir = realpathSafe(isAbsolute(target) ? target : resolve(dir, target));
        let commonDir = gitDir;
        const commondirFile = join(gitDir, 'commondir');
        if (existsSync(commondirFile)) {
          const relCommon = readFileSync(commondirFile, 'utf8').trim();
          if (relCommon) commonDir = realpathSafe(resolve(gitDir, relCommon));
        } else if (basename(dirname(gitDir)) === 'worktrees') {
          commonDir = dirname(dirname(gitDir));
        }
        return { commonGitDir: commonDir, commonGitRoot: dirname(commonDir) };
      } catch {
        return { commonGitDir: null, commonGitRoot: null };
      }
    }
  }
  return { commonGitDir: null, commonGitRoot: null };
}

/**
 * Discover `.worktrees` directories (or sibling `.worktrees/<lane>` directories when
 * `workDir`/`cloneDir` lives inside one) across `roots` and their primary checkouts.
 */
export function collectWorktreeSiblingMasks(roots, cloneDir, workDir = cloneDir) {
  const cloneLogical = resolve(cloneDir);
  const cloneReal = realpathSafe(cloneDir);
  const workLogical = resolve(workDir);
  const workReal = realpathSafe(workDir);
  const out = new Set();
  const candidateRoots = new Set();
  for (const r of roots) {
    if (!r) continue;
    for (const d of ancestorDirsOf(realpathSafe(r))) candidateRoots.add(d);
    const { commonGitRoot } = resolveCommonGitInfo(r);
    if (commonGitRoot) {
      for (const d of ancestorDirsOf(commonGitRoot)) candidateRoots.add(d);
    }
  }
  const containsActive = (p) =>
    isUnderOrEqual(p, cloneLogical) ||
    isUnderOrEqual(p, cloneReal) ||
    isUnderOrEqual(p, workLogical) ||
    isUnderOrEqual(p, workReal);

  for (const base of candidateRoots) {
    const wtDir = join(base, '.worktrees');
    let realWt;
    try {
      realWt = realpathSync(wtDir);
      if (!statSync(realWt).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!containsActive(realWt)) {
      out.add(realWt);
      continue;
    }
    try {
      for (const entry of readdirSync(realWt)) {
        const child = realpathSync(join(realWt, entry));
        if (statSync(child).isDirectory() && !containsActive(child)) {
          out.add(child);
        }
      }
    } catch { /* unreadable dir */ }
  }
  return [...out].sort();
}

/**
 * Discover existing regular `.env` / `.env.*` files across `roots` (ancestors +
 * bounded subdirectory trees), their primary git checkouts, and `flatRoots`.
 */
export function collectMaskedEnvFiles(roots, cloneDir, { flatRoots = [], skipDirs = [], maxDirs = defaultMaxEnvScanDirs(), fsOps } = {}) {
  const rdSync = fsOps?.readdirSync ?? readdirSync;
  const rpSync = fsOps?.realpathSync ?? realpathSync;
  const stSync = fsOps?.statSync ?? statSync;
  const rpSafe = fsOps?.realpathSync ? (p) => { try { return rpSync(p); } catch { return resolve(p); } } : realpathSafe;
  const cloneLogical = resolve(cloneDir);
  const cloneReal = rpSafe(cloneDir);
  const skipSubtreeRoots = new Set([
    '/', rpSafe(homedir()), rpSafe(tmpdir()), ...flatRoots.filter(Boolean).map((r) => rpSafe(r)),
  ]);
  const skipTrees = skipDirs.map((d) => rpSafe(d));
  const isExcludedTree = (d) => isInsideClone(cloneLogical, cloneReal, d) || skipTrees.some((s) => isUnderOrEqual(s, d));
  const seenAncDirs = new Set();
  const seenSubDirs = new Set();
  const masked = new Set();
  const scanDir = (dir) => {
    let entries;
    try { entries = rdSync(dir, { withFileTypes: true }); } catch { return []; }
    for (const ent of entries) {
      if (!DOT_ENV_RE.test(ent.name)) continue;
      const candidate = join(dir, ent.name);
      if (isUnderOrEqual(cloneLogical, candidate) || isUnderOrEqual(cloneReal, candidate)) continue;
      try {
        const real = rpSync(candidate);
        if (!isInsideClone(cloneLogical, cloneReal, real) && stSync(real).isFile()) masked.add(real);
      } catch { /* broken symlink or unreadable */ }
    }
    return entries;
  };
  const subtreeRoots = [...roots];
  for (const r of roots) {
    if (!r) continue;
    const { commonGitRoot } = resolveCommonGitInfo(r);
    if (commonGitRoot) subtreeRoots.push(commonGitRoot);
  }
  for (const r of [...subtreeRoots, ...flatRoots]) {
    if (!r) continue;
    for (const start of [resolve(r), rpSafe(r)]) {
      for (const dir of ancestorDirsOf(start)) {
        if (seenAncDirs.has(dir) || isInsideClone(cloneLogical, cloneReal, dir)) continue;
        seenAncDirs.add(dir);
        scanDir(dir);
      }
    }
  }
  const allowedTrees = subtreeRoots.filter(Boolean).map((r) => rpSafe(r)).filter((d) => !skipSubtreeRoots.has(d) && !isExcludedTree(d));
  const queue = [...allowedTrees];
  while (queue.length > 0 && seenSubDirs.size < maxDirs) {
    const dir = queue.shift();
    if (seenSubDirs.has(dir) || isExcludedTree(dir)) continue;
    seenSubDirs.add(dir);
    for (const ent of scanDir(dir)) {
      if ((ent.isDirectory() || ent.isSymbolicLink()) && ent.name !== '.git' && ent.name !== 'node_modules' && ent.name !== '.worktrees') {
        const child = rpSafe(join(dir, ent.name));
        if (
          !seenSubDirs.has(child) &&
          !skipSubtreeRoots.has(child) &&
          !isExcludedTree(child) &&
          !/(?:^|[\\/])(?:\.git|node_modules)(?:[\\/]|$)/.test(child) &&
          allowedTrees.some((root) => isUnderOrEqual(root, child))
        ) {
          try { if (stSync(child).isDirectory()) queue.push(child); } catch { /* ignore */ }
        }
      }
    }
  }
  if (queue.length > 0) {
    throw new Error(`collectMaskedEnvFiles exceeded directory scan limit (${maxDirs}); refusing incomplete .env mask (raise via maxEnvScanDirs or ADLC_MAX_ENV_SCAN_DIRS)`);
  }
  return [...masked].sort();
}

export function collectBwrapHomeMasks(homeDir, cloneDir, workDir) {
  if (!homeDir) return [];
  const cloneLogical = resolve(cloneDir);
  const cloneReal = realpathSafe(cloneDir);
  const workReal = realpathSafe(workDir);
  const masks = [];
  const seen = new Set();
  for (const rel of SENSITIVE_HOME_DIRS) {
    const p = join(homeDir, rel);
    try {
      const real = realpathSync(p);
      if (seen.has(real)) continue;
      if (isUnderOrEqual(real, cloneLogical) || isUnderOrEqual(real, cloneReal) || isUnderOrEqual(real, workReal)) continue;
      if (isInsideClone(cloneLogical, cloneReal, real)) continue;
      if (statSync(real).isDirectory()) {
        seen.add(real);
        masks.push('--tmpfs', real);
      }
    } catch { /* absent on host */ }
  }
  for (const rel of SENSITIVE_HOME_FILES) {
    const p = join(homeDir, rel);
    try {
      const real = realpathSync(p);
      if (seen.has(real)) continue;
      if (isInsideClone(cloneLogical, cloneReal, real)) continue;
      if (statSync(real).isFile()) {
        seen.add(real);
        masks.push('--ro-bind', '/dev/null', real);
      }
    } catch { /* absent on host */ }
  }
  return masks;
}

/**
 * Build Linux bubblewrap mounts that wipe host user/ephemeral trees (`/home`,
 * `/Users`, `/root`, `/tmp`, `/var/tmp`, `/srv`, `homeDir`) with `--tmpfs`,
 * selectively re-bind only needed read-only toolchain binaries + `workDir` (when
 * running a baseline witness outside `cloneDir`), and mask sibling `.worktrees`,
 * sensitive `$HOME` credential paths, and `.env*` files.
 */
export function buildBwrapIsolationMounts({ cloneDir, workDir = cloneDir, cwd, repoRoot, homeDir, pathEnv = process.env.PATH, envMasks: precomputedEnvMasks, maxDirs, envMaskCache }) {
  const cloneReal = realpathSafe(cloneDir);
  const workReal = realpathSafe(workDir);
  const homeReal = homeDir ? realpathSafe(homeDir) : null;
  const sensitiveRoots = homeReal
    ? SENSITIVE_HOME_DIRS.flatMap((rel) => {
      const logical = resolve(homeReal, rel);
      return [logical, realpathSafe(logical)];
    })
    : [];
  const isSensitive = (p) => sensitiveRoots.some((s) => isUnderOrEqual(s, p));

  let hostTopDirs = [];
  try {
    hostTopDirs = readdirSync('/')
      .filter((name) => !SYSTEM_KEEP_ROOTS.has(name))
      .filter((name) => { try { return lstatSync('/' + name).isDirectory(); } catch { return false; } })
      .map((name) => '/' + name);
  } catch { /* fallback to USER_EPHEMERAL_ROOTS */ }
  const rawWiped = [];
  for (const candidate of [...USER_EPHEMERAL_ROOTS, ...hostTopDirs, homeDir]) {
    if (!candidate) continue;
    try {
      const real = realpathSync(candidate);
      if (real !== '/' && real !== cloneReal && statSync(real).isDirectory()) rawWiped.push(real);
    } catch { /* absent on host */ }
  }
  const wipedRoots = [];
  for (const real of [...new Set(rawWiped)].sort((a, b) => a.length - b.length)) {
    if (!wipedRoots.some((w) => isUnderOrEqual(w, real))) wipedRoots.push(real);
  }
  const isInsideWiped = (p) => wipedRoots.some((w) => p !== w && isUnderOrEqual(w, p));
  const isForbiddenBase = (p) =>
    wipedRoots.includes(p) ||
    (homeReal && (p === homeReal || p === join(homeReal, '.local') || p === join(homeReal, '.config'))) ||
    isInsideClone(cloneDir, cloneReal, p) ||
    isSensitive(p);
  const isForbiddenRebind = (p) =>
    isForbiddenBase(p) || /(?:^|[\\/])(?:\.worktrees|node_modules)(?:[\\/]|$)/.test(p);
  const isForbiddenWorkLogical = (p) =>
    isForbiddenBase(p) || /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(p);

  const rebinds = [];
  const seenRebinds = new Set();
  const addReadOnlyDir = (dir) => {
    if (!dir || seenRebinds.has(dir) || !isInsideWiped(dir) || isForbiddenRebind(dir)) return;
    try {
      if (statSync(dir).isDirectory()) {
        seenRebinds.add(dir);
        rebinds.push('--ro-bind', dir, dir);
      }
    } catch { /* absent */ }
  };

  try {
    const realExec = realpathSync(process.execPath);
    const binDir = dirname(realExec);
    const installRoot = basename(binDir) === 'bin' ? dirname(binDir) : binDir;
    if (!isForbiddenRebind(installRoot) && isInsideWiped(installRoot)) addReadOnlyDir(installRoot);
    else addReadOnlyDir(binDir);
  } catch { /* ignore */ }

  for (const rawDir of String(pathEnv ?? '').split(delimiter)) {
    if (!rawDir || !isAbsolute(rawDir)) continue;
    for (const candidate of [resolve(rawDir), realpathSafe(rawDir)]) {
      addReadOnlyDir(candidate);
      if (basename(candidate) === 'bin') addReadOnlyDir(join(dirname(candidate), 'lib'));
    }
  }

  const workLogical = resolve(workDir);
  if (workReal !== cloneReal && !isInsideClone(cloneDir, cloneReal, workReal)) {
    try {
      if (statSync(workReal).isDirectory()) {
        if (isInsideWiped(workReal)) rebinds.push('--ro-bind', workReal, workReal);
        if (workLogical !== workReal && isInsideWiped(workLogical) && !isForbiddenWorkLogical(workLogical)) {
          rebinds.push('--ro-bind', workReal, workLogical);
        }
        const { commonGitDir } = resolveCommonGitInfo(workReal);
        if (commonGitDir && isInsideWiped(commonGitDir) && !isUnderOrEqual(workReal, commonGitDir) && !isInsideClone(cloneDir, cloneReal, commonGitDir)) {
          rebinds.push('--ro-bind', commonGitDir, commonGitDir);
        }
      }
    } catch { /* synthetic test path */ }
  }

  const hostFallback = repoRoot === undefined && cwd === undefined && workDir === cloneDir ? process.cwd() : null;
  const roots = [workDir, cwd, repoRoot, hostFallback];
  const siblingWorktrees = collectWorktreeSiblingMasks(roots, cloneDir, workDir);
  const wtMasks = siblingWorktrees.flatMap((d) => ['--tmpfs', d]);
  const homeMasks = collectBwrapHomeMasks(homeDir, cloneDir, workDir);
  const rawEnvFiles = precomputedEnvMasks ?? resolveEnvMasks(roots, cloneDir, { flatRoots: [homeDir], skipDirs: siblingWorktrees, maxDirs, envMaskCache });
  const envMasks = rawEnvFiles.flatMap((f) => ['--ro-bind', '/dev/null', f]);

  return [...wipedRoots.flatMap((r) => ['--tmpfs', r]), ...rebinds, ...wtMasks, ...homeMasks, ...envMasks];
}

const MAC_HOME_TOOLCHAINS = [
  '.nvm', '.volta', '.fnm', '.asdf', '.mise', '.local', '.cargo', '.rustup', '.npm', '.cache', '.bun', '.pnpm-store',
];

/**
 * Build the macOS SBPL sandbox profile.
 * Deny default, allow process execution, deny `$HOME` reads by default (re-allowing
 * only read-only toolchain dirs + `workDir`), deny host `.env*` files, sibling
 * `.worktrees`, and sensitive `$HOME` credentials, deny network, and confine writes to `cloneDir`.
 *
 * @param {string} cloneDir
 * @param {{homeDir?:string, workDir?:string, cwd?:string, repoRoot?:string, maxEnvScanDirs?:number, envMaskCache?:Map}} [opts]
 * @returns {string} SBPL profile string
 */
export function buildMacOSSbpl(cloneDir, opts = {}) {
  const escapedDir = escapeSeatbeltPath(cloneDir);
  const cloneLogical = resolve(cloneDir);
  const cloneReal = realpathSafe(cloneDir);
  const workDir = opts.workDir ?? cloneDir;
  const homeDir = opts.homeDir === undefined ? homedir() : opts.homeDir;
  const homeRules = [
    '(deny file-read* (subpath "/Users"))', '(allow file-read-metadata (subpath "/Users"))',
    '(deny file-read* (subpath "/private/tmp"))', '(allow file-read-metadata (subpath "/private/tmp"))',
  ];
  const seenDeny = new Set();
  const extraDenies = [];
  const pushDeny = (kind, p) => {
    const key = `${kind}:${p}`;
    if (seenDeny.has(key)) return;
    seenDeny.add(key);
    extraDenies.push(`(deny file-read* (${kind} "${escapeSeatbeltPath(p)}"))`);
  };
  if (homeDir) {
    const homeReal = realpathSafe(homeDir);
    const homeVariants = homeReal !== resolve(homeDir) ? [homeDir, homeReal] : [homeDir];
    for (const hv of homeVariants) {
      const eh = escapeSeatbeltPath(hv);
      homeRules.push(`(deny file-read* (subpath "${eh}"))`, `(allow file-read-metadata (subpath "${eh}"))`);
      for (const tc of MAC_HOME_TOOLCHAINS) {
        homeRules.push(`(allow file-read* (subpath "${escapeSeatbeltPath(join(hv, tc))}"))`);
      }
    }
    for (const rel of SENSITIVE_HOME_DIRS) {
      const logical = join(homeDir, rel);
      if (!isUnderOrEqual(cloneLogical, logical) && !isUnderOrEqual(cloneReal, logical)) pushDeny('subpath', logical);
      try {
        const real = realpathSync(logical);
        if (real !== resolve(logical) && !isInsideClone(cloneLogical, cloneReal, real)) pushDeny('subpath', real);
      } catch { /* absent on host */ }
    }
    for (const rel of SENSITIVE_HOME_FILES) {
      const logical = join(homeDir, rel);
      if (!isUnderOrEqual(cloneLogical, logical) && !isUnderOrEqual(cloneReal, logical)) pushDeny('literal', logical);
      try {
        const real = realpathSync(logical);
        if (real !== resolve(logical) && !isInsideClone(cloneLogical, cloneReal, real)) pushDeny('literal', real);
      } catch { /* absent on host */ }
    }
  }
  if (workDir !== cloneDir) {
    homeRules.push(`(allow file-read* (subpath "${escapeSeatbeltPath(workDir)}"))`);
    const workReal = realpathSafe(workDir);
    if (workReal !== workDir) homeRules.push(`(allow file-read* (subpath "${escapeSeatbeltPath(workReal)}"))`);
  }
  const hostFallback = opts.repoRoot === undefined && opts.cwd === undefined && workDir === cloneDir ? process.cwd() : null;
  const roots = [workDir, opts.cwd, opts.repoRoot, hostFallback];
  const wtSiblings = collectWorktreeSiblingMasks(roots, cloneDir, workDir);
  for (const wt of wtSiblings) {
    pushDeny('subpath', wt);
  }
  const envFiles = resolveEnvMasks(roots, cloneDir, {
    flatRoots: homeDir ? [homeDir] : [],
    skipDirs: wtSiblings,
    maxDirs: opts.maxEnvScanDirs,
    envMaskCache: opts.envMaskCache,
  });
  for (const envFile of envFiles) {
    pushDeny('literal', envFile);
  }
  const cloneAllows = [
    `(allow file-read* (subpath "${escapedDir}"))`,
    `(allow file-write* (subpath "${escapedDir}"))`,
  ];
  if (cloneReal !== cloneDir) {
    const escapedReal = escapeSeatbeltPath(cloneReal);
    if (escapedReal !== escapedDir) {
      cloneAllows.push(`(allow file-read* (subpath "${escapedReal}"))`, `(allow file-write* (subpath "${escapedReal}"))`);
    }
  }
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read*)',
    '(deny network*)',
    ...homeRules,
    '(deny file-read* (regex #"(^|/)\\.env(\\..+)?$"))',
    ...extraDenies,
    ...cloneAllows,
    '(allow file-write-data (path "/dev/null"))',
  ].join('');
}

export const seatbeltWrap = buildMacOSSbpl;

export const SANDBOX_PROFILES = {
  bwrap: {
    binary: 'bwrap',
    description: 'Linux bubblewrap sandbox (unshares all namespaces, denies network)',
  },
  'sandbox-exec': {
    binary: 'sandbox-exec',
    description: 'macOS sandbox-exec with SBPL profile (denies network, write-confined to clone)',
  },
};

const CODE_INJECTION_ENV_RE =
  /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_REPL_EXTERNAL_MODULE$|PYTHON(?:STARTUP|PATH)$|RUBY(?:OPT|LIB)$|PERL5(?:OPT|LIB)$|BASH_ENV$|ENV$|GIT_(?:SSH_COMMAND$|EXTERNAL_DIFF$|EXEC_PATH$|TEMPLATE_DIR$|CONFIG_))/i;

const CANDIDATE_SECRET_PATTERNS = [
  /^ADLC_/i,
  /API_KEY$/i,
  /_KEY$/i,
  /_SECRET$/i,
  /SECRET$/i,
  /_TOKEN$/i,
  /TOKEN$/i,
  /PASSWORD/i,
  /^AWS_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^AZURE_/i,
  /^GH_/i,
  /^GITHUB_TOKEN$/i,
  /CREDENTIAL/i,
  /^NPM_TOKEN$/i,
  CODE_INJECTION_ENV_RE,
];

function isSensitiveCandidateVar(name) {
  return CANDIDATE_SECRET_PATTERNS.some((re) => re.test(name));
}

function stripCodeInjectionEnv(baseEnv) {
  const out = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined || CODE_INJECTION_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build a scrubbed copy of `baseEnv` for adversary-generated setup/witness
 * commands (#648): strips ADLC_* trust-root variables (including
 * ADLC_MANIFEST_KEY), provider/cloud credentials (*_API_KEY, *_TOKEN, etc.),
 * and code-injection vectors (NODE_OPTIONS, GIT_SSH_COMMAND) while preserving
 * benign runtime variables (PATH, HOME, LANG, TMPDIR, etc.).
 *
 * @param {Record<string, string | undefined>} [baseEnv]
 * @returns {Record<string, string>}
 */
export function sanitizeCandidateEnv(baseEnv = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (isSensitiveCandidateVar(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Detect which sandbox binary is available. With the default `which`, bwrap is
 * only reported when it can actually create a sandbox (nested containers
 * without unprivileged user namespaces report null).
 * @param {{which?:Function}} opts - injectable for tests
 * @returns {'bwrap'|'sandbox-exec'|null}
 */
/**
 * Resolve a trusted root-owned OS sandbox launcher (`bwrap` or `sandbox-exec`)
 * to its canonical absolute path, rejecting relative PATH entries, user-owned
 * binaries, and any binary or ancestor directory writable by group or others.
 *
 * @param {string} name
 * @param {{pathEnv?:string, fsOps?:object}} [opts]
 * @returns {string|null}
 */
export function resolveSandboxBinary(name, { pathEnv = process.env.PATH, fsOps } = {}) {
  if (name !== 'bwrap' && name !== 'sandbox-exec') return null;
  if (typeof pathEnv !== 'string') return null;
  const lst = fsOps?.lstatSync ?? lstatSync;
  const st = fsOps?.statSync ?? statSync;
  const rp = fsOps?.realpathSync ?? realpathSync;
  const isLockedRoot = (statObj) => statObj.uid === 0 && (statObj.mode & 0o022) === 0;

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      const link = lst(candidate);
      const isSym = (link.mode & 0o170000) === 0o120000;
      if (link.uid !== 0 || (!isSym && !isLockedRoot(link))) continue;
      const real = rp(candidate);
      const file = st(real);
      if (!file.isFile() || !isLockedRoot(file)) continue;
      const ancestors = [...ancestorDirsOf(candidate), ...ancestorDirsOf(real)];
      if (!ancestors.every((anc) => isLockedRoot(st(anc)))) continue;
      return real;
    } catch {
      continue;
    }
  }
  return null;
}

export function detectSandbox(opts = {}) {
  if (opts.which) {
    if (opts.which('bwrap')) return 'bwrap';
    if (opts.which('sandbox-exec')) return 'sandbox-exec';
    return null;
  }

  const bwrapBin = resolveSandboxBinary('bwrap', { pathEnv: opts.pathEnv, fsOps: opts.fsOps });
  if (bwrapBin) {
    const runProbe = opts.spawn ?? spawnSync;
    const probe = runProbe(bwrapBin, ['--ro-bind', '/', '/', '--', 'true'], {
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin' },
    });
    if (probe.status === 0) return 'bwrap';
  }
  const sbExecBin = resolveSandboxBinary('sandbox-exec', { pathEnv: opts.pathEnv, fsOps: opts.fsOps });
  if (sbExecBin) return 'sandbox-exec';
  return null;
}

function assertSafeCmdArgs(cmdArgs) {
  if (
    !Array.isArray(cmdArgs) ||
    cmdArgs.length === 0 ||
    typeof cmdArgs[0] !== 'string' ||
    cmdArgs[0].length === 0 ||
    cmdArgs[0].startsWith('-') ||
    cmdArgs[0].includes('\0')
  ) {
    throw new Error('cmdArgs[0] must be a non-empty executable name or path without NUL bytes or a leading "-"');
  }
}

/**
 * Build sandboxed argv for running a command inside the sandbox.
 *
 * - bwrap: --unshare-all --ro-bind / / (+ masks over host .env* and $HOME creds)
 *          --bind <cloneDir> <cloneDir>
 *          --dev /dev --proc /proc --die-with-parent --new-session
 *          --chdir <workDir> -- <cmd> <args>
 *          (no --share-net: network unshared/denied)
 * - sandbox-exec: -p '<SBPL>' <cmd> <args>
 *
 * @param {'bwrap'|'sandbox-exec'} sandboxType
 * @param {string} cloneDir - the ONLY writable subpath
 * @param {string[]} cmdArgs - [cmd, ...args]
 * @param {{workDir?:string, cwd?:string, repoRoot?:string, homeDir?:string}} [opts]
 * @returns {string[]} Full argv including sandbox binary and args
 */
export function buildSandboxedArgs(sandboxType, cloneDir, cmdArgs, opts = {}) {
  assertSafeCmdArgs(cmdArgs);
  const workDir = opts.workDir ?? cloneDir;
  const homeDir = opts.homeDir === undefined ? homedir() : opts.homeDir;
  if (sandboxType === 'bwrap') {
    const isolationMounts = buildBwrapIsolationMounts({
      cloneDir,
      workDir,
      cwd: opts.cwd,
      repoRoot: opts.repoRoot,
      homeDir,
      maxDirs: opts.maxEnvScanDirs,
      envMaskCache: opts.envMaskCache,
    });
    const cloneReal = realpathSafe(cloneDir);
    const cloneBinds = ['--bind', cloneDir, cloneDir];
    if (cloneReal !== cloneDir && cloneReal !== resolve(cloneDir)) {
      cloneBinds.push('--bind', cloneReal, cloneReal);
    }
    return [
      opts.launcherPath ?? 'bwrap',
      '--unshare-all',
      '--ro-bind', '/', '/',
      ...isolationMounts,
      ...cloneBinds,
      '--dev', '/dev',
      '--proc', '/proc',
      '--die-with-parent',
      '--new-session',
      '--chdir', workDir,
      '--',
      ...cmdArgs,
    ];
  }

  if (sandboxType === 'sandbox-exec') {
    const sbpl = buildMacOSSbpl(cloneDir, {
      homeDir,
      workDir,
      cwd: opts.cwd,
      repoRoot: opts.repoRoot,
      maxEnvScanDirs: opts.maxEnvScanDirs,
      envMaskCache: opts.envMaskCache,
    });
    return [
      opts.launcherPath ?? 'sandbox-exec',
      '-p', sbpl,
      '--',
      ...cmdArgs,
    ];
  }

  throw new Error(`unsupported sandbox type: ${sandboxType}`);
}

/**
 * Spawn a command under the OS sandbox.
 * @param {string} sandboxType - 'bwrap' | 'sandbox-exec'
 * @param {string} cloneDir
 * @param {string[]} cmdArgs - [cmd, ...args]
 * @param {{cwd?:string, workDir?:string, repoRoot?:string, homeDir?:string, timeout?:number, env?:object, spawn?:Function, launcherPath?:string, pathEnv?:string, fsOps?:object}} spawnOpts
 * @returns {{exitCode:number, stdout:string, stderr:string, timedOut:boolean}}
 */
export function spawnSandboxed(sandboxType, cloneDir, cmdArgs, spawnOpts = {}) {
  const launcherPath = spawnOpts.launcherPath ?? resolveSandboxBinary(sandboxType, {
    pathEnv: spawnOpts.pathEnv,
    fsOps: spawnOpts.fsOps,
  });
  if (!launcherPath && !spawnOpts.spawn) {
    throw new Error(`No trusted root-owned sandbox binary found for ${sandboxType}`);
  }
  const workDir = spawnOpts.workDir ?? spawnOpts.cwd ?? cloneDir;
  const sandboxedArgs = buildSandboxedArgs(sandboxType, cloneDir, cmdArgs, {
    workDir,
    cwd: spawnOpts.cwd,
    repoRoot: spawnOpts.repoRoot,
    homeDir: spawnOpts.homeDir,
    maxEnvScanDirs: spawnOpts.maxEnvScanDirs,
    envMaskCache: spawnOpts.envMaskCache,
    launcherPath: launcherPath ?? undefined,
  });
  const [bin, ...args] = sandboxedArgs;
  const runSpawn = spawnOpts.spawn ?? spawnSync;
  const r = runSpawn(bin, args, {
    cwd: spawnOpts.cwd ?? cloneDir,
    timeout: spawnOpts.timeout ?? 120_000,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    env: spawnOpts.env ? stripCodeInjectionEnv(spawnOpts.env) : sanitizeCandidateEnv(),
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.signal === 'SIGTERM' || r.status === null,
  };
}

/**
 * Spawn a command, using sandbox if available.
 * If no sandbox and not unsafeNoSandbox, throws with instructions.
 *
 * @param {string[]} cmdArgs - [cmd, ...args]
 * @param {string} cloneDir
 * @param {{sandboxType?:string|null, unsafeNoSandbox?:boolean, cwd?:string, repoRoot?:string, homeDir?:string, timeout?:number, env?:object, spawn?:Function}} opts
 * @returns {{exitCode:number, stdout:string, stderr:string, timedOut:boolean}}
 */
export function spawnCandidateCmd(cmdArgs, cloneDir, opts = {}) {
  assertSafeCmdArgs(cmdArgs);
  const { sandboxType, unsafeNoSandbox = false } = opts;

  if (!sandboxType) {
    if (!unsafeNoSandbox) {
      throw new Error(
        'No OS sandbox binary found (bwrap on Linux, sandbox-exec on macOS). ' +
        'Pass --unsafe-no-sandbox to run candidate commands without sandboxing ' +
        '(ONLY safe inside a disposable VM or container).'
      );
    }
    // Loud warning
    process.stderr.write(
      '\nWARNING: Running candidate commands WITHOUT sandbox protection.\n' +
      'This executes untrusted adversary-generated code with no network/write isolation.\n' +
      'ONLY safe inside a disposable VM or container.\n\n'
    );
    const [cmd, ...args] = cmdArgs;
    const runSpawn = opts.spawn ?? spawnSync;
    const r = runSpawn(cmd, args, {
      cwd: opts.cwd ?? cloneDir,
      timeout: opts.timeout ?? 120_000,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: false,
      env: opts.env ? stripCodeInjectionEnv(opts.env) : sanitizeCandidateEnv(),
    });
    return {
      exitCode: r.status ?? 1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: r.signal === 'SIGTERM' || r.status === null,
    };
  }

  return spawnSandboxed(sandboxType, cloneDir, cmdArgs, opts);
}
