// hollow-test/lib/watchdog.mjs
//
// Runs one test command and guarantees that when THIS process is told to stop,
// nothing the command started keeps running.
//
// Why a separate process: runner.mjs drives trials with spawnSync, which has no
// hook at its timeout — it signals its direct child and returns. Before this,
// that child was `/bin/sh -c <cmd>`; the shell died and `node --test`, its file
// workers and whatever the suite spawned lived on as orphans, still running the
// mutant. On 2026-10-08 a pile of them took a host down.
//
// Why not `detached: true` + a process-group kill: `detached` calls setsid(), so
// the suite leaves the terminal's foreground group. Ctrl-C then reaches only
// hollow-test, which is blocked in spawnSync and cannot act until the trial
// ends; an operator who escalates to kill -9 strands the suite — the same
// orphan class, reopened on the interrupt path. The watchdog keeps the suite in
// the caller's own process group and session, so Ctrl-C still stops everything
// at once, and on SIGTERM/SIGHUP it ends the suite's whole descendant tree.
//
// How the tree is ended — freeze, then kill. A snapshot-and-kill has two holes:
// a process forked after the snapshot is missed, and once its parent is dead
// the kernel reparents it to init, outside any later walk of the tree. So the
// victims are SIGSTOPped first, root outward (a stopped process cannot fork),
// and re-collected until the stopped set is stable; only then is everything
// SIGKILLed. Stopped parents stay alive during the walk, so nothing can escape
// by reparenting. Parent links come from /proc on Linux — no fork, so this
// works on exactly the memory-starved host the incident happened on — and from
// a time-boxed `ps` elsewhere. If links cannot be read at all, the shell alone
// is killed and the degradation is said out loud on stderr.
//
// Who counts as a victim: the shell's live descendants, PLUS (Linux) every
// process whose environment still carries the marker the shell was started
// with. A helper the suite double-forked or detached earlier in the trial was
// reparented to init long before the timeout and is no descendant any more,
// but it inherited the marker. A process that scrubs its own environment, or
// one on a platform without readable /proc, escapes this sweep; see README.
//
// When the sweep runs: on SIGTERM/SIGHUP (the timeout), on SIGINT (Ctrl-C),
// when the parent dies, and whenever the shell exits on its own — a crashed
// `node --test` must not leave a worker behind any more than a timeout may.
//
// Who watches the watchdog: it polls its parent pid. If hollow-test is killed
// outright (kill -9, its own caller's timeout), the parent changes and the
// watchdog ends the tree and exits on its own instead of being stranded with
// a runaway suite and nobody left to kill it.
//
// Usage (internal): node --input-type=module -e <this source> -- <shell command>
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as osConstants } from 'node:os';
import { appendFileSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

// Where a line goes: to the report file the runner named, if any — spawnSync
// closes its pipes the instant its timeout fires, so anything said after the
// SIGTERM would never reach the caller through stderr; the runner reads the
// file back and relays it. Otherwise to stderr, synchronously: process.stderr
// is asynchronous on a pipe and this process kills itself right after it speaks.
const REPORT = process.env.HOLLOW_TEST_WATCHDOG_REPORT;
function say(line) {
  try {
    if (REPORT) appendFileSync(REPORT, `${line}\n`);
    else writeSync(2, `${line}\n`);
  } catch { /* nothing left to say it to */ }
}

const parent = process.ppid;
// Launched by runner.mjs as `node --input-type=module -e <this source> -- <cmd>`,
// so the command is the last argument (argv[1]); run as a file it is argv[2].
const command = process.argv.length >= 2 ? process.argv[process.argv.length - 1] : undefined;
if (!command) {
  say('watchdog: a shell command is required');
  process.exit(1);
}

const MARKER = 'HOLLOW_TEST_WATCHDOG';
// A chain, not a value: a nested hollow-test (this repo gates its own suite)
// must not relabel the subtree so the OUTER sweep loses a helper the inner
// trial detached. Every watchdog above us stays in the list.
// Each link is pid:token, not a bare pid: a marker outlives its watchdog when
// that watchdog was itself SIGKILLed before sweeping, and once pids wrap a
// later watchdog with the recycled pid must not take the stray as its own.
const token = `${process.pid}:${randomBytes(4).toString('hex')}`;
const inherited = process.env[MARKER];
const chain = inherited ? `${inherited},${token}` : token;
const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit', env: { ...process.env, [MARKER]: chain } });

/** [pid, ppid] for every live process, or null if that cannot be learned. */
function parentLinks() {
  try {
    if (process.platform === 'linux') return procLinks();
    return psLinks();
  } catch (err) {
    say(`watchdog: cannot enumerate processes (${err.code ?? err.message}); killing only the shell`);
    return null;
  }
}

function procLinks() {
  const links = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = readFileSync(`/proc/${name}/stat`, 'latin1'); } catch { continue; } // raced with exit
    // "pid (comm) state ppid ..." — comm may contain spaces and parens, so split after the LAST ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]);
    if (Number.isInteger(ppid)) links.push([Number(name), ppid]);
  }
  return links;
}

function psLinks() {
  return execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid));
}

