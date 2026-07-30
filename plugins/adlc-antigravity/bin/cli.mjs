#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, cpSync, renameSync, rmSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'install';

/** The directory name agy will adopt for the installed plugin. */
const PLUGIN_NAME = 'adlc-antigravity';

/**
 * Wall-clock bound on every agy subprocess.
 *
 * spawnSync with no timeout waits forever. A wedged agy — deadlocked, blocked on
 * a prompt, waiting on a dead network mount — would hang the helper with no
 * failure path and no cleanup: the staging directory survives for the lifetime of
 * the hang, and any automation invoking this waits indefinitely.
 *
 * Settable because 120s is a judgement call, not a fact: a cold cache on slow
 * storage can legitimately exceed it, and an operator who hits that needs a knob,
 * not a patch.
 *
 * An unusable value is REJECTED, not quietly replaced by the default. Both ways
 * of getting this wrong disable the protection outright rather than shortening
 * it — spawnSync treats `0` as "no timeout", and `Infinity` is not a duration at
 * all — so silently substituting the default would leave an operator believing a
 * bound they set is in force when the hang it exists to stop is back.
 */
const AGY_TIMEOUT_DEFAULT_MS = 120_000;

function resolveAgyTimeoutMs(configured) {
  if (configured === undefined || configured === '') return AGY_TIMEOUT_DEFAULT_MS;
  const raw = Number(configured);
  if (!Number.isFinite(raw) || raw <= 0) {
    console.error(
      `ADLC_AGY_TIMEOUT_MS must be a positive, finite number of milliseconds; got "${configured}".`,
    );
    process.exit(1);
  }
  return raw;
}

const AGY_TIMEOUT_MS = resolveAgyTimeoutMs(process.env.ADLC_AGY_TIMEOUT_MS);

/** Grace between SIGTERM and SIGKILL. */
const AGY_GRACE_MS = 2_000;

/** Children currently running, and staging dirs to remove if we are interrupted. */
const activeChildren = new Set();
const activeStages = new Set();

/**
 * Signal a child's whole PROCESS GROUP, falling back to the child alone.
 *
 * Negative PID targets the group. The fallback covers a group that is already
 * gone (ESRCH) or a platform that refuses the form, so a kill failure can never
 * turn a bound into an unhandled throw.
 */
function signalPidGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function signalGroup(child, signal) {
  signalPidGroup(child.pid, signal);
}

/**
 * Forward Ctrl-C (and SIGTERM) to agy's process group before exiting.
 *
 * agy is spawned DETACHED so the timeout can bound its whole tree — and that same
 * detachment means the terminal's Ctrl-C never reaches it: the signal goes to our
 * foreground group only. Without this, Ctrl-C returns the user's prompt while agy
 * carries on rewriting ~/.gemini/config/plugins behind them, and a retry races an
 * install they believe they cancelled. The staging `finally` does not run either,
 * because the default disposition terminates us outright.
 */
let interruptSignal = null;

/**
 * Exit status for a failed install: 128+signo when we were CANCELLED, 1 otherwise.
 *
 * Forwarding Ctrl-C makes agy die, which the normal control flow then reports as
 * an ordinary install failure and exits 1 — so a cancelled install looked
 * identical to a broken one, and the interrupt handler's own exit was unreachable
 * because that path got there first. Automation needs to tell "the user stopped
 * this" from "this does not work".
 */
function failureExitStatus() {
  if (!interruptSignal) return 1;
  return interruptSignal === 'SIGINT' ? 130 : 143;
}

/**
 * Exit, but never before cancellation has finished escalating.
 *
 * Every exit that follows a runBounded() await goes through here. Forwarding
 * Ctrl-C makes agy die, which the normal control flow reports as an ordinary
 * failure and exits — cancelling the pending group SIGKILL and leaving a
 * SIGTERM-ignoring worker alive. Routing all of them through one function is
 * deliberate: this bug has now appeared in three separate exit paths because each
 * was patched individually.
 */
async function exitAfterCancellation(code) {
  if (cancellationDone) await cancellationDone;
  process.exit(code);
}

let shuttingDown = false;
/** Resolves once cancellation has escalated and cleaned up; awaited before exiting. */
let cancellationDone = null;

