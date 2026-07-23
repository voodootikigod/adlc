#!/usr/bin/env node
// [[actions]] dispatcher (t-herdr-3, plan §5.3). Thin glue over lib/actions:
// parse the probed context env, fetch live pane info for foreground_cwd,
// resolve the repo, plan, execute. Every failure path ends in a clear
// notification; nothing is ever spawned from an unresolved context.
import { execFile } from 'node:child_process';
import { runHerdr, runHerdrJson, paneInfoArgs } from '../lib/herdr.mjs';
import { resolveRepoRoot, resolveOnPath } from '../lib/repo-root.mjs';
import { readActiveTicket } from '../lib/adlc-state.mjs';
import { parseContext, resolveTarget, planAction, gateNotification, notifyArgs } from '../lib/actions.mjs';

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
  const plan = planAction(actionId, target, active, { pluginRoot: process.env.HERDR_PLUGIN_ROOT ?? '.' });

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

main().catch(() => process.exit(0));