/** Every live descendant of `root`, root-outward, from parent links. */
function descendantsOf(root, links) {
  const children = new Map();
  for (const [pid, ppid] of links) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const seen = new Set([root]); // a snapshot taken over time can contain a cycle; never loop on one
  const queue = [root];
  while (queue.length) {
    for (const pid of children.get(queue.shift()) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

function signal(pid, sig) {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/** Linux only: pids (other than ours) whose environment marker chain carries our pid:token. */
function markedProcesses(deadline = Infinity) {
  if (process.platform !== 'linux') return [];
  const prefix = `${MARKER}=`;
  const me = token;
  const found = [];
  let names;
  try { names = readdirSync('/proc'); } catch (err) {
    say(`watchdog: cannot list /proc (${err.code ?? err.message}); marker sweep skipped`);
    return found;
  }
  for (const name of names) {
    if (Date.now() > deadline) {
      // Reading another process's environ can block on page-in on a swapping
      // host, and spawnSync never escalates past us: stop scanning, kill what
      // is known, say so.
      say('watchdog: marker sweep ran out of time; some detached helper may remain');
      break;
    }
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let environ;
    try { environ = readFileSync(`/proc/${name}/environ`, 'latin1'); } catch { continue; } // gone, or not ours
    const entry = environ.split('\0').find((e) => e.startsWith(prefix));
    if (entry && entry.slice(prefix.length).split(',').includes(me)) found.push(Number(name));
  }
  return found;
}

/**
 * The current victim set: root first, then descendants, then marked strays.
 * On the exit path the shell is already reaped and its pid is free — a new
 * same-uid process may own it — so neither it nor "its" descendants are
 * touched; only the marker sweep (Linux) can still name what the shell left.
 */
function victims({ rootAlive, deadline }) {
  const set = new Set();
  if (rootAlive) {
    set.add(child.pid);
    const links = parentLinks();
    if (links) for (const pid of descendantsOf(child.pid, links)) set.add(pid);
  }
  for (const pid of markedProcesses(deadline)) set.add(pid);
  return [...set];
}

const MAX_FREEZE_ROUNDS = 8;
// The whole freeze phase is bounded too: spawnSync has already fired its timeout
// and never escalates, so a slow `ps` on a loaded non-Linux host must not turn
// eight rounds into forty seconds past the trial's own limit.
const FREEZE_BUDGET_MS = 5000;

function killTree({ rootAlive = true } = {}) {
  // Everything ever SIGSTOPped is SIGKILLed, not just the last round's set: an
  // enumeration that shrinks between rounds (ps timing out, /proc unreadable
  // under the very pressure this exists for) must not leave a process frozen
  // forever, holding its memory, invisible as a descendant.
  const stopped = new Set();
  let previous = 0;
  const deadline = Date.now() + FREEZE_BUDGET_MS;
  for (let round = 0; round < MAX_FREEZE_ROUNDS && Date.now() < deadline; round++) {
    let now;
    try { now = victims({ rootAlive, deadline }); } catch (err) {
      say(`watchdog: victim collection failed (${err.code ?? err.message}); killing what was found so far`);
      break;
    }
    for (const pid of now) { signal(pid, 'SIGSTOP'); stopped.add(pid); }
    if (stopped.size === previous) break; // nothing new appeared: the set is stable
    previous = stopped.size;
  }
  if (stopped.size === 0 && rootAlive) stopped.add(child.pid);
  for (const pid of stopped) signal(pid, 'SIGKILL');
  // Say what was ended beyond the shell itself: a daemon the suite detached
  // and relied on next time, or a wrong victim, must not vanish without a line.
  const others = [...stopped].filter((pid) => pid !== child.pid);
  if (others.length) {
    const shown = others.slice(0, 10).join(', ') + (others.length > 10 ? `, … (${others.length} total)` : '');
    say(`watchdog: ended ${others.length} process(es) the suite left running: ${shown}`);
  }
}

// The runner reads the report back and deletes it — when it is still there.
// When our parent is gone (killed outright, or a handler-less caller taken by
// the same Ctrl-C), nothing ever will, and a file per interrupted trial in
// tmpdir is a leak this repo has been bitten by before. Drop it ourselves.
function dropReportIfUnread() {
  if (!REPORT || process.ppid === parent) return;
  try { unlinkSync(REPORT); } catch { /* never written, or already gone */ }
}

// Parent watch: hollow-test is blocked in spawnSync and has no way to forward
// its own death. Poll its pid; when it changes, our parent is gone.
const PARENT_POLL_MS = 250;
setInterval(() => {
  if (process.ppid === parent) return;
  killTree();
  dropReportIfUnread();
  process.exit(1);
}, PARENT_POLL_MS).unref();

function stopOn(sig) {
  process.on(sig, () => {
    killTree();
    dropReportIfUnread();
    // Die by the same signal so the caller sees exactly what it sent
    // (spawnSync's timeout path reads `signal === 'SIGTERM'`).
    dieBy(sig);
  });
}

// Die by `sig` so the caller sees exactly what it sent — and if node ignores
// or owns that signal (SIGPIPE, SIGUSR1), do not sit here until the trial's
// timeout: exit with the conventional 128+n instead.
function dieBy(sig) {
  process.removeAllListeners(sig);
  process.kill(process.pid, sig);
  setTimeout(() => process.exit(128 + (osConstants.signals[sig] ?? 0)), 50).unref();
}
stopOn('SIGTERM');
stopOn('SIGHUP');
// SIGINT too: it reaches the whole foreground group, but a POSIX shell starts
// `&` jobs with SIGINT ignored, so a helper started as `server & npm test`
// would shrug it off. The sweep does not ask.
stopOn('SIGINT');

child.on('error', (err) => {
  say(`watchdog: could not start /bin/sh: ${err.message}`);
  process.exit(127);
});
child.on('exit', (code, sig) => {
  // The shell is gone; whatever it left behind — a worker still running after
  // `node --test` crashed, a helper the suite backgrounded, the SIGABRT a heap
  // cap provokes — is swept here, or the crash path would strand exactly what
  // the timeout path ends. Nothing the suite started may outlive the trial.
  // The shell is reaped by now: its pid is nobody's to signal (see victims).
  killTree({ rootAlive: false });
  dropReportIfUnread();
  if (sig) {
    dieBy(sig);
    return;
  }
  process.exit(code ?? 1);
});
