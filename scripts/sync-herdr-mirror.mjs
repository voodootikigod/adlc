#!/usr/bin/env node
// Sync the `adlc-herdr` herdr plugin from this monorepo (plugins/adlc-herdr/)
// into its flattened marketplace MIRROR repo (voodootikigod/adlc-herdr), where the
// plugin lives at the repo ROOT so herdr's marketplace (which indexes tagged repos
// at their root) can list and install it. Invoked by
// .github/workflows/sync-herdr-mirror.yml on a push to main that touches the
// plugin; the workflow checks out the mirror (write, via a deploy key) into a dir
// and runs `node scripts/sync-herdr-mirror.mjs <that-dir>`, then commits+pushes.
//
// This script does ONLY the file transform (pure, testable): mirror the plugin
// tree into the target, add the monorepo LICENSE, and rewrite the README (a
// "read-only mirror" banner + rewrite monorepo-relative links to absolute URLs so
// they don't 404 at the mirror). Git is the caller's job.
//
//   node scripts/sync-herdr-mirror.mjs <target-dir> [--repo-root <path>]
//
// Exit: 0 = synced · 1 = operational error (bad target, missing plugin, …).
import { existsSync, statSync, readdirSync, rmSync, cpSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_SUBDIR = 'plugins/adlc-herdr';
export const MONOREPO = 'voodootikigod/adlc';
export const MIRROR = 'voodootikigod/adlc-herdr';

// A "read-only mirror" banner prepended to the mirror's README so a visitor knows
// the source of truth is the monorepo and files issues/PRs there, not here.
export function mirrorBanner() {
  return [
    '> **Auto-synced, read-only mirror.** This repository mirrors the `adlc-herdr` herdr',
    `> plugin from the [\`${MONOREPO}\`](https://github.com/${MONOREPO}) monorepo`,
    `> (\`${PLUGIN_SUBDIR}/\`), flattened to the repo root so herdr's marketplace can list it.`,
    '> **Do not open issues or PRs here** — file them on the',
    `> [monorepo](https://github.com/${MONOREPO}/issues). Install:`,
    `> \`herdr plugin install ${MIRROR}\`.`,
    '',
    '',
  ].join('\n');
}

/**
 * Transform the plugin README for the mirror: prepend the banner and rewrite any
 * monorepo-relative link that escapes the plugin dir (`](../x)`, `](../../x)`, and
 * the reference-style form `[label]: ../x`) to an absolute blob URL on the monorepo
 * — such links would 404 at the mirror root. Already-absolute links and in-repo
 * links (`./x`) are left untouched. Pure.
 */
export function transformReadme(text) {
  const body = String(text)
    // inline links: [text](../path)
    .replace(
      /\]\((?:\.\.\/)+([^)]+)\)/g,
      `](https://github.com/${MONOREPO}/blob/main/$1)`,
    )
    // reference-style definitions: [label]: ../path  (preserve the whitespace,
    // and match only the URL token so an optional "title" after it is left alone)
    .replace(
      /\]:(\s*)(?:\.\.\/)+(\S+)/g,
      `]:$1https://github.com/${MONOREPO}/blob/main/$2`,
    );
  return mirrorBanner() + body;
}

// True when `inner` is the same path as, or nested inside, `outer` (both resolved
// to absolute). Uses path.relative so it never trips the string-prefix trap
// (`/a` vs `/ab`): a `..` segment or an absolute result means "not inside".
function isSameOrInside(inner, outer) {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Fail CLOSED on a target that doesn't look like a mirror checkout, so a wrong
// path can never be wiped: it must be an existing directory that is either empty
// or already a git repo (a `.git` entry), AND it must not overlap the source repo.
// The overlap guard is the important one: the sync CLEARS the target before
// copying, so a target that IS, contains, or sits inside `repoRoot` would delete
// the very tree we read from — e.g. `node sync-herdr-mirror.mjs .` run from the
// monorepo root would pass a naive `.git`-presence check (the monorepo has a
// `.git`) and then wipe the whole working tree. The CI workflow checks the
// monorepo and the mirror out into sibling dirs, so this guard never fires there.
function assertSafeTarget(targetDir, repoRoot) {
  if (!targetDir || typeof targetDir !== 'string') throw new Error('a target directory is required');
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) throw new Error(`target is not a directory: ${targetDir}`);
  // realpathSync (not just resolve) so the overlap check sees the TRUE path:
  // it canonicalizes case on case-insensitive filesystems (macOS/Windows, where
  // `/Repo` and `/repo` are one dir) and resolves symlinks (a target symlinked to
  // the source). A plain string compare would miss both and wipe the source.
  // Both paths exist here (target checked above, repoRoot holds the plugin), so
  // realpathSync cannot throw for a missing path.
  const absTarget = realpathSync(targetDir);
  const absRoot = realpathSync(repoRoot);
  if (isSameOrInside(absTarget, absRoot) || isSameOrInside(absRoot, absTarget)) {
    throw new Error(`refusing to sync into the source repo or an overlapping path: ${absTarget}`);
  }
  const entries = readdirSync(targetDir);
  if (entries.length > 0 && !entries.includes('.git')) {
    throw new Error(`refusing to sync into a non-empty, non-git directory: ${targetDir}`);
  }
}

