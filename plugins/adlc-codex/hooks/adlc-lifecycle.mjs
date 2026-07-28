#!/usr/bin/env node
// KEEP IN SYNC — RISK_TIER_PATTERNS/matchRiskTier/classifyRiskTier/
// decideAdversarialReviewNotice below are a verbatim inline copy of
// packages/core/lib/risk-tier.mjs (that file's own header names this
// pattern: a hook script can't resolve npm packages from its installed
// location — same reason plugins/adlc-codex/hooks/adlc-build-gate.mjs
// inline-copies packages/build-gate). globMatch is the canonical tokenized
// implementation from packages/core/lib/tickets.mjs (NOT a naive replace-**
// chain — see the T49 fix in adlc-build-gate.mjs's own globMatch comment for
// why that matters for these `**/`-prefixed patterns specifically). The
// gitChangedPaths/stopReview shape below follows plugins/adlc-cursor/hooks/
// adlc-stop.mjs's stopAudit, which implements the same feature more cleanly
// than Claude Code's original (one function, -z NUL-delimited git parsing,
// no manual quote-unescaping). A drift test (hooks/test/review-notice.test.mjs)
// pins the inline copy against packages/core/lib/risk-tier.mjs's real exports.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadTicketStoreReadOnly } from './generated-ticket-reader.mjs';
import { readActiveTicketPointer, resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';

async function stdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function stateContext(root) {
  // Parse through the canonical pointer contract so this narration names the same
  // ticket the enforcing readers do (it used to hand-roll its own key list).
  //
  // Throw on a bad pointer rather than returning the reason as context: this hook's
  // established advisory contract is that malformed state surfaces through main()'s
  // catch as "could not complete" and still exits 0. The canonical message rides
  // along on the error, so the operator gets the specific reason either way.
  const pointer = readActiveTicketPointer(root);
  if (!pointer.ok) throw new Error(pointer.message);
  if (!pointer.value.present) return null;
  const id = pointer.value.id;
  const snapshot = loadTicketStoreReadOnly({ root, env: process.env });
  const ticket = snapshot.tickets.find((candidate) => candidate.id === id);
  if (!ticket) return `ADLC current ticket ${id} is not present in the ticket store.`;
  const rails = ticket.rails ?? [];
  const status = ticket.completed === true ? 'completed' : rails.length > 0 ? 'rail protection auto-active' : 'no rails declared';
  return `ADLC current ticket: ${id} — ${ticket.title}. Status: ${status}. Scope: ${(ticket.scope ?? []).join(', ') || '(none)'}. Treat .adlc/manifest.jsonl as gate truth; narration cannot pass a phase.`;
}

function hookOutput(event, context) {
  if (!context) return null;
  if (event === 'SessionStart' || event === 'SubagentStart') {
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: context,
      },
    };
  }
  return { systemMessage: context };
}

function responseText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? ''); } catch { return String(value); }
}

function flailOutput(payload, dataRoot) {
  const text = responseText(payload.tool_response ?? payload.toolResponse ?? payload.response ?? payload.result);
  if (!/(?:error|failed|exception|exit code [1-9]|status [1-9])/i.test(text)) return null;
  const signature = createHash('sha256').update(`${payload.tool_name ?? payload.toolName ?? 'tool'}\n${text.slice(0, 1000)}`).digest('hex');
  const statePath = join(dataRoot, 'flail-state.json');
  const previous = readJson(statePath) ?? {};
  const count = previous.signature === signature ? Number(previous.count ?? 0) + 1 : 1;
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ signature, count }, null, 2)}\n`);
  if (count < 3) return null;
  return { systemMessage: `ADLC flail advisory: the same tool failure has repeated ${count} times. Stop, isolate the cause, and run adlc flail-detector on the relevant log before retrying.` };
}

function verifyOutput(root) {
  if (!existsSync(join(root, '.adlc'))) return null;
  const command = process.env.ADLC_CLI_COMMAND ?? 'adlc';
  // --allow-legacy-unsigned tolerates a repo's honest pre-signing history
  // without weakening detection of real tampering — see
  // packages/gate-manifest/lib/verify.mjs.
  const result = spawnSync(command, ['gate-manifest', 'verify', '--json', '--allow-legacy-unsigned'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status === 0) return null;
  const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status ?? 1}`;
  return { systemMessage: `ADLC evidence advisory: gate-manifest verification did not pass (${detail}). This warning does not override deterministic phase gates.` };
}

// ---------------------------------------------------------------------------
// KEEP IN SYNC with packages/core/lib/risk-tier.mjs.
// ---------------------------------------------------------------------------