function onInterrupt(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  interruptSignal = signal;

  // SNAPSHOT the process groups NOW, by pid.
  //
  // activeChildren is mutable and a child is removed from it the moment it exits.
  // A group leader that handles SIGTERM exits promptly, so re-reading the set after
  // the grace period would find it empty and SIGKILL nothing — leaving a
  // SIGTERM-ignoring worker alive to keep rewriting the plugin directory while a
  // retry races it. This is the same leader-exits/worker-survives hazard the
  // timeout path already handles, and it has to be handled here too.
  const groups = [...activeChildren].map((child) => child.pid);
  for (const pid of groups) signalPidGroup(pid, 'SIGTERM');

  cancellationDone = new Promise((resolveCancellation) => {
    // NOT unref'd: this timer is what keeps the process alive long enough to
    // finish escalating. Letting the event loop drain first would exit with the
    // worker still running.
    setTimeout(() => {
      for (const pid of groups) signalPidGroup(pid, 'SIGKILL');
      for (const stage of activeStages) {
        try {
          rmSync(stage, { recursive: true, force: true });
        } catch {
          // best effort — we are on our way out
        }
      }
      resolveCancellation();
    }, AGY_GRACE_MS);
  });

  // Exit here once escalation completes, in case the main flow has already
  // finished and nothing is waiting on it.
  cancellationDone.then(() => process.exit(failureExitStatus()));
}
process.on('SIGINT', () => onInterrupt('SIGINT'));
process.on('SIGTERM', () => onInterrupt('SIGTERM'));

/**
 * Run a command under a HARD wall-clock bound.
 *
 * SIGTERM first, so agy can unwind a partially-written plugin directory rather
 * than being torn down mid-copy — then SIGKILL after a grace period, so the bound
 * is actually a bound.
 *
 * Both halves are necessary, and spawnSync can provide only one of them: it takes
 * a single killSignal and, with SIGTERM, does NOT regain control when its timeout
 * elapses — it waits for a child that may never leave. Measured directly: a child
 * trapping SIGTERM against a 300ms timeout returned after 6147ms with SIGTERM and
 * 303ms with SIGKILL. So SIGKILL alone risks a half-replaced install, SIGTERM
 * alone is not a bound, and getting both requires async process control.
 *
 * Waits on 'exit', not 'close', and inherits or discards stdio rather than piping
 * it. 'close' waits for the stdio streams to reach EOF, which a GRANDCHILD can
 * hold open long after the child is gone — a stub that runs `sleep` kept the bound
 * from ever firing, so the very hang this guards against reappeared through the
 * plumbing. Nothing here reads the child's output, so there is no reason to own a
 * pipe at all.
 *
 * @returns {Promise<{status: number | null, error?: Error}>}
 */
function runBounded(command, args, { inherit = false } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      // detached: true puts agy in its OWN PROCESS GROUP so the whole tree can be
      // signalled. Signalling just the child PID bounds only the process we
      // spawned: an agy that forks a worker leaves that worker running after the
      // timeout, holding inherited descriptors and outliving the staging directory
      // it was reading from.
      child = spawn(command, args, { stdio: inherit ? 'inherit' : 'ignore', detached: true });
    } catch (error) {
      resolvePromise({ status: null, error });
      return;
    }
    activeChildren.add(child);

    let timedOut = false;
    let killTimer;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      activeChildren.delete(child);
      resolvePromise(result);
    };

    const termTimer = setTimeout(() => {
      timedOut = true;
      signalGroup(child, 'SIGTERM');
      // Escalation is deliberately NOT cancelled by the leader exiting. A group
      // leader that handles SIGTERM promptly can exit while a worker ignores it;
      // clearing this timer on the leader's exit would resolve the promise and
      // delete the staging directory with that worker still running against it.
      // So the timeout path always waits for the group SIGKILL before settling.
      killTimer = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        settle({
          status: null,
          error: new Error(
            `timed out after ${AGY_TIMEOUT_MS}ms` +
              ' — raise the bound with ADLC_AGY_TIMEOUT_MS=<milliseconds> if this install is legitimately slow',
          ),
        });
      }, AGY_GRACE_MS);
    }, AGY_TIMEOUT_MS);

    child.on('error', (error) => settle({ status: null, error }));
    child.on('exit', (code) => {
      // Waits on 'exit', not 'close': 'close' waits for stdio EOF, which a
      // GRANDCHILD holds open long after the child is gone. Nothing here reads the
      // child's output, so there is no pipe to own.
      // Neither a TIMEOUT nor a CANCELLATION may be settled by the leader's exit.
      //
      // An interrupt does not set timedOut, so this used to let a leader that exits
      // on forwarded SIGTERM settle the promise — the caller then ran its `finally`
      // and DELETED THE STAGING DIRECTORY while a SIGTERM-ignoring worker was still
      // copying out of it, two seconds before escalation reached it. A worker
      // watching its source vanish mid-copy is how a half-written plugin happens.
      //
      // In both cases the escalation path owns settling: it SIGKILLs the group
      // first, then removes staging, then exits.
      if (timedOut || shuttingDown) return;
      settle({ status: code });
    });
  });
}

