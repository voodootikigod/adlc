// `adlc-autopilot init [--labels] [--service] [--write]` (spec §9.1c, §9.4a,
// §9.5, §9.3a, §10). Idempotent. Without `--write` it only prints what it would
// do (labels are the exception: `--labels` creates them, since a label is not a
// file on this machine and the loop fails closed without them).
//
// `--write` creates, under REPO_ROOT and never outside it:
//   - the `.git/info/exclude` entries for the autopilot's gitignored state;
//   - the network repository NET_GIT from the fixed template;
//   - `.adlc/autopilot-known_hosts` from `gh api meta` of the pinned host;
// and, with `--service --write`, the systemd unit under the user's config dir
// (the ONE write outside the repo, and only on explicit request).

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EXCLUDE_ENTRIES } from './paths.mjs';
import { writeNetGit } from './git-env.mjs';
import { renderUnit, defaultUnitPath, installInstructions, ServiceError } from './service.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['init.writeOutsideRepo']);

/** The `.git/info/exclude` entries, appended once (idempotent). Returns { added: [] }. */
export function ensureExcludeEntries(repoRoot, { write }) {
  const p = join(repoRoot, '.git', 'info', 'exclude');
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const lines = cur.split('\n');
  const missing = EXCLUDE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length && write) {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, (cur === '' || cur.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n');
  }
  return { added: missing, present: EXCLUDE_ENTRIES.filter((e) => lines.includes(e)) };
}

/** known_hosts text from `gh api meta` (`ssh_keys[]`) for exactly `host`. */
export function knownHostsFromMeta(meta, host) {
  const keys = Array.isArray(meta?.ssh_keys) ? meta.ssh_keys : [];
  if (keys.length === 0) throw new Error('gh api meta returned no ssh_keys');
  return keys.map((k) => `${host} ${String(k).trim()}`).join('\n') + '\n';
}

/**
 * @param opts.ctx      needs paths, gh (for labels/meta), remote (pinned URLs), ssh (wrapper path for NET_GIT), env.home
 * @param opts.labels   create the eight labels idempotently (ensureLabels from lib/labels.mjs via ctx.modules.labels)
 * @param opts.service  render the unit
 * @param opts.write    actually write files
 */
export async function initCommand({ ctx, labels = false, service = false, write = false }) {
  const out = { ok: true, wrote: [], wouldWrite: [], text: '' };
  const lines = [];
  const plan = (path, what) => { (write ? out.wrote : out.wouldWrite).push(path); lines.push(`${write ? 'wrote' : 'would write'} ${path} (${what})`); };

  // 1. exclude entries (repo-local, never .gitignore).
  const ex = ensureExcludeEntries(ctx.repoRoot, { write });
  if (ex.added.length) plan(join(ctx.repoRoot, '.git', 'info', 'exclude'), `exclude entries: ${ex.added.join(', ')}`);

  // 2. NET_GIT from the template (needs the pinned URLs and the wrapper path from phase A).
  if (ctx.remote && ctx.ssh?.wrapperPath) {
    if (write) {
      const { configSha256 } = writeNetGit({ netGit: ctx.paths.netGit, repoRoot: ctx.repoRoot, remoteFetchUrl: ctx.remote.remoteFetchUrl, remotePushUrl: ctx.remote.remotePushUrl, sshWrapperPath: ctx.ssh.wrapperPath });
      ctx.status?.write?.({ netGitConfigSha256: configSha256 });
      out.netGitConfigSha256 = configSha256;
    }
    plan(ctx.paths.netGit, 'network repository');
  } else {
    lines.push('skipped NET_GIT: remote identity / SSH material not resolved (run phase A first)');
  }

  // 3. known_hosts from gh api meta of the pinned host.
  if (ctx.gh && ctx.remote) {
    const meta = await ctx.gh.json(['api', 'meta']);
    const text = knownHostsFromMeta(meta, ctx.remote.host);
    if (write) { writeFileSync(ctx.paths.knownHosts, text, { mode: 0o600 }); }
    plan(ctx.paths.knownHosts, `known_hosts for ${ctx.remote.host}`);
  }

  // 4. labels (created on request even without --write: they are not files here).
  if (labels && ctx.gh) {
    const r = await ctx.modules.labels.ensureLabels(ctx.gh);
    out.labels = r;
    lines.push(`labels: ${r.created?.length ? `created ${r.created.join(', ')}` : 'all present'}`);
  }

  // 5. the unit.
  if (service) {
    const nodePath = ctx.pinned.node ?? process.execPath;
    const binPath = join(ctx.repoRoot, 'packages', 'autopilot', 'bin', 'adlc-autopilot.mjs');
    let unit;
    try {
      unit = renderUnit({ repoRoot: ctx.repoRoot, nodePath, binPath, repo: ctx.local.repo, sshIdentity: ctx.local.sshIdentity ?? null, sshAuthSock: ctx.local.sshIdentity ? null : (ctx.env.raw?.SSH_AUTH_SOCK ?? null) });
    } catch (e) { if (e instanceof ServiceError) { out.ok = false; out.code = e.code; out.exitCode = 1; out.text = `init --service: ${e.message}`; return out; } throw e; }
    const unitPath = defaultUnitPath(ctx.env.home);
    out.unit = unit;
    lines.push(unit, installInstructions({ unitPath }));
    if (write) {
      // The ONE write outside REPO_ROOT, and only because --service --write asked for it.
      if (!active('init.writeOutsideRepo') && !unitPath.startsWith(ctx.env.home + '/')) throw new Error(`refusing to write the unit outside HOME: ${unitPath}`);
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, unit, { mode: 0o644 });
      out.wrote.push(unitPath);
    } else {
      out.wouldWrite.push(unitPath);
    }
  }
  out.text = lines.join('\n');
  return out;
}

/** Preflight's exclude check (§10): every entry must be present, else `exclude-missing`. */
export function excludeEntriesPresent(repoRoot) {
  const p = join(repoRoot, '.git', 'info', 'exclude');
  if (!existsSync(p)) return { ok: false, missing: [...EXCLUDE_ENTRIES] };
  const lines = readFileSync(p, 'utf8').split('\n');
  const missing = EXCLUDE_ENTRIES.filter((e) => !lines.includes(e));
  return { ok: missing.length === 0, missing };
}

export { statSync };
