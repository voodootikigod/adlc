// shell-advisory.test.mjs — T18 AC5: the beforeShellExecution hook emits an
// advisory on a command that obviously targets a frozen rail / trust root, is
// silent on a benign command, and NEVER denies (permission is always allow).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adviseShell, extractCommand } from '../hooks/adlc-shell-advisory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'hooks', 'adlc-shell-advisory.mjs');

function fixture({ tickets = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-shell-'));
  if (tickets) {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
  }
  return root;
}
const cleanup = (root) => rmSync(root, { recursive: true, force: true });

const RAILED = [{ id: 'T1', title: 'one', rails: ['src/frozen.js', 'packages/gate/**'] }];
const env = (over = {}) => ({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ...over });

test('ADVISORY fires on an obvious write to an active-ticket rail', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const v = adviseShell({ command: "sed -i 's/a/b/' src/frozen.js" }, { root, env: env() });
    assert.equal(v.permission, 'allow', 'the advisory must NEVER deny');
    assert.match(v.agent_message, /CI/, 'must remind that the CI gate catches rail edits regardless');
    assert.match(v.agent_message, /src\/frozen\.js/);
  } finally { cleanup(root); }
});

test('ADVISORY fires on a redirection / rm targeting the trust roots', () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const cmd of [
      'echo "{}" > .adlc/tickets.json',
      'rm -f .adlc/current-ticket.json',
      'cp /tmp/evil.json .adlc/tickets.json',
    ]) {
      const v = adviseShell({ command: cmd }, { root, env: env() });
      assert.equal(v.permission, 'allow', `never deny (${cmd})`);
      assert.match(v.agent_message ?? '', /trust root|rail/i, `advisory must fire for: ${cmd}`);
    }
  } finally { cleanup(root); }
});

test('ADVISORY fires on a glob-rail literal-prefix hit (packages/gate/**)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const v = adviseShell({ command: 'mv packages/gate/lib/x.mjs /tmp/x' }, { root, env: env() });
    assert.equal(v.permission, 'allow');
    assert.match(v.agent_message ?? '', /packages\/gate/);
  } finally { cleanup(root); }
});

test('SILENT on benign commands (no advisory message)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const cmd of [
      'npm test',
      'git status',
      'cat src/frozen.js',            // read of a rail — no write indicator
      'rm -rf node_modules',          // write, but no rail/trust-root target
      'grep -rn pattern src/',
    ]) {
      assert.deepEqual(adviseShell({ command: cmd }, { root, env: env() }), { permission: 'allow' }, `must stay silent for: ${cmd}`);
    }
  } finally { cleanup(root); }
});

test('trust roots are advised even when enforcement is off (rails otherwise unknown)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const v = adviseShell({ command: 'echo x > .adlc/tickets.json' }, { root, env: {} });
    assert.equal(v.permission, 'allow');
    assert.match(v.agent_message ?? '', /tickets\.json/);
  } finally { cleanup(root); }
});

test('non-ADLC repo: always a bare allow', () => {
  const root = fixture();
  try {
    assert.deepEqual(adviseShell({ command: 'echo x > .adlc/tickets.json' }, { root, env: env() }), { permission: 'allow' });
  } finally { cleanup(root); }
});

test('NEVER denies: adversarial/degenerate payloads all produce permission allow', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const payloads = [
      {},
      null,
      { command: '' },
      { command: 12345 },
      { command: `rm -rf src/frozen.js; ${'x'.repeat(100_000)}` },
      { cmd: 'dd if=/dev/zero of=.adlc/tickets.json' },
      { tool_input: { command: 'tee src/frozen.js < /tmp/evil' } },
    ];
    for (const p of payloads) {
      assert.equal(adviseShell(p, { root, env: env() }).permission, 'allow');
    }
  } finally { cleanup(root); }
});

test('extractCommand reads the documented `command` field first, then defensive fallbacks', () => {
  assert.equal(extractCommand({ command: 'a', cmd: 'b' }), 'a');
  assert.equal(extractCommand({ cmd: 'b' }), 'b');
  assert.equal(extractCommand({ tool_input: { command: 'nested' } }), 'nested');
  assert.equal(extractCommand({}), '');
});

// T18 P5 hollow-test amendment: EVERY defensive command key must extract — a
// shrink of the source COMMAND_KEYS list must fail at least one of these cases.
// This list mirrors hooks/adlc-shell-advisory.mjs COMMAND_KEYS deliberately: if
// the source list loses (or renames) a key, the matching case below goes red.
const KNOWN_COMMAND_KEYS = ['command', 'cmd', 'command_line', 'commandLine', 'script', 'shell_command', 'shellCommand', 'text'];

test('every COMMAND_KEYS field extracts the command — top-level AND nested in each input bag', () => {
  for (const k of KNOWN_COMMAND_KEYS) {
    assert.equal(extractCommand({ [k]: `echo top-${k}` }), `echo top-${k}`, `top-level key "${k}" must extract`);
    for (const bag of ['tool_input', 'toolInput', 'input']) {
      assert.equal(extractCommand({ [bag]: { [k]: `echo ${bag}-${k}` } }), `echo ${bag}-${k}`, `key "${k}" nested in "${bag}" must extract`);
    }
  }
});

test('every COMMAND_KEYS field drives the full advisory decision (rail write is advised under each key)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const k of KNOWN_COMMAND_KEYS) {
      const v = adviseShell({ [k]: 'echo x > src/frozen.js' }, { root, env: env() });
      assert.equal(v.permission, 'allow', `never deny (key ${k})`);
      assert.match(v.agent_message ?? '', /src\/frozen\.js/, `advisory must fire for a rail write carried under "${k}"`);
    }
  } finally { cleanup(root); }
});

test('the source never emits a deny and documents the bypassability honestly', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(!/permission['"]?\s*:\s*['"]deny/.test(src), 'the shell advisory must have no deny path at all');
  assert.match(src, /TRIVIALLY BYPASSABLE/i, 'must document that the string match is trivially bypassable');
});

test('wire format: the real script allows and carries the advisory on stdout', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({ command: 'echo x > src/frozen.js', workspace_roots: [root] }),
    }).toString();
    const v = JSON.parse(out);
    assert.equal(v.permission, 'allow');
    assert.match(v.agent_message, /CI/);
  } finally { cleanup(root); }
});

test('wire format: malformed stdin still allows (advisory never fails closed)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: '{ not json',
    }).toString();
    assert.equal(JSON.parse(out).permission, 'allow');
  } finally { cleanup(root); }
});