// Fail CLOSED if the copied tree holds any symlink. Our plugin is only regular
// files/dirs, so a symlink is a tampering signal — and a dangerous one: the
// README transform (readFileSync/writeFileSync) FOLLOWS a symlink, so a README
// committed as a link to a runner file ($GITHUB_ENV, .git/config, …) would be
// overwritten THROUGH it; and any symlink shipped to the mirror could point
// anywhere on a cloner's disk. Reject rather than follow. `.git` (the mirror's
// own) is skipped. Dirent.isSymbolicLink() reports the entry without following it.
function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to sync a symlink (tampering signal): ${p}`);
    if (entry.isDirectory()) assertNoSymlinks(p);
  }
}

/**
 * Mirror the plugin tree into `targetDir` (flattened to its root): clear the
 * target (preserving only `.git`), copy the plugin contents, add the monorepo
 * LICENSE, and transform the README. Returns the list of top-level entries written.
 */
export function syncMirror({ repoRoot, targetDir }) {
  const pluginDir = join(repoRoot, PLUGIN_SUBDIR);
  // Fail CLOSED if the plugin is gone rather than auto-wiping the mirror. In CI
  // this point is only reached from a successful monorepo checkout, so a missing
  // plugin dir means it was deliberately removed from main — but emptying a
  // PUBLISHED marketplace artifact should be a hands-on decision, never an
  // automatic side effect of a missing dir (a partial checkout or a wrong
  // --repo-root would otherwise wipe the live plugin). The thrown error reds the
  // sync workflow, which is the intended signal to retire the mirror on purpose.
  if (!existsSync(pluginDir)) throw new Error(`plugin dir not found: ${pluginDir}`);
  assertSafeTarget(targetDir, repoRoot);

  // Clear everything except .git so files DELETED from the plugin are also removed
  // from the mirror (a plain copy would leave stale files behind).
  for (const entry of readdirSync(targetDir)) {
    if (entry === '.git') continue;
    rmSync(join(targetDir, entry), { recursive: true, force: true });
  }
  // Copy the plugin tree to the target root (bin/ and lib/ stay siblings, so the
  // plugin's `../lib/...` imports still resolve).
  cpSync(pluginDir, targetDir, { recursive: true });
  // Never carry a `.github/` into the mirror. A workflow file that ended up under
  // the plugin dir would otherwise be copied to the mirror root and — once the
  // deploy key pushes it — RUN in the mirror's own Actions context (e.g. on a
  // schedule), a lateral-movement path into the mirror repo. The mirror is a
  // read-only artifact: it must carry none of its own CI. Strip it unconditionally.
  rmSync(join(targetDir, '.github'), { recursive: true, force: true });
  // Carry the monorepo LICENSE over (the plugin dir has none of its own).
  const license = join(repoRoot, 'LICENSE');
  if (existsSync(license)) cpSync(license, join(targetDir, 'LICENSE'));
  // Reject any symlink in the FULLY-populated tree — plugin content AND the LICENSE
  // just copied — before we read/write through one below. This must run AFTER every
  // copy, so a symlinked monorepo LICENSE is caught too (not just plugin files);
  // nothing symlinked is ever shipped to the mirror or followed.
  assertNoSymlinks(targetDir);
  // Rewrite the README for the mirror.
  const readme = join(targetDir, 'README.md');
  if (existsSync(readme)) writeFileSync(readme, transformReadme(readFileSync(readme, 'utf8')));

  return readdirSync(targetDir).filter((e) => e !== '.git').sort();
}

function main(argv) {
  const args = argv.slice(2);
  const rootFlag = args.indexOf('--repo-root');
  const repoRoot = rootFlag !== -1 ? args[rootFlag + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  const repoRootValue = rootFlag !== -1 ? args[rootFlag + 1] : undefined;
  const target = args.find((a) => !a.startsWith('--') && a !== repoRootValue);
  try {
    const written = syncMirror({ repoRoot, targetDir: target });
    console.log(`synced ${PLUGIN_SUBDIR} → ${target} (${written.length} entries: ${written.join(', ')})`);
    process.exit(0);
  } catch (err) {
    console.error(`sync-herdr-mirror: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
