// Model-plane filesystem policy (spec §7.3; issue #395).
//
// The model-plane worker runs with network egress (K2 — it must reach its
// provider) but its WRITES are bounded to the ticket worktree plus the specific
// directories the configured harness needs for its own session state. Everything
// else the operator can write — the quartermaster registry, `~/.claude` settings
// and hooks, the installed toolkit, other repos' worktrees — is denied.
//
// The list is NARROW by construction: a harness's state DIRECTORY is granted, its
// config directory is not. `~/.claude/projects` is session scratch; `~/.claude`
// itself contains `settings.json` and `hooks/`, which decide what runs in the
// operator's NEXT session — granting the parent would let a worker escape its
// worktree by another door, and granting the parent *and* carving exceptions back
// out would make the boundary depend on which files happen to exist today.
//
// Two properties make an incomplete list safe:
//
//   1. It is an ALLOW-list. A path nobody thought of is DENIED, so an omission
//      surfaces as a harness that errors loudly, never as a hole that reopens
//      silently. `--model-plane-writable` is the operator-local escape hatch for
//      a harness this list has not caught up with.
//   2. Declared DIRECTORIES are created if absent, so a first run on a clean host
//      does not fail merely because the harness had not made its scratch dir yet.
//      Declared FILES are not created — a bind needs a real source — so a harness
//      whose state file does not exist yet fails loudly rather than silently
//      writing outside the boundary.
//
// Declarations are ADAPTER-OWNED (`homeState` in each adapter module, surfaced
// through the catalog) for the same reason `transports` and `aliases` are: the
// module that knows how to launch a harness is the module that knows where that
// harness keeps its state.

import { isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/** An adapter that declares nothing gets nothing — the fail-closed direction. */
export const EMPTY_HOME_STATE = Object.freeze({ dirs: Object.freeze([]), files: Object.freeze([]) });

export function homeStateOf(adapter) {
  const declared = adapter?.homeState;
  return {
    dirs: [...(declared?.dirs ?? [])],
    files: [...(declared?.files ?? [])],
  };
}

// A HOME-relative entry cannot be resolved without a HOME, and inventing one would
// grant a path the operator never has. Dropping it is the fail-closed direction:
// the harness gets no grant outside the worktree and says so loudly if it needed one.
const absolutize = (home, entry) => {
  if (isAbsolute(entry)) return entry;
  return home ? join(home, entry) : null;
};

/**
 * Resolve the model plane's writable path set for one dispatch.
 *
 * `exists`/`mkdirp` are injected so a unit test can describe a host without
 * touching one, and so the real call can FILTER: bubblewrap aborts on a bind whose
 * source is missing, so a declared file that this host's harness layout does not
 * use must be dropped rather than crash the run.
 *
 * @param adapters      the adapter modules in play for this dispatch. Every rung of
 *                      an escalation ladder contributes, because a ladder can move a
 *                      later strike onto a different harness mid-ticket — the same
 *                      reason provisioning covers every rung and not just the first (#401).
 * @param home          the operator's real HOME
 * @param tmpDir        the OS temp dir (a harness that cannot write a temp file cannot run)
 * @param extraWritable operator-local additions (`--model-plane-writable`)
 */
const add = (set, value) => { if (value) set.add(value); };

export function modelPlaneFilesystem({
  adapters = [], home, tmpDir, extraWritable = [], exists = existsSync, mkdirp = defaultMkdirp,
} = {}) {
  const dirs = new Set();
  const files = new Set();
  for (const adapter of adapters) {
    const state = homeStateOf(adapter);
    for (const d of state.dirs) add(dirs, absolutize(home, d));
    for (const f of state.files) add(files, absolutize(home, f));
  }
  for (const p of extraWritable) add(dirs, absolutize(home, p));
  if (tmpDir) dirs.add(tmpDir);

  const missingFiles = [...files].filter((f) => !exists(f));
  for (const d of dirs) if (!exists(d)) mkdirp(d);
  return {
    writablePaths: [...dirs, ...files].filter((p) => exists(p)),
    // Surfaced, not swallowed: a harness state file that does not exist is the one
    // shape of this policy that can make a previously-working run fail, so the
    // caller can say so instead of leaving the operator with an opaque harness error.
    missingStateFiles: missingFiles,
  };
}

function defaultMkdirp(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* a home we cannot create is one we cannot grant */ }
}
