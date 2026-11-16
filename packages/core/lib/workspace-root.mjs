// GENERATED-WORKSPACE-ROOT SOURCE. Run `node scripts/ticket-readers/generate.mjs` after edits.
//
// workspace-root.mjs — canonical checkout-root, nested linked-worktree, and
// tool working-directory resolution shared across ADLC packages and harnesses.

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const GITDIR_POINTER_MAX_BYTES = 4096;

export const SHELL_WORKDIR_KEYS = Object.freeze([
  'Cwd',
  'cwd',
  'dir_path',
  'dirPath',
  'working_directory',
  'workingDirectory',
  'working_dir',
  'workingDir',
  'workdir',
  'workDir',
]);

const WORKDIR_CONTAINERS = Object.freeze([
  'options',
  'params',
  'payload',
  'input',
  'tool_input',
  'toolInput',
]);

function readSmallRegularFile(filePath) {
  try {
    const st = lstatSync(filePath);
    if (!st.isFile() || st.size > GITDIR_POINTER_MAX_BYTES) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Extract the first explicit non-empty working directory string from a tool
 * invocation's arguments object across all supported harness schemas.
 *
 * @param {unknown} args
 * @returns {string | null}
 */
export function extractToolWorkdir(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = /** @type {Record<string, unknown>} */ (args);
  for (const key of SHELL_WORKDIR_KEYS) {
    const val = record[key];
    if (typeof val === 'string' && val.trim().length > 0) return val.trim();
  }
  for (const containerKey of WORKDIR_CONTAINERS) {
    const nested = record[containerKey];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const nestedRecord = /** @type {Record<string, unknown>} */ (nested);
    for (const key of SHELL_WORKDIR_KEYS) {
      const val = nestedRecord[key];
      if (typeof val === 'string' && val.trim().length > 0) return val.trim();
    }
  }
  return null;
}

/**
 * Resolve `targetPath` through symlinks on its deepest existing ancestor while
 * preserving any trailing non-existent path segments lexically.
 *
 * @param {string} targetPath
 * @returns {string}
 */
export function canonicalizePath(targetPath) {
  const abs = resolve(targetPath);
  const pending = [];
  let cur = abs;
  for (;;) {
    try {
      const realBase = realpathSync(cur);
      return pending.length === 0 ? realBase : join(realBase, ...pending);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      pending.unshift(relative(parent, cur));
      cur = parent;
    }
  }
}

/**
 * Symlink-aware, boundary-safe containment check: true iff `childPath` resolves
 * to `parentPath` itself or a descendant beneath `parentPath`.
 *
 * @param {string} childPath
 * @param {string} parentPath
 * @returns {boolean}
 */
export function isPathInside(childPath, parentPath) {
  if (typeof childPath !== 'string' || !childPath.trim()) return false;
  if (typeof parentPath !== 'string' || !parentPath.trim()) return false;
  const rel = relative(canonicalizePath(parentPath), canonicalizePath(childPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Inspect `dir/.git` without spawning git:
 * - `{ kind: 'repo', gitDir, commonGitDir }` for a `.git` directory with `HEAD`.
 * - `{ kind: 'worktree', gitDir, commonGitDir }` for a `.git` file whose
 *   `gitdir:` points to `<commonGitDir>/worktrees/<entry>` with a verified
 *   bidirectional `<entry>/gitdir` back-pointer to `dir` and `<commonGitDir>/HEAD`.
 * - `{ kind: 'gitfile', gitDir, commonGitDir: null }` for any other syntactic
 *   `gitdir:` pointer (e.g. submodules or unverified pointers).
 * - `null` when `dir` is not a git checkout.
 *
 * @param {string} dir
 * @returns {{ kind: 'repo' | 'worktree' | 'gitfile', gitDir: string, commonGitDir: string | null } | null}
 */
export function inspectGitCheckout(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return null;
  const gitEntry = join(dir, '.git');
  let stats;
  try {
    stats = lstatSync(gitEntry);
  } catch {
    return null;
  }
  if (stats.isDirectory()) {
    if (!existsSync(join(gitEntry, 'HEAD'))) return null;
    const realGitDir = canonicalizePath(gitEntry);
    return { kind: 'repo', gitDir: realGitDir, commonGitDir: realGitDir };
  }
  if (!stats.isFile() || stats.size > GITDIR_POINTER_MAX_BYTES) return null;
  let content;
  try {
    content = readFileSync(gitEntry, 'utf8');
  } catch {
    return null;
  }
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('gitdir:')) return null;
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const rawPtr = firstLine.slice('gitdir:'.length).trim();
  if (!rawPtr) return null;
  const resolvedGitDir = resolve(dir, rawPtr);

  try {
    const realGitDir = realpathSync(resolvedGitDir);
    const realDir = realpathSync(dir);
    const backRaw = readSmallRegularFile(join(realGitDir, 'gitdir'));
    const commonRaw = readSmallRegularFile(join(realGitDir, 'commondir'));
    if (backRaw && commonRaw) {
      const backTrimmed = backRaw.trim();
      const commonTrimmed = commonRaw.trim();
      if (backTrimmed && commonTrimmed) {
        const realBackDir = realpathSync(dirname(resolve(realGitDir, backTrimmed)));
        const realCommon = realpathSync(resolve(realGitDir, commonTrimmed));
        const realWorktrees = realpathSync(join(realCommon, 'worktrees'));
        const relWt = relative(realWorktrees, realGitDir);
        const underWorktrees = relWt !== '' && !relWt.startsWith('..') && !isAbsolute(relWt);
        if (realBackDir === realDir && underWorktrees && existsSync(join(realCommon, 'HEAD'))) {
          return { kind: 'worktree', gitDir: realGitDir, commonGitDir: realCommon };
        }
      }
    }
  } catch {
    // Fall through to syntactic gitfile classification.
  }

  return { kind: 'gitfile', gitDir: canonicalizePath(resolvedGitDir), commonGitDir: null };
}

/**
 * True iff `dir` contains a supported ADLC ticket store (sharded `.store.json`,
 * legacy `tickets.json`, or a relative `storeOverride`). Never matches a bare
 * `.adlc/` directory without a store file.
 *
 * @param {string} dir
 * @param {string | null} [storeOverride]
 * @returns {boolean}
 */
export function hasTicketStoreAt(dir, storeOverride = null) {
  if (typeof dir !== 'string' || !dir.trim()) return false;
  if (typeof storeOverride === 'string' && storeOverride.trim() && !isAbsolute(storeOverride)) {
    return existsSync(join(dir, storeOverride.trim()));
  }
  return (
    existsSync(join(dir, '.adlc', 'tickets', '.store.json')) ||
    existsSync(join(dir, '.adlc', 'tickets.json'))
  );
}

function hasExternalAbsoluteStore(storeOverride) {
  return (
    typeof storeOverride === 'string' &&
    storeOverride.trim().length > 0 &&
    isAbsolute(storeOverride.trim()) &&
    existsSync(storeOverride.trim())
  );
}

/**
 * Resolve the authoritative ADLC / git checkout root enclosing `startPath`.
 *
 * Security & worktree invariants enforced in one place:
 * 1. Verified nested git worktrees (`<repo>/.worktrees/<lane>` and deeper
 *    worktrees sharing the enclosing repo's `commonGitDir` with a verified
 *    `<commonGitDir>/worktrees/<entry>/gitdir` back-pointer) act as independent
 *    checkout roots and are NEVER captured by the outer repo.
 * 2. Forged subdirectory `.git` directories (`mkdir src/.git` + `HEAD`) or
 *    unverified `gitdir:` files inside an enclosing ADLC git repository do NOT
 *    release the enclosing repository's enforcement.
 * 3. Stray `$HOME/.adlc` directories or stores never capture unrelated
 *    checkouts below `$HOME` unless `$HOME` is the starting directory itself or
 *    `$HOME` is a real git checkout (dotfiles repo).
 * 4. Paths inside `pluginDir` return `null` so hooks spawned from an installed
 *    plugin cache never mistake the plugin directory for the user's workspace.
 *
 * @param {string} startPath
 * @param {{
 *   storeOverride?: string | null,
 *   homeDir?: string | null,
 *   pluginDir?: string | null,
 *   rememberedRoots?: { has(dir: string): boolean } | null,
 *   allowFileStart?: boolean,
 *   requireStore?: boolean,
 *   preserveSpelling?: boolean,
 * }} [options]
 * @returns {string | null}
 */
export function findInnermostCheckoutRoot(startPath, options = {}) {
  if (typeof startPath !== 'string' || !startPath.trim()) return null;
  const {
    storeOverride = null,
    homeDir = homedir(),
    pluginDir = null,
    rememberedRoots = null,
    allowFileStart = false,
    requireStore = true,
    preserveSpelling = false,
  } = options;

  let startLexical = resolve(startPath);
  if (allowFileStart) {
    try {
      if (!lstatSync(startLexical).isDirectory()) startLexical = dirname(startLexical);
    } catch {
      startLexical = dirname(startLexical);
    }
  }

  if (pluginDir && isPathInside(startLexical, pluginDir)) return null;

  const startCanonical = canonicalizePath(startLexical);
  const realHome = typeof homeDir === 'string' && homeDir.trim() ? canonicalizePath(homeDir) : null;
  const trimmedOverride = typeof storeOverride === 'string' && storeOverride.trim() ? storeOverride.trim() : null;
  const isExternalOverride = trimmedOverride !== null && isAbsolute(trimmedOverride);
  const perDirOverride = trimmedOverride !== null && !isExternalOverride ? trimmedOverride : null;

  /** @type {Array<{
   *   rawDir: string,
   *   dir: string,
   *   atHome: boolean,
   *   remembered: boolean,
   *   store: boolean,
   *   info: ReturnType<typeof inspectGitCheckout>,
   *   checkout: boolean,
   * }>} */
  const chain = [];
  let rawCur = startLexical;
  for (let depth = 0; depth < 256; depth += 1) {
    const canonicalCur = canonicalizePath(rawCur);
    const atHome = realHome !== null && canonicalCur === realHome;
    const rawInfo = inspectGitCheckout(canonicalCur);
    const examine = !atHome || canonicalCur === startCanonical || rawInfo !== null;
    const info = examine ? rawInfo : null;
    chain.push({
      rawDir: rawCur,
      dir: canonicalCur,
      atHome,
      remembered: rememberedRoots ? rememberedRoots.has(canonicalCur) : false,
      store: examine && !isExternalOverride ? hasTicketStoreAt(canonicalCur, perDirOverride) : false,
      info,
      checkout: info !== null,
    });
    const parent = dirname(rawCur);
    if (parent === rawCur || (atHome && !rememberedRoots)) break;
    rawCur = parent;
  }

  // Truncate at the innermost verified linked worktree whose commonGitDir
  // matches an enclosing checkout above it. Everything above that worktree is
  // an outer checkout (primary repo or parent worktree) and must not capture it.
  const nestedWorktreeIdx = chain.findIndex(
    (entry, idx) =>
      entry.info?.kind === 'worktree' &&
      entry.info.commonGitDir !== null &&
      chain.slice(idx + 1).some((anc) => anc.info?.commonGitDir === entry.info?.commonGitDir)
  );
  const effectiveChain = nestedWorktreeIdx >= 0 ? chain.slice(0, nestedWorktreeIdx + 1) : chain;

  // $HOME (even when a dotfiles git repo) never overrides a distinct git repo
  // cloned beneath $HOME; it only governs non-repo dotfiles paths beneath it.
  const adlcRepoAbove = effectiveChain.map(() => false);
  for (let i = effectiveChain.length - 2; i >= 0; i -= 1) {
    const above = effectiveChain[i + 1];
    adlcRepoAbove[i] = adlcRepoAbove[i + 1] || (!above.atHome && above.checkout && above.store);
  }

  let outermost = null;
  let checkoutRoot = null;
  let insideCheckout = true;
  for (let i = 0; i < effectiveChain.length; i += 1) {
    const link = effectiveChain[i];
    const picked = preserveSpelling ? link.rawDir : link.dir;
    if (link.remembered || (insideCheckout && link.store)) {
      outermost = picked;
    }
    if (insideCheckout && link.checkout) {
      checkoutRoot = picked;
      if (!adlcRepoAbove[i]) insideCheckout = false;
    }
  }

  if (outermost !== null) return outermost;

  if (hasExternalAbsoluteStore(storeOverride)) {
    return checkoutRoot ?? (preserveSpelling ? startLexical : startCanonical);
  }

  if (!requireStore) {
    return checkoutRoot;
  }

  return null;
}

/**
 * Given a static/session-level workspace root (`outerRoot`, such as
 * `CLAUDE_PROJECT_DIR`, `location.project.directory`, `workspacePaths[0]`, or
 * `AGY_WORKSPACE`) and dynamic path candidates (`input.cwd`, `absFile`,
 * `location.directory`, or non-plugin `process.cwd()`), return a verified nested
 * linked worktree root inside `outerRoot` when a dynamic candidate lies inside
 * one; otherwise keep `outerRoot`.
 *
 * @param {string | null | undefined} outerRoot
 * @param {readonly (string | null | undefined)[]} [dynamicCandidates]
 * @param {Parameters<typeof findInnermostCheckoutRoot>[1]} [options]
 * @returns {string | null}
 */
export function preferInnermostCheckout(outerRoot, dynamicCandidates = [], options = {}) {
  const hasOuter = typeof outerRoot === 'string' && outerRoot.trim().length > 0;
  if (!hasOuter) {
    for (const cand of dynamicCandidates) {
      if (typeof cand !== 'string' || !cand.trim()) continue;
      const resolved = findInnermostCheckoutRoot(cand, options);
      if (resolved) return resolved;
    }
    return null;
  }

  const trimmedOuter = outerRoot.trim();
  for (const cand of dynamicCandidates) {
    if (typeof cand !== 'string' || !cand.trim()) continue;
    if (!isPathInside(cand, trimmedOuter)) continue;
    const inner = findInnermostCheckoutRoot(cand, options);
    if (!inner) continue;
    if (!isPathInside(inner, trimmedOuter)) continue;
    if (canonicalizePath(inner) === canonicalizePath(trimmedOuter)) continue;
    if (inspectGitCheckout(inner)?.kind === 'worktree') {
      return inner;
    }
  }

  return options.preserveSpelling ? trimmedOuter : canonicalizePath(trimmedOuter);
}
