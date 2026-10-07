#!/usr/bin/env node
// opencode-live-prosecute.mjs — T33 AC2/AC3: drive the SHIPPED adlc_prosecute
// tool's execute() end-to-end through the real plugin wiring, with a
// real-shaped v2 `ctx.session` scripting the lens/verifier child sessions.
//
// Why a scripted session rather than the real opencode binary: a full
// multi-lens, multi-round prosecution loop driven by a mock PROVIDER inside
// opencode is non-deterministic and fragile. This proof instead loads the real
// plugins/adlc-opencode/index.mjs, runs its v2 `setup(ctx)`, takes the tool the
// plugin adds through `ctx.tool.transform` exactly as the host would, and
// exercises its execute() against the v2 session API (create → prompt → wait →
// context) — proving the deterministic loop, the WRITE-DISABLED child sessions
// (AC2), and seeded-defect convergence (AC3) through first-party code.
// Registration/advertisement on the real binary is covered by
// scripts/opencode-live-tool.mjs.
//
// Exit codes: 0 = pass, 1 = fail.

import { LENS_READ_TOOLS } from '../plugins/adlc-opencode/lib/prosecute-runner.mjs';
import { ALL_AGENTS } from '../plugins/adlc-opencode/lib/prosecutor.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_INDEX = join(REPO, 'plugins', 'adlc-opencode', 'index.mjs');
const log = (m) => console.log(`opencode-live-prosecute: ${m}`);
const fail = (m) => { console.error(`opencode-live-prosecute: FAIL — ${m}`); process.exit(1); };

const fenced = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';

// The v2 permission evaluation the host applies to a child session: the agent's
// rules, then the session's; the LAST matching rule wins; nothing matching
// means "ask". A lens agent that allows everything is the case to beat.
const ALLOW_ALL_AGENT = [{ action: '*', resource: '*', effect: 'allow' }];
const glob = (pattern, value) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
const effectFor = (rules, action) => rules.findLast((r) => glob(r.action, action) && glob(r.resource, '*'))?.effect ?? 'ask';

// A real-shaped v2 session API: records every child create/prompt and scripts
// lens findings + a confirming verifier verdict. Like OpenCode 2.x, a child
// answers on the model it was CREATED with — naming an agent alone does not
// select that agent's model (a child created without one reports no model).
const creates = [];
const prompts = [];
const childAgent = new Map();
const childModel = new Map();
const replies = new Map();
const agentModel = (agent) => ({ providerID: 'live', id: `model-for-${agent}` });
const session = {
  create: async (req) => {
    creates.push(req);
    const id = `ses_child_${creates.length}`;
    childAgent.set(id, req.agent);
    childModel.set(id, req.model);
    return { id };
  },
  prompt: async (req) => {
    prompts.push(req);
    const reply = childAgent.get(req.sessionID) === 'prosecutor-verifier'
      ? fenced({ real: true, reason: 'reproduced the seeded off-by-one' })
      : fenced([{ title: 'seeded-off-by-one', severity: 'high', file: 'src/loop.mjs', detail: 'i <= n should be i < n' }]);
    replies.set(req.sessionID, reply);
    return { id: `inbox_${prompts.length}` };
  },
  wait: async () => {},
  context: async ({ sessionID }) => [{
    type: 'assistant', agent: childAgent.get(sessionID) ?? 'build', model: childModel.get(sessionID),
    content: [{ type: 'text', text: replies.get(sessionID) }],
  }],
};
// `ctx.agent` as v2 exposes it: list() → AgentListOutput { location, data: AgentInfo[] }.
const agent = {
  list: async () => ({ data: ALL_AGENTS.map((id) => ({ id, name: id, model: agentModel(id), mode: 'subagent', hidden: false, permissions: [] })) }),
};

