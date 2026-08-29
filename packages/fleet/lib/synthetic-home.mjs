// Synthetic HOME construction for the bounded model plane (issue-autopilot spec
// §6.4 item 14 / §14; AC156).
//
// The worker's harness must find `$HOME/.claude/...` — so the synthetic HOME is
// mounted AT the host HOME path (a tmpfs over it; `bounded-model-plane.mjs` does
// the mounting). This module only STAGES what goes inside it, on the host, in a
// caller-owned staging directory:
//
//   credentials.json  a validated COPY of the host credential, bound READ-ONLY.
//                     There is NO write-back path in this module — nothing the
//                     worker writes is ever copied back; the copy dies with the
//                     tmpfs. (A test greps this source to keep it that way.)
//   settings.json     generated from an ALLOWLIST of host settings keys; `hooks`
//                     and `mcpServers` — what runs in the operator's next session —
//                     are stripped. Bound read-only.
//   claude.json       generated from an allowlist of the host `~/.claude.json`
//                     (account record + onboarding flags, never per-project
//                     history). Bound WRITABLE: the harness rewrites it on start.
//
// The adapter's `homeState.dirs` become EMPTY scratch dirs created inside the
// tmpfs by the argv builder; the operator's copies are never bound.
//
// Every fs primitive is injectable so the unit tests need no real credential file.