/**
 * Resolve `agy` to an ABSOLUTE path, ignoring npm-injected bin directories.
 *
 * `npx @adlc/antigravity@latest install` runs through npm exec, which prepends
 * the CURRENT PROJECT's `node_modules/.bin` to the child PATH. A repository that
 * ships a dependency or workspace exposing a bin named `agy` therefore gets its
 * binary executed by this helper the moment it probes `agy --version` — the same
 * local-shadowing attack the `@latest` pin closes for the helper itself, one
 * process level deeper. Verified reproducible: a planted bin ran as `agy`.
 *
 * Dropping npm's bin directories cannot hide a legitimate install: agy is a
 * standalone binary that lives on the real PATH, not an npm package.
 *
 * Only a bare `agy` is looked for, deliberately — no `agy.exe`. This integration
 * is POSIX-only in session (see "Platform notes" in docs/integrations/
 * antigravity.md), so a Windows candidate would be an untested branch supporting
 * a platform the plugin does not claim. Add it together with a Windows test if
 * that ever changes.
 *
 * @returns {string | null} absolute path to agy, or null when it is not present.
 */
function resolveAgyBin() {
  const npmInjected = join('node_modules', '.bin');
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    // RELATIVE PATH entries are refused outright. `join('.', 'agy')` is `agy` and
    // `join('bin', 'agy')` is `bin/agy` — both resolve against the CURRENT
    // DIRECTORY, so a PATH containing `.` or a project-relative bin dir lets a
    // repository supply the executable this function exists to distrust. An
    // absolute path is the whole point of resolving here rather than letting
    // spawn search PATH.
    if (!isAbsolute(dir)) continue;
    const normalized = dir.replace(/[\\/]+$/, '');
    if (normalized.endsWith(npmInjected) || normalized.endsWith('node-gyp-bin')) continue;
    const candidate = join(dir, 'agy');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

/**
 * Run `agy plugin install` against a copy of the plugin placed under a path
 * containing no `@`.
 *
 * agy resolves its target as `plugin@marketplace` BEFORE deciding whether it is
 * a filesystem path, so an `@` ANYWHERE in the argument is taken as that
 * separator. Every location npm gives a scoped package has one: handed
 * `.../node_modules/@adlc/antigravity` directly, agy reports
 * `unknown marketplace: adlc/antigravity` and never looks at the disk.
 *
 * Staging is safe because agy COPIES the directory into
 * `~/.gemini/config/plugins/<name>/` — the installed plugin does not keep a
 * reference to the source, so the staging directory is disposable.
 *
 * @param {string} sourceDir Plugin directory to install from.
 * @param {string} agyBin Absolute path to agy, from resolveAgyBin().
 * @returns {number | null} agy's exit status, or null if staging failed.
 */
async function agyInstallFromStagedCopy(sourceDir, agyBin) {
  // ONE cleanup site, in `finally`. An earlier shape cleaned up in both a catch
  // (staging failed) and a finally (install finished), and the catch copy was
  // unreachable from any test that does not contrive a filesystem failure — so
  // it was two mutable lines with no observer. Collapsing the two paths means
  // every success-path test also exercises the cleanup.
  let stage;
  try {
    // os.tmpdir() honours TMPDIR, which is NOT guaranteed to be @-free — a
    // TMPDIR of /var/tmp/user@example.com would stage under a path carrying the
    // exact character this whole function exists to avoid. Fall back to /tmp,
    // which cannot contain one; if that is unusable, fail loudly rather than
    // handing agy an argument it is certain to misparse.
    let root = tmpdir();
    if (root.includes('@')) root = '/tmp';
    stage = mkdtempSync(join(root, 'adlc-agy-'));
    activeStages.add(stage);
    if (stage.includes('@')) {
      throw new Error(`no @-free temporary directory available (tried ${root})`);
    }
    cpSync(sourceDir, join(stage, PLUGIN_NAME), { recursive: true });
    const result = await runBounded(agyBin, ['plugin', 'install', join(stage, PLUGIN_NAME)], {
      inherit: true,
    });
    if (result.error) {
      // Includes the timeout case. Distinguished from a plain non-zero exit:
      // agy printed nothing useful, so say what actually happened.
      console.error(`\`agy plugin install\` did not complete: ${result.error.message}`);
      return null;
    }
    return result.status;
  } catch (err) {
    console.error(`Failed to stage the plugin for agy: ${err.message}`);
    return null;
  } finally {
    if (stage) {
      activeStages.delete(stage);
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`
ADLC Google Antigravity Plugin Helper

Usage:
  adlc-agy install     Install when @adlc/antigravity is installed globally
  adlc-agy --help      Display this help message

  Recommended one-liner (neutral cwd keeps a hostile repo's .npmrc and
  node_modules out of the resolution):
    (cd "$(mktemp -d)" && npx @adlc/antigravity@latest install)

  Note: "npx adlc-agy" does NOT work — adlc-agy is a bin name, not a package
  name, so npx would look for an unpublished package by that name.

Environment:
  ADLC_AGY_TIMEOUT_MS   Wall-clock bound on each agy subprocess, in
                        milliseconds. Default 120000. Must be a positive,
                        finite number; anything else is refused rather than
                        silently ignored. Raise it if agy is legitimately slow
                        (cold cache, network-mounted storage).

Description:
  Registers the @adlc/antigravity plugin with Google Antigravity (agy).
  First attempts to run \`agy plugin install <path>\`. If agy is not found,
  copies the plugin to ~/.gemini/config/plugins/adlc-antigravity.
`);
  process.exit(0);
}

if (command === 'install' || command === '--install') {
  console.log(`Installing @adlc/antigravity plugin from: ${packageRoot}`);

  // Resolved ONCE to an absolute path, with npm's injected bin dirs excluded, and
  // reused for both calls — so a repo-local `agy` cannot hijack either one.
  //
  // The direct copy below is reached ONLY when agy is genuinely absent
  // (resolveAgyBin returned null). A PRESENT agy that misbehaves — a failed
  // version probe, or a rejected install — is a hard failure. Treating a broken
  // agy as an absent one would route straight back into the copy-and-report-
  // success path that the fail-closed branch exists to remove.
  const agyBin = resolveAgyBin();
  if (agyBin) {
    const probe = await runBounded(agyBin, ['--version']);
    if (probe.status !== 0) {
      console.error(`Found agy at ${agyBin}, but \`agy --version\` failed${probe.error ? `: ${probe.error.message}` : ` (exit ${probe.status})`}.`);
      console.error('Not falling back to a direct copy: an agy this broken cannot register the plugin.');
      await exitAfterCancellation(failureExitStatus());
    }

    console.log('Google Antigravity (agy) detected. Running agy plugin install...');
    const status = await agyInstallFromStagedCopy(packageRoot, agyBin);
    if (status === 0) {
      console.log('✓ Successfully installed @adlc/antigravity plugin via agy!');
      // Still awaits cancellation: a status of 0 means agy finished BEFORE the
      // signal was processed, so 0 is truthful — but any group we signalled must
      // still be reaped before we go.
      await exitAfterCancellation(0);
    }
    // FAIL CLOSED when agy is PRESENT and still refused the plugin.
    //
    // The direct copy below exists for a machine with no agy at all — it drops
    // the files where agy would look. Using it to paper over a rejection by an
    // agy that IS installed reports success for an install the authoritative
    // installer declined: a manifest or compatibility error becomes a plugin that
    // was never registered, with the cause buried in scrollback and the exit
    // status saying 0. Automation reading that status cannot tell the difference.
    console.error(
      status === null
        ? '`agy plugin install` did not complete — see the reason above.'
        : `\`agy plugin install\` failed (exit ${status}); see agy's output above.`,
    );
    console.error('Not falling back to a direct copy: agy is installed and rejected this plugin.');
    // A cancelled install must not exit before escalation has finished killing the
    // group — otherwise the worker outlives us and races the user's retry.
    await exitAfterCancellation(failureExitStatus());
  }

  // Fallback for a machine with NO agy: place the files where agy would look.
  //
  // No process group to reap here: this branch is reached only when
  // resolveAgyBin() returned null, so no subprocess was ever spawned.
  //
  // CORRECTION to an earlier version of this comment, which claimed the interrupt
  // handler "races" the success exit. It does not. cpSync and renameSync are
  // SYNCHRONOUS, so the JavaScript stack never yields and Node cannot dispatch a
  // queued SIGINT callback at all while the copy is in flight — there is no race,
  // the handler simply does not run. Ctrl-C during a slow copy is therefore not
  // honoured until the call returns. Making it so would mean rebuilding this path
  // on async fs; that is not done here, because the copy targets a SIBLING
  // `incoming` directory and the live install is untouched until the renames, so
  // the worst case is a stale sibling that the next run removes unconditionally.
  //
  // What IS fixed: a cancellation queued during the copy no longer loses to the
  // success exit. Yielding once before exiting lets the handler run, so a user who
  // pressed Ctrl-C gets 130 rather than a success report.
  //
  // NOT COVERED BY A TEST, deliberately. Exercising it means landing a signal inside
  // a synchronous copy, so whether the test proves anything depends on whether the
  // copy is still running — which is disk speed. A version of it passed on macOS and
  // failed on CI's faster disk, where the copy finished first and the process exited
  // 0. A test whose verdict depends on the machine is worse than an honest gap, so
  // this is recorded here instead of pinned by something that flakes.
  const pluginsDir = join(homedir(), '.gemini', 'config', 'plugins');
  const targetDir = join(pluginsDir, PLUGIN_NAME);

  console.log(`Copying plugin files directly to ${targetDir}...`);
  // BUILD, THEN SWAP. The live directory is not touched until a complete copy
  // exists beside it, and the old one is kept until the swap succeeds.
  //
  // REPLACE rather than merge: cpSync over an existing directory only overwrites
  // files still present in the SOURCE, so an upgrade strands every skill, agent,
  // command and hook a later version DELETED — and agy loads whatever sits there,
  // so a retired hook keeps firing from a plugin reporting the new version.
  // Replacing is also what makes rollback necessary: an interrupted or failed
  // copy must not leave the user with no plugin at all.
  //
  // Building beside the target before touching it also makes the SELF-REINSTALL
  // case correct for free — `node ~/.gemini/.../bin/cli.mjs install` with no agy
  // on PATH has packageRoot === targetDir, and a delete-then-copy would erase the
  // very files it was copying from. An explicit source===target guard was written
  // for that and then removed: the swap already handles it, so the guard was an
  // unreachable branch no test could distinguish.
  const incoming = `${targetDir}.incoming-${process.pid}`;
  const previous = `${targetDir}.previous-${process.pid}`;
  let movedAside = false;
  try {
    mkdirSync(pluginsDir, { recursive: true });
    rmSync(incoming, { recursive: true, force: true });
    cpSync(packageRoot, incoming, { recursive: true });
    if (existsSync(targetDir)) {
      renameSync(targetDir, previous);
      movedAside = true;
    }
    renameSync(incoming, targetDir);
    if (movedAside) rmSync(previous, { recursive: true, force: true });
    console.log(`✓ Plugin copied to ${targetDir}`);
    console.log('Note: Run `/adlc-init` inside your agent session to complete setup.');
    // Yield so a SIGINT queued during the synchronous copy is dispatched before we
    // claim success. If the user cancelled, onInterrupt now runs and exits 130.
    await new Promise((resolveTick) => setImmediate(resolveTick));
    await exitAfterCancellation(interruptSignal ? failureExitStatus() : 0);
  } catch (err) {
    rmSync(incoming, { recursive: true, force: true });
    if (movedAside && !existsSync(targetDir)) renameSync(previous, targetDir);
    console.error(`Failed to copy plugin files to ${targetDir}:`, err.message);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  // Points at the already-running binary rather than repeating an npx one-liner:
  // whoever sees this is executing this file, so re-deriving the package through
  // npm resolution would be pointless AND a second place for the neutral-cwd and
  // version-spec controls to drift out of sync (they already had).
  console.error('Run `adlc-agy --help` for available commands.');
  process.exit(1);
}