export const RISK_TIER_PATTERNS = Object.freeze({
  'auth-trust-boundary': Object.freeze([
    '**/auth/**', '**/authn/**', '**/authz/**', '**/oauth/**', '**/sso/**',
    '**/session/**', '**/login/**', '**/permissions/**', '**/rbac/**', '**/acl/**',
  ]),
  'security-control-deny-path': Object.freeze([
    '**/*guard*', '**/*validator*', '**/*validators*', '**/sandbox/**', '**/sandboxes/**',
    '**/middleware/**', '**/*deny-path*', '**/*policy*', '**/policies/**',
  ]),
  secrets: Object.freeze([
    '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
    '**/secrets/**', '**/secret/**', '**/*credentials*', '**/vault/**',
  ]),
  'data-loss-destructive': Object.freeze([
    '**/*delete*', '**/*destroy*', '**/*purge*', '**/*truncate*', '**/*wipe*',
    '**/*irreversible*',
  ]),
  'schema-migration': Object.freeze([
    '**/migrations/**', '**/migrate/**', '**/*.sql', '**/schema.*', '**/*.prisma',
  ]),
  'ci-cd-supply-chain': Object.freeze([
    '.github/workflows/**', '**/Dockerfile', '**/Dockerfile.*', '**/docker-compose*.yml',
    '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
    '**/requirements*.txt', '**/Gemfile*', '**/go.sum', '**/go.mod', '**/Cargo.lock',
    '.circleci/**', '.gitlab-ci.yml',
  ]),
});

// KEEP IN SYNC with @adlc/core's globMatch (packages/core/lib/tickets.mjs).
// Tokenized like the canonical implementation — see the T49 fix in
// adlc-build-gate.mjs's own globMatch for why a naive replace-** chain is
// wrong for these `**/`-prefixed patterns.
export function globMatch(pattern, path) {
  const regex = new RegExp(
    '^' +
      pattern
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) => {
          if (part === '**/') return '(?:.*/)?';
          if (part === '**') return '.*';
          if (part === '*') return '[^/]*';
          return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('') +
      '$',
  );
  return regex.test(path);
}

export function matchRiskTier(path) {
  const norm = String(path).split('\\').join('/');
  for (const [tier, patterns] of Object.entries(RISK_TIER_PATTERNS)) {
    for (const pattern of patterns) {
      if (globMatch(pattern, norm)) return { tier, pattern };
    }
  }
  return null;
}

export function classifyRiskTier(paths) {
  const matches = [];
  for (const path of paths ?? []) {
    const hit = matchRiskTier(path);
    if (hit) matches.push({ path, ...hit });
  }
  return { gated: matches.length > 0, matches };
}

function filesOverlapOrUnscoped(entry, matches) {
  const files = entry && entry.files;
  if (!files || typeof files !== 'object') return true;
  const recorded = Object.keys(files);
  if (recorded.length === 0) return true;
  const gatedPaths = new Set(matches.map((m) => m.path));
  return recorded.some((p) => gatedPaths.has(p));
}

export function decideAdversarialReviewNotice({ changedPaths = [], manifestEntries = [], ticketId = null } = {}) {
  const { gated, matches } = classifyRiskTier(changedPaths);
  if (!gated) return { needed: false, matches: [] };
  const hasRecord = (manifestEntries ?? []).some(
    (e) =>
      e &&
      e.gate === 'adversarial-review' &&
      (!ticketId || !e.ticket || e.ticket === ticketId) &&
      filesOverlapOrUnscoped(e, matches),
  );
  return { needed: !hasRecord, matches };
}

// ---------------------------------------------------------------------------
// gitChangedPaths / stopReview — shape follows plugins/adlc-cursor/hooks/
// adlc-stop.mjs's gitChangedPaths/stopAudit (not Claude Code's original,
// which manually unquotes non -z porcelain output — the -z NUL-delimited
// form needs no unquoting and is what Cursor's proven implementation uses).
// ---------------------------------------------------------------------------

/** Generic spawn-and-normalize, for ANY binary (git, adlc, ...) — mirrors
 * plugins/adlc-cursor/hooks/adlc-stop.mjs's run(). Exported for tests. */
export function run(spawnImpl, bin, args, cwd) {
  try {
    const r = spawnImpl(bin, args, { cwd, encoding: 'utf8' });
    return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err), error: err };
  }
}