import {
  openSync, fstatSync, lstatSync, readFileSync, closeSync, writeFileSync, chmodSync, mkdirSync, statSync, existsSync,
  constants as fsConstants, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { homeStateOf } from './model-plane.mjs';

export const CREDENTIAL_FILE_MODE = 0o600;
export const CREDENTIAL_REL = '.claude/.credentials.json';
export const SETTINGS_REL = '.claude/settings.json';
export const PLUGINS_REL = '.claude/plugins';
export const CLAUDE_JSON_REL = '.claude.json';

/**
 * Host settings keys that may reach the worker: model and permission settings
 * (spec §9.3(ii)). `hooks`/`mcpServers` are NOT here, and neither is `env`: it is
 * a second channel into the worker's process environment that the ambient
 * scrubber never sees, so a host `settings.env` carrying ADLC_MANIFEST_KEY or
 * GH_TOKEN would re-enter the sandbox through the staged file.
 */
export const SETTINGS_KEYS = Object.freeze(['model', 'permissions', 'includeCoAuthoredBy', 'theme', 'verbose']);
/** Host `~/.claude.json` keys that may reach the worker: the account record and onboarding flags only. */
export const CLAUDE_JSON_KEYS = Object.freeze([
  'oauthAccount', 'hasCompletedOnboarding', 'userID', 'installMethod', 'autoUpdates', 'theme', 'numStartups', 'hasSeenTasksHint',
]);

const defaultFs = Object.freeze({
  openSync, fstatSync, readFileSync, closeSync, writeFileSync, chmodSync, mkdirSync, statSync, lstatSync, existsSync, rmSync, constants: fsConstants,
});

const isStrictAncestor = (root, path) => path !== root && path.startsWith(root + sep);

/**
 * Open the host credential with O_NOFOLLOW and validate it on the DESCRIPTOR
 * (regular file, owned by `uid`, mode exactly 0600) before reading a byte.
 * fstat on the opened fd, not stat on the path, so the checked inode is the one
 * read. Any failure → `credential-file-insecure: <reason>`; the file is never
 * copied.
 */
function readValidatedCredential(path, { uid, fs }) {
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw new Error(`credential-file-insecure: cannot open ${path} without following symlinks (${err.code ?? err.message})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`credential-file-insecure: ${path} is not a regular file`);
    if (st.uid !== uid) throw new Error(`credential-file-insecure: ${path} is owned by uid ${st.uid}, not ${uid}`);
    const mode = st.mode & 0o7777;
    if (mode !== CREDENTIAL_FILE_MODE) {
      throw new Error(`credential-file-insecure: ${path} has mode 0${mode.toString(8)}, expected 0600`);
    }
    return fs.readFileSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Parse a host JSON file into a plain object, or `{}` when absent. Malformed → throws (fail closed). */
function readJsonObject(path, fs) {
  if (!fs.existsSync(path)) return { present: false, value: {} };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (err) { throw new Error(`synthetic-home: ${path} is not valid JSON (${err.message})`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`synthetic-home: ${path} must hold a JSON object`);
  }
  return { present: true, value: parsed };
}

/** Keep only `keys` (a NEW object; the host document is never mutated). */
export function pickAllowlisted(doc, keys) {
  const kept = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(doc, k)) kept[k] = doc[k];
  const stripped = Object.keys(doc).filter((k) => !keys.includes(k));
  return { kept, stripped };
}

/** Write a staged file with an exact mode, even if a previous staging left one behind. */
function stage(fs, path, bytes, mode) {
  // A previous staging may have left a READ-ONLY (0400) file behind: opening it for writing
  // is EACCES, so the stale file goes first (agy fleet r4 c4). The staging dir is mkdtemp-fresh
  // per build in production; this keeps the documented re-staging contract true regardless.
  if (typeof fs.rmSync === 'function') fs.rmSync(path, { force: true });
  fs.writeFileSync(path, bytes, { mode });
  fs.chmodSync(path, mode);
}

function resolveScratchDir(home, entry) {
  const abs = isAbsolute(entry) ? resolve(entry) : join(home, entry);
  if (!isStrictAncestor(home, abs)) {
    throw new Error(`synthetic-home: scratch dir ${entry} does not resolve under ${home}`);
  }
  return abs;
}

/**
 * Stage the synthetic HOME for one dispatch.
 *
 * @returns {{ home, homeBinds, homeWritableFiles, homeScratchDirs, credentialSha256, settingsKeysKept, warnings, preparedAt }}
 *   `home` is the SAME absolute path as `hostHome` — the tmpfs is mounted over it.
 *   `homeBinds` is exactly three `{source, target}` read-only leaves, in the
 *   documented order: credential copy, settings copy, plugin tree.
 */
export function prepareSyntheticHome({
  hostHome, stagingDir, adapter, pluginsDir, uid = process.getuid(), fs = defaultFs, now = () => new Date(),
} = {}) {
  if (!hostHome || !isAbsolute(hostHome)) throw new Error('synthetic-home: hostHome must be an absolute path');
  if (!stagingDir || !isAbsolute(stagingDir)) throw new Error('synthetic-home: stagingDir must be an absolute path');
  const home = resolve(hostHome);
  const staging = resolve(stagingDir);
  const warnings = [];

  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });

  // (i) credential: validate on the fd, copy, hash. Read-only from here on.
  const hostCredential = join(home, CREDENTIAL_REL);
  const credentialBytes = readValidatedCredential(hostCredential, { uid, fs });
  const stagedCredential = join(staging, 'credentials.json');
  stage(fs, stagedCredential, credentialBytes, CREDENTIAL_FILE_MODE);
  const credentialSha256 = createHash('sha256').update(credentialBytes).digest('hex');

  // (ii) settings: allowlisted keys only, 0400.
  const settings = readJsonObject(join(home, SETTINGS_REL), fs);
  const { kept: settingsKept, stripped: settingsStripped } = pickAllowlisted(settings.value, SETTINGS_KEYS);
  if (settingsStripped.length) warnings.push(`settings.json: stripped keys ${settingsStripped.join(', ')}`);
  if (!settings.present) warnings.push('settings.json: host file absent; worker gets {}');
  const stagedSettings = join(staging, 'settings.json');
  stage(fs, stagedSettings, JSON.stringify(settingsKept, null, 2) + '\n', 0o400);

  // (iii) claude.json: allowlisted keys only, 0600, bound writable.
  const claudeJson = readJsonObject(join(home, CLAUDE_JSON_REL), fs);
  const { kept: claudeKept, stripped: claudeStripped } = pickAllowlisted(claudeJson.value, CLAUDE_JSON_KEYS);
  if (claudeStripped.length) warnings.push(`.claude.json: stripped keys ${claudeStripped.join(', ')}`);
  if (!claudeJson.present) warnings.push('.claude.json: host file absent; worker gets {}');
  const stagedClaudeJson = join(staging, 'claude.json');
  stage(fs, stagedClaudeJson, JSON.stringify(claudeKept, null, 2) + '\n', 0o600);

  // (iv) plugin tree: bound read-only when the host HAS one. A fresh install has no
  // ~/.claude/plugins at all — that is not an error, it is simply no bind (a missing bind
  // source would abort bwrap, so an absent tree is omitted rather than named; agy r2 c4).
  // Something present but not a directory (a file, a symlink) is still refused: lstat,
  // never stat — a symlink planted at the plugin path would bind an arbitrary directory
  // into the bounded plane (codex r4).
  const plugins = resolve(pluginsDir ?? join(home, PLUGINS_REL));
  let pluginsStat;
  try { pluginsStat = (fs.lstatSync ?? fs.statSync)(plugins); } catch { pluginsStat = null; }
  if (pluginsStat?.isSymbolicLink?.()) throw new Error(`synthetic-home: plugins dir ${plugins} is a symlink; refusing to bind its target`);
  if (pluginsStat && !pluginsStat.isDirectory()) throw new Error(`synthetic-home: plugins dir ${plugins} is not a directory`);
  const pluginBinds = pluginsStat ? [{ source: plugins, target: join(home, PLUGINS_REL) }] : [];

  // (v) scratch dirs: every declared entry, resolved under HOME, created empty by the argv builder.
  const homeScratchDirs = homeStateOf(adapter).dirs.map((d) => resolveScratchDir(home, d));

  return {
    home,
    homeBinds: [
      { source: stagedCredential, target: join(home, CREDENTIAL_REL) },
      { source: stagedSettings, target: join(home, SETTINGS_REL) },
      ...pluginBinds,
    ],
    homeWritableFiles: [{ source: stagedClaudeJson, target: join(home, CLAUDE_JSON_REL) }],
    homeScratchDirs,
    credentialSha256,
    settingsKeysKept: Object.keys(settingsKept),
    warnings,
    preparedAt: now().toISOString(),
  };
}