// A git repo with a seeded defect on a branch, so the tool's own diff capture runs.
const dir = mkdtempSync(join(tmpdir(), 'oc-live-prosecute-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
try {
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'loop.mjs'), 'export const sum = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s; };\n');
  git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'change');
  writeFileSync(join(dir, 'loop.mjs'), 'export const sum = (n) => { let s = 0; for (let i = 0; i <= n; i++) s += i; return s; };\n');
  git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed off-by-one');

  const plugin = (await import(pathToFileURL(PLUGIN_INDEX).href)).default;
  if (plugin?.id !== 'adlc' || typeof plugin.setup !== 'function') fail('plugin entry is not a v2 { id: "adlc", setup } definition');
  const added = new Map();
  const registration = { dispose() {} };
  const domain = { hook: async () => registration };
  const cleanup = await plugin.setup({
    location: { directory: dir, project: { id: 'live', directory: dir, canonical: dir } },
    options: {},
    session: { ...domain, ...session },
    agent,
    permission: domain,
    tool: {
      ...domain,
      transform: async (cb) => { cb({ add: (t) => added.set(t.name, t), update() {}, remove() {}, list: () => [], get() {}, namespace() {} }); return registration; },
    },
  });
  const tool = added.get('adlc_prosecute');
  if (typeof tool?.execute !== 'function') fail('setup did not add an adlc_prosecute tool with an execute()');
  log('adlc_prosecute added by setup through ctx.tool.transform');

  const result = await tool.execute({ base: 'main' }, { sessionID: 'live', agent: 'build', messageID: 'msg', id: 'call' });
  if (typeof cleanup === 'function') cleanup();

  // AC3: the seeded defect surfaces and the loop terminates with a NO-SHIP verdict.
  const meta = result?.metadata ?? {};
  if (meta.deterministic !== true) fail(`runner did not report a deterministic run: ${JSON.stringify(result)}`);
  if (meta.confirmed < 1) fail('the seeded defect did not survive to a confirmed finding');
  if (meta.unverified !== 0) fail('the verifier did not verifiably confirm the seeded defect (kept only fail-closed)');
  if (!/NO-SHIP/.test(meta.verdict)) fail(`expected NO-SHIP, got ${meta.verdict}`);
  if (!/seeded-off-by-one/.test(String(result.content))) fail('the seeded finding is not in the report');
  if (meta.rounds < 1 || meta.hitBound === 'maxSessions') fail(`loop did not terminate cleanly (rounds=${meta.rounds}, bound=${meta.hitBound})`);
  log(`seeded defect converged: ${meta.verdict} in ${meta.rounds} round(s), ${meta.sessionsUsed} child session(s)`);

  // AC2: EVERY child session was created FAIL-CLOSED. Evaluate its permission
  // rules the way the host does: read-only tools allowed; write, patch, shell,
  // sub-agent and an unknown/future tool all denied.
  if (creates.length === 0) fail('no child sessions were spawned');
  for (const c of creates) {
    if (!Array.isArray(c?.permissions) || c.permissions.length === 0) fail(`child session created without permission rules: ${JSON.stringify(c)}`);
    const rules = [...ALLOW_ALL_AGENT, ...c.permissions];
    for (const t of LENS_READ_TOOLS) {
      if (effectFor(rules, t) !== 'allow') fail(`read-only tool "${t}" should be allowed in a lens session`);
    }
    for (const t of ['edit', 'write', 'patch', 'shell', 'subagent', 'execute', 'a_future_write_tool_xyz']) {
      if (effectFor(rules, t) !== 'deny') fail(`tool "${t}" must be denied in a lens session (got ${effectFor(rules, t)})`);
    }
    if (c?.location?.directory !== dir) fail(`child session not rooted at the project: ${JSON.stringify(c?.location)}`);
  }
  log(`all ${creates.length} lens/verifier child sessions were fail-closed (read-only allowlist over a wildcard deny) (AC2)`);

  // Per-lens models: every child is created AS its lens/verifier agent, so
  // OpenCode resolves that agent's configured model, while the authoritative
  // packaged charter still leads every prompt.
  const named = new Set(creates.map((c) => c?.agent));
  for (const a of ALL_AGENTS) {
    if (!named.has(a)) fail(`no child session created as ${a} (it would inherit the session model)`);
  }
  for (const p of prompts) {
    if (!/\n\n---\n\n/.test(p?.text ?? '') || p.text.startsWith('Prosecute this change')) fail(`child prompt for ${p?.sessionID} missing the authoritative packaged charter`);
  }
  for (const a of ALL_AGENTS) {
    const got = meta.models?.[a];
    if (JSON.stringify(got) !== JSON.stringify([`live/model-for-${a}`])) fail(`report does not attribute ${a} to its own model: ${JSON.stringify(got)}`);
  }
  if (meta.singleModel !== false || (meta.unregisteredAgents ?? []).length !== 0) fail(`unexpected reviewer-model summary: ${JSON.stringify(meta)}`);
  log(`every lens and the verifier ran as its own agent with the packaged charter (${ALL_AGENTS.length} agents) — per-lens models apply`);

  // The loop ran in FIRST-PARTY code (the tool's execute drove it) — not the host
  // model orchestrating — which is the whole point of the deterministic runner.
  log('PASS — deterministic P5 loop drove seeded-defect convergence over write-disabled sessions');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