export function gitChangedPaths(root, { spawnImpl = spawnSync, base } = {}) {
  const paths = new Set();

  const status = run(spawnImpl, 'git', ['status', '--porcelain', '--no-renames', '-z'], root);
  if (!status.error && status.status === 0 && status.stdout) {
    for (const rec of status.stdout.split('\0')) {
      const p = rec.slice(3).trim();
      if (p) paths.add(p);
    }
  }

  const untracked = run(spawnImpl, 'git', ['ls-files', '--others', '--exclude-standard', '-z'], root);
  if (!untracked.error && untracked.status === 0 && untracked.stdout) {
    for (const p of untracked.stdout.split('\0')) if (p.trim()) paths.add(p.trim());
  }

  const baseCandidates = base ? [base] : ['main', 'master', 'origin/main', 'origin/master'];
  for (const c of baseCandidates) {
    const exists = run(spawnImpl, 'git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], root);
    if (exists.error || exists.status !== 0) continue;
    const mergeBase = run(spawnImpl, 'git', ['merge-base', c, 'HEAD'], root);
    if (mergeBase.error || mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
    const diff = run(spawnImpl, 'git', ['diff', '--name-only', '-z', mergeBase.stdout.trim(), '--'], root);
    if (!diff.error && diff.status === 0 && diff.stdout) {
      for (const p of diff.stdout.split('\0')) if (p.trim()) paths.add(p.trim());
    }
    break;
  }

  return [...paths];
}

/**
 * Advisory active-ticket resolution through the canonical pointer contract
 * (generated-active-ticket.mjs) — not a hand-parse. Unlike the enforcing hooks
 * (rails-guard, build-gate), any failure here (malformed pointer, conflict)
 * degrades to null rather than failing the Stop hook — an advisory notice
 * must never crash the session's end.
 */
export function resolveActiveTicketIdAdvisory(root, env = process.env) {
  const resolved = resolveActiveTicketIdCanonical({ root, env });
  if (!resolved.ok) return null; // advisory: degrade rather than block
  return resolved.value?.id ?? null;
}

/**
 * The Stop-time review notice. Advisory only — never throws, never blocks.
 * Returns { skipped, warning } where warning is a string or null.
 */
export function stopReview(root, { spawnImpl = spawnSync, env = process.env, base } = {}) {
  if (!existsSync(join(root, '.adlc'))) return { skipped: true, warning: null };

  const changed = gitChangedPaths(root, { spawnImpl, base });
  if (changed.length === 0) return { skipped: false, warning: null };

  const { gated } = classifyRiskTier(changed);
  if (!gated) return { skipped: false, warning: null };

  const ticketId = resolveActiveTicketIdAdvisory(root, env);

  let manifestEntries = [];
  const manifestPath = join(root, '.adlc', 'manifest.jsonl');
  if (existsSync(manifestPath)) {
    const command = env.ADLC_CLI_COMMAND ?? 'adlc';
    const show = run(spawnImpl, command, ['gate-manifest', 'show', '--json'], root);
    if (!show.error && show.status === 0 && show.stdout) {
      try {
        const parsed = JSON.parse(show.stdout);
        if (Array.isArray(parsed.entries)) manifestEntries = parsed.entries;
      } catch { /* unparseable → no provable entries */ }
    }
  }

  const decision = decideAdversarialReviewNotice({ changedPaths: changed, manifestEntries, ticketId });
  if (!decision.needed) return { skipped: false, warning: null };

  const tiers = [...new Set(decision.matches.map((m) => m.tier))].join(', ');
  const sample = decision.matches.slice(0, 3).map((m) => m.path).join(', ');
  const warning =
    `ADLC adversarial-review: this change touches a risk-gated path (${tiers}: ${sample}` +
    `${decision.matches.length > 3 ? ', …' : ''}) with no adversarial-review gate-manifest record` +
    `${ticketId ? ` for ticket ${ticketId}` : ''}. Run \`npx adversarial-review\` and record the verdict via ` +
    `\`adlc gate-manifest record adversarial-review --files '<paths>' ` +
    `--data '{"providers":"<a,b>","verdict":"<approve|needs-attention>","exitReason":"<clean|no-progress|ceiling>"}'\` before merging.`;

  return { skipped: false, warning };
}

function reviewOutput(root) {
  const { warning } = stopReview(root, { env: process.env });
  return warning ? { systemMessage: warning } : null;
}

async function main() {
  const mode = process.argv[2] ?? 'context';
  const payload = await stdinJson();
  const root = resolve(payload.cwd ?? process.cwd());
  const event = payload.hook_event_name ?? payload.hookEventName ?? 'SessionStart';
  let output;
  if (mode === 'context') output = hookOutput(event, stateContext(root));
  else if (mode === 'flail') output = flailOutput(payload, process.env.PLUGIN_DATA ?? join(root, '.adlc/.plugin-data'));
  else if (mode === 'verify') output = verifyOutput(root);
  else if (mode === 'review') output = reviewOutput(root);
  else throw new Error(`unknown lifecycle mode: ${mode}`);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

// Only run as a hook when executed directly (`node adlc-lifecycle.mjs <mode>`),
// not when imported — the drift test imports this module for its pure
// exports (classifyRiskTier, stopReview, ...) and must not trigger a live
// stdin read.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ systemMessage: `ADLC advisory hook could not complete: ${error.message}` })}\n`);
    process.exitCode = 0;
  });
}
