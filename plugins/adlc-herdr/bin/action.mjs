#!/usr/bin/env node
// [[actions]] dispatcher (t-herdr-3, plan §5.3). Thin glue over lib/actions:
// parse the probed context env, fetch live pane info for foreground_cwd,
// resolve the repo, plan, execute. Every failure path ends in a clear
// notification; nothing is ever spawned from an unresolved context.
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runHerdr, runHerdrJson, paneInfoArgs } from '../lib/herdr.mjs';
import { resolveRepoRoot, resolveOnPath } from '../lib/repo-root.mjs';
import { readActiveTicket } from '../lib/adlc-state.mjs';
import { parseContext, resolveTarget, planAction, gateNotification, notifyArgs } from '../lib/actions.mjs';

/**
 * The plugin's own installed location, derived from THIS file's import.meta.url
 * (stable and unspoofable regardless of process.cwd() or any host-supplied env
 * var) — the same pattern this plugin's own tests already use
 * (test/manifest.test.mjs, test/actions-phase2.test.mjs). `bin/` is one level
 * under the plugin root. Never read from an environment variable or a
 * cwd-relative default: a repository under inspection controls both
 * process.cwd() (via `cwd: repoRoot` on other action spawns) and any
 * host-supplied override — either would let a repo point the ticket-show
 * spawn at a file it ships instead of this plugin's real bin/show-ticket.mjs
 * (#833).
 */
export function resolvePluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function notify(title, body, sound = 'request') {
  return runHerdr(notifyArgs(title, body, sound));
}

function runGate(plan) {
  return new Promise((resolve) => {
    execFile(plan.argv[0], plan.argv.slice(1), { cwd: plan.cwd, timeout: 30_000, shell: false }, (_error, stdout) => {
      // exit 2 = gate fail: stdout still carries the JSON verdict
      const note = gateNotification(stdout ?? '', plan.echo);
      notify(note.title, note.body, note.sound).then(resolve);
    });
  });
}

async function main() {
  const actionId = process.env.HERDR_PLUGIN_ACTION_ID ?? '';
  const parsed = parseContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  if (!parsed.ok) {
    await notify('ADLC', `cannot act: ${parsed.reason}`);
    return;
  }
  const paneRes = await runHerdrJson(paneInfoArgs(parsed.ctx.focused_pane_id));
  const paneInfo = paneRes.ok ? paneRes.value?.result?.pane ?? null : null;
  const target = resolveTarget({ ctx: parsed.ctx, paneInfo, resolveRepoRoot });
  const active = target.ok ? readActiveTicket(target.repoRoot) : null;
  const plan = planAction(actionId, target, active, { pluginRoot: resolvePluginRoot() });

  if (plan.kind === 'refuse') {
    await notify(plan.title, plan.body, plan.sound);
    return;
  }
  if (plan.kind === 'gate') {
    await runGate(plan);
    return;
  }
  if (plan.kind === 'spawn-pane') {
    if (plan.requiresBin && !resolveOnPath(plan.requiresBin, process.env.PATH ?? '')) {
      await notify('ADLC', `cannot run ${actionId}: ${plan.requiresBin} not on PATH (${plan.echo})`);
      return;
    }
    await notify('ADLC', `starting ${actionId} — ${plan.echo}`, 'done'); // echo before acting
    await runHerdr(plan.herdrArgs, { timeoutMs: 15_000 });
    return;
  }
  await notify('ADLC', 'internal error: unhandled action plan');
}

/**
 * Whether this module is being run directly (`node action.mjs`) rather than
 * imported. A pure function of its two inputs so it is unit-testable without
 * spawning a process: `argv1` may legitimately be undefined (some invocation
 * modes never set it), in which case this must return false WITHOUT calling
 * pathToFileURL(undefined) — that throws. Exported so a test can assert the
 * short-circuit directly, rather than relying on process.argv[1] happening
 * to be truthy in every real invocation this repo's tests run under.
 */
export function isMainEntry(argv1, moduleUrl) {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}

/**
 * main()'s catch-all: this dispatcher is advisory (a UI action, not an
 * enforcing gate), so an unexpected internal error must never surface as a
 * nonzero process exit to the herdr host — exported so a test can assert the
 * exact exit code without needing to force a genuine rejection through
 * main()'s otherwise fail-soft call chain (runHerdr/notify never reject).
 */
export function handleMainFailure() {
  process.exit(0);
}

// Only run as a live hook when executed directly, not when imported (this
// test suite imports the module to reach resolvePluginRoot() without
// triggering a live herdr probe).
if (isMainEntry(process.argv[1], import.meta.url)) {
  main().catch(handleMainFailure);
}
