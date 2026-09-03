import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, canonicalizeExisting } from '../hooks/adlc-rails-guard.mjs';
import { checkRail } from '../rails-checker.mjs';
import { ticketFilename } from '../generated-ticket-reader.mjs';

const ENF = { ADLC_P4_ENFORCEMENT: '1' };

function adlcRepo({ rails = [], id = 'T1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-dec-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id, title: 't', body: 'b', scope: ['src/**'], rails }] }));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id }));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}
const call = (name, args, env = ENF, extra = {}) => decide({ toolCall: { name, args }, ...extra }, { env });

test('G1: non-file tool (search_web) allowed under enforcement', () => {
  assert.equal(call('search_web', { query: 'x' }).allow_tool, true);
});
test("'other'-classified tool with no path allowed under enforcement (covers the 'other' no-path branch)", () => {
  // generate_image classifies 'other' (a mutator with no inspectable path); with no
  // extractable path it takes the 'other' no-path allow branch. (Its fail-closed
  // treatment when it DID expose a path is out of scope here.)
  assert.equal(call('generate_image', { prompt: 'a cat' }).allow_tool, true);
});
test('read-only tool (view_file) allowed under enforcement', () => {
  assert.equal(call('view_file', { AbsolutePath: '/anything/a.js' }).allow_tool, true);
});
test('shell tool (run_command) allowed in-session', () => {
  assert.equal(call('run_command', { CommandLine: 'echo hi > /x' }).allow_tool, true);
});
test('G2: write with ABSOLUTE path in non-ADLC repo allowed under enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-noadlc-'));
  assert.equal(call('write_to_file', { TargetFile: join(root, 'a.js') }).allow_tool, true);
});
test('rail hit: mutating write to a frozen rail denied', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  const v = call('write_to_file', { TargetFile: join(root, 'src', 'frozen.js') });
  assert.equal(v.allow_tool, false);
  assert.match(v.deny_reason, /frozen rail/i);
});
test('non-rail write in ADLC repo allowed', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  assert.equal(call('write_to_file', { TargetFile: join(root, 'src', 'ok.js') }).allow_tool, true);
});
test('sharded store enforces rails and freezes its shards', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-sharded-'));
  const store = join(root, '.adlc/tickets');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(store, { recursive: true });
  const ticket = { id: 'T1', title: 'sharded', rails: ['src/frozen.js'] };
  const shard = ticketFilename(ticket.id);
  writeFileSync(join(store, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
  writeFileSync(join(store, shard), JSON.stringify(ticket));
  writeFileSync(join(root, '.adlc/current-ticket.json'), JSON.stringify({ id: 'T1' }));
  assert.equal(call('write_to_file', { TargetFile: join(root, 'src/frozen.js') }).allow_tool, false);
  assert.equal(call('write_to_file', { TargetFile: join(store, shard) }).allow_tool, false);
  assert.equal(call('write_to_file', { TargetFile: join(root, 'src/ok.js') }).allow_tool, true);
});
test('H1/H3: relative path + empty workspacePaths (headless) denied under enforcement', () => {
  const v = call('write_to_file', { TargetFile: 'src/frozen.js' }, ENF, { workspacePaths: [] });
  assert.equal(v.allow_tool, false);
});
test('H2: name-mutating tool with unknown path key (no path) denied under enforcement', () => {
  const v = call('write_to_file', { DirectoryPath: '/repo/src' }); // key not in PATH_KEYS
  assert.equal(v.allow_tool, false);
});
test('enforcement OFF is a no-op allow even on a rail', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  assert.equal(call('write_to_file', { TargetFile: join(root, 'src', 'frozen.js') }, {}).allow_tool, true);
});

// ── #823: non-object payloads reaching decide() DIRECTLY ─────────────────────
// runFromStdin carries its own copy of this guard, so its tests never exercise
// the decide()-level one. Each shape below is a distinct way a mis-joined guard
// lets a payload through to extractToolName, where it reads as an unclassified
// tool and is allowed. The deny reason is pinned so the categorical catch-all
// ("internal error while enforcing") cannot stand in for the guard.
for (const [label, payload] of [['null', null], ['undefined', undefined], ['string', 'hi'], ['number', 123], ['array', []]]) {
  test(`decide(): ${label} payload under enforcement fails CLOSED at the payload guard`, () => {
    const v = decide(payload, { env: ENF });
    assert.equal(v.allow_tool, false);
    assert.equal(v.decision, 'deny');
    assert.match(v.deny_reason, /unparseable tool payload while enforcing/);
  });
  test(`decide(): ${label} payload with enforcement off allows`, () => {
    assert.deepEqual(decide(payload, { env: {} }), { decision: 'allow', allow_tool: true });
  });
}

// A well-formed object that carries NO tool name is a malformed envelope
// (agy names every PreToolUse call), not an unknown tool.
for (const [label, payload] of [['{}', {}], ['{toolCall:{}}', { toolCall: {} }], ['{toolCall:{args:{}}}', { toolCall: { args: {} } }], ['{toolCall:{name:"  "}}', { toolCall: { name: '  ' } }]]) {
  test(`decide(): ${label} (no tool name) under enforcement fails CLOSED`, () => {
    const v = decide(payload, { env: ENF });
    assert.equal(v.allow_tool, false);
    assert.equal(v.decision, 'deny');
    assert.match(v.deny_reason, /exposes no tool name/);
  });
  test(`decide(): ${label} (no tool name) with enforcement off allows`, () => {
    assert.deepEqual(decide(payload, { env: {} }), { decision: 'allow', allow_tool: true });
  });
}

test('decide(): write to .adlc/.session-secret is denied as a frozen rail', () => {
  const root = adlcRepo();
  const v = call('write_to_file', { TargetFile: join(root, '.adlc/.session-secret') });
  assert.equal(v.allow_tool, false);
  assert.equal(v.decision, 'deny');
  assert.match(v.deny_reason, /frozen rail/);
});

test('checkRail: denies a .env.local.bak-style path via the .env.local* wildcard rail', () => {
  // checkRail is TRUST_ROOT_RAILS's direct consumer (via railPreconditions), called
  // here in isolation from decide()'s separate isTrustRootOrSecretPath regex check
  // (which also matches any '.env.local' substring) — so this pins the rails-glob
  // wildcard specifically, not overlapping protection.
  const root = adlcRepo();
  const res = checkRail({ filePath: join(root, '.env.local.bak'), tool: 'write_to_file', root, env: ENF });
  assert.equal(res.decision, 'deny');
  assert.match(res.reason, /frozen rail ".*\.env\.local\*"/);
});

test('decide(): nested path object on unclassified tool targeting frozen rail is denied', () => {
  const root = adlcRepo();
  const v = call('custom_mutator', { target: { path: join(root, '.adlc/tickets.json') } });
  assert.equal(v.allow_tool, false);
  assert.equal(v.decision, 'deny');
  assert.match(v.deny_reason, /frozen rail/);
});

test('decide(): relative workspacePaths ["."] with relative frozen rail target is denied under enforcement', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });
  const origCwd = process.cwd();
  try {
    process.chdir(root);
    const v1 = decide({
      workspacePaths: ['.'],
      toolCall: { name: 'write_to_file', args: { TargetFile: '.adlc/tickets.json' } },
    }, { env: ENF });
    assert.equal(v1.allow_tool, false);
    assert.equal(v1.decision, 'deny');
    assert.match(v1.deny_reason, /frozen rail/);

    const v2 = decide({
      workspacePaths: ['.'],
      toolCall: { name: 'write_to_file', args: { TargetFile: 'src/frozen.js' } },
    }, { env: ENF });
    assert.equal(v2.allow_tool, false);
    assert.equal(v2.decision, 'deny');
    assert.match(v2.deny_reason, /frozen rail/);
  } finally {
    process.chdir(origCwd);
  }
});

test('decide(): unclassified code executors with code/script args fail closed under enforcement', () => {
  const root = adlcRepo({ rails: ['src/frozen.js'] });

  // python_exec with code payload
  const v1 = decide({
    workspacePaths: [root],
    toolCall: { name: 'python_exec', args: { code: "open('/repo/src/frozen.js','w').write('x')" } },
  }, { env: ENF });
  assert.equal(v1.allow_tool, false);
  assert.equal(v1.decision, 'deny');
  assert.match(v1.deny_reason, /uninspectable arguments/);

  // eval_js with script payload
  const v2 = decide({
    workspacePaths: [root],
    toolCall: { name: 'eval_js', args: { script: "fs.writeFileSync('src/frozen.js', 'x')" } },
  }, { env: ENF });
  assert.equal(v2.allow_tool, false);
  assert.equal(v2.decision, 'deny');
  assert.match(v2.deny_reason, /uninspectable arguments/);

  // generate_code with code payload
  const v3 = decide({
    workspacePaths: [root],
    toolCall: { name: 'generate_code', args: { code: "import os; os.remove('src/frozen.js')" } },
  }, { env: ENF });
  assert.equal(v3.allow_tool, false);
  assert.equal(v3.decision, 'deny');
  assert.match(v3.deny_reason, /uninspectable arguments/);

  // python_exec with scriptContent (camelCase)
  const v4 = decide({
    workspacePaths: [root],
    toolCall: { name: 'python_exec', args: { scriptContent: "open('src/file.js','w').write('x')" } },
  }, { env: ENF });
  assert.equal(v4.allow_tool, false);
  assert.equal(v4.decision, 'deny');
  assert.match(v4.deny_reason, /uninspectable arguments/);

  // custom_runner with codePayload (camelCase)
  const v5 = decide({
    workspacePaths: [root],
    toolCall: { name: 'custom_runner', args: { codePayload: "rm -rf src/frozen.js" } },
  }, { env: ENF });
  assert.equal(v5.allow_tool, false);
  assert.equal(v5.decision, 'deny');
  assert.match(v5.deny_reason, /uninspectable arguments/);

  // nested code argument
  const v6 = decide({
    workspacePaths: [root],
    toolCall: { name: 'remote_eval', args: { options: { inlineCode: "process.exit(1)" } } },
  }, { env: ENF });
  assert.equal(v6.allow_tool, false);
  assert.equal(v6.decision, 'deny');
  assert.match(v6.deny_reason, /uninspectable arguments/);

  // nested CommandLine argument in unclassified executor
  const v7 = decide({
    workspacePaths: [root],
    toolCall: { name: 'custom_executor', args: { options: { CommandLine: "rm -f /repo/.adlc/tickets.json" } } },
  }, { env: ENF });
  assert.equal(v7.allow_tool, false);
  assert.equal(v7.decision, 'deny');
  assert.match(v7.deny_reason, /uninspectable arguments|shell modification of ticket store or trust-root rails/);

  // nested cmd argument in unclassified executor
  const v8 = decide({
    workspacePaths: [root],
    toolCall: { name: 'unrecognized_runner', args: { config: { cmd: "rm -rf .adlc" } } },
  }, { env: ENF });
  assert.equal(v8.allow_tool, false);
  assert.equal(v8.decision, 'deny');
  assert.match(v8.deny_reason, /uninspectable arguments|shell modification of ticket store or trust-root rails/);

  // recognized shell tool with nested CommandLine targeting trust root is denied
  const v9 = decide({
    workspacePaths: [root],
    toolCall: { name: 'run_command', args: { options: { CommandLine: "rm -rf .adlc/tickets.json" } } },
  }, { env: ENF });
  assert.equal(v9.allow_tool, false);
  assert.equal(v9.decision, 'deny');
  assert.match(v9.deny_reason, /shell modification of ticket store or trust-root rails/);

  // camelCase command fields in unclassified executors fail closed
  const v10 = decide({
    workspacePaths: [root],
    toolCall: { name: 'custom_runner', args: { shellCommand: "npm install" } },
  }, { env: ENF });
  assert.equal(v10.allow_tool, false);
  assert.equal(v10.decision, 'deny');
  assert.match(v10.deny_reason, /uninspectable arguments/);

  const v11 = decide({
    workspacePaths: [root],
    toolCall: { name: 'task_runner', args: { commandText: "cargo test" } },
  }, { env: ENF });
  assert.equal(v11.allow_tool, false);
  assert.equal(v11.decision, 'deny');
  assert.match(v11.deny_reason, /uninspectable arguments/);

  // recognized shell tool with query or operation argument targeting trust root is denied
  const v12 = decide({
    workspacePaths: [root],
    toolCall: { name: 'run_command', args: { query: "rm -f .adlc/tickets.json" } },
  }, { env: ENF });
  assert.equal(v12.allow_tool, false);
  assert.equal(v12.decision, 'deny');
  assert.match(v12.deny_reason, /shell modification of ticket store or trust-root rails/);

  const v13 = decide({
    workspacePaths: [root],
    toolCall: { name: 'run_command', args: { payload: { operation: "rm -rf .adlc" } } },
  }, { env: ENF });
  assert.equal(v13.allow_tool, false);
  assert.equal(v13.decision, 'deny');
  assert.match(v13.deny_reason, /shell modification of ticket store or trust-root rails/);
});

test('decide(): shell tool carrying both trust-root secret CommandLine AND benign TargetFile is denied under enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-cmd-target-'));
  const ENF = { ADLC_P4_ENFORCEMENT: '1', ADLC_TEST_MODE: '1' };
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'bash',
        args: {
          CommandLine: 'cat ~/.config/adlc/secrets/.auth-key',
          TargetFile: 'notes.txt',
        },
      },
    }, { env: ENF });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
    assert.match(res.deny_reason, /shell modification of ticket store or trust-root rails|strictly prohibited/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): shell command reading master key or trust-root secret is denied even with ADLC_P4_ENFORCEMENT unset', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-advisory-secret-'));
  const ADVISORY_ENV = { ADLC_TEST_MODE: '1' }; // No ADLC_P4_ENFORCEMENT
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cat ~/.config/adlc/secrets/.auth-key',
        },
      },
    }, { env: ADVISORY_ENV });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
    assert.match(res.deny_reason, /shell modification of ticket store or trust-root rails|strictly prohibited/i);

    const res2 = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cat .adlc/.session-secret',
        },
      },
    }, { env: ADVISORY_ENV });
    assert.equal(res2.allow_tool, false);
    assert.equal(res2.decision, 'deny');
    assert.match(res2.deny_reason, /shell modification of ticket store or trust-root rails|strictly prohibited/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): shell command with relative symlink under non-default Cwd targeting secret is denied', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-cwd-symlink-'));
  const subDir = join(root, 'nested', 'subdir');
  mkdirSync(subDir, { recursive: true });
  const fakeSecretsDir = join(root, 'fake-home', '.config', 'adlc', 'secrets');
  mkdirSync(fakeSecretsDir, { recursive: true });
  const fakeAuthKey = join(fakeSecretsDir, '.auth-key');
  writeFileSync(fakeAuthKey, 'secret-data');

  const symlinkPath = join(subDir, 'secret-link');
  symlinkSync(fakeAuthKey, symlinkPath);

  const env = { ADLC_HOME_DIR: join(root, 'fake-home'), ADLC_TEST_MODE: '1' };
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cat secret-link',
          Cwd: subDir,
        },
      },
    }, { env });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
    assert.match(res.deny_reason, /secret|strictly prohibited|symlink/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): shell command with wildcard .master-k?y is denied', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-wildcard-'));
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cat .master-k?y',
        },
      },
    }, { env: { ADLC_TEST_MODE: '1' } });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): shell tool with array-valued command argument is denied for secret access', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-array-cmd-'));
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          cmd: ['cat', '~/.config/adlc/secrets/.auth-key'],
        },
      },
    }, { env: { ADLC_TEST_MODE: '1' } });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): extractCwdFromArgs prioritizes top-level Cwd over decoy nested dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-decoy-cwd-'));
  const fakeSecretsDir = join(root, 'fake-home', '.config', 'adlc', 'secrets');
  mkdirSync(fakeSecretsDir, { recursive: true });
  const fakeAuthKey = join(fakeSecretsDir, '.auth-key');
  writeFileSync(fakeAuthKey, 'secret-data');

  const symlinkPath = join(root, 'decoy-secret-link');
  symlinkSync(fakeAuthKey, symlinkPath);

  const env = { ADLC_HOME_DIR: join(root, 'fake-home'), ADLC_TEST_MODE: '1' };
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cat decoy-secret-link',
          Cwd: root,
          decoy: { dir: '/tmp/empty-decoy-dir' },
        },
      },
    }, { env });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
    assert.match(res.deny_reason, /secret|strictly prohibited|symlink/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): structured write targeting node binary is denied as trust root violation', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-node-target-'));
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'write_to_file',
        args: {
          TargetFile: process.execPath,
          CodeContent: '#!/bin/sh\necho "fake node"\nexit 0\n',
        },
      },
    }, { env: { ADLC_TEST_MODE: '1' } });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
    assert.match(res.deny_reason, /strictly prohibited|trust-root/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): shell command with bare .. (e.g. cd ..) is denied under enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-bare-dotdot-'));
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cd ..; ls',
        },
      },
    }, { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TEST_MODE: '1' } });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
    assert.match(res.deny_reason, /outside workspace|escapes/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): shell command with absolute path outside workspace is denied under containment check', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-containment-'));
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'cat /opt/secrets/prod.env',
          Cwd: root,
        },
      },
    }, { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TEST_MODE: '1' } });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
    assert.match(res.deny_reason, /outside workspace/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('decide(): structured write targeting node_modules/.bin/mocha or test runner configs is denied as trust root violation', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-decide-mocha-target-'));
  try {
    const res1 = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'write_to_file',
        args: {
          TargetFile: join(root, 'node_modules/.bin/mocha'),
          CodeContent: '#!/bin/sh\nexit 0\n',
        },
      },
    }, { env: { ADLC_TEST_MODE: '1' } });
    assert.equal(res1.allow_tool, false);
    assert.equal(res1.decision, 'deny');
    assert.match(res1.deny_reason, /strictly prohibited|trust-root/i);

    const res2 = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'write_to_file',
        args: {
          TargetFile: join(root, '.mocharc.json'),
          CodeContent: '{"timeout": 1000}\n',
        },
      },
    }, { env: { ADLC_TEST_MODE: '1' } });
    assert.equal(res2.allow_tool, false);
    assert.equal(res2.decision, 'deny');
    assert.match(res2.deny_reason, /strictly prohibited|trust-root/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('checkRail: denies write to absolute out-of-repo ADLC_TICKET_STORE path on its own', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cr-repo-'));
  const externalDir = mkdtempSync(join(tmpdir(), 'adlc-cr-external-'));
  const extStore = join(externalDir, 'tickets.json');
  writeFileSync(extStore, JSON.stringify({
    version: 1,
    activeTicket: 'T-EXT',
    tickets: [{ id: 'T-EXT', title: 'External Ticket', status: 'open', rails: ['src/frozen/**'] }],
  }));
  try {
    const res = checkRail({
      filePath: extStore,
      tool: 'write_to_file',
      toolArgs: { TargetFile: extStore },
      root,
      env: { ADLC_TICKET_STORE: extStore, ADLC_TICKET: 'T-EXT', ADLC_P4_ENFORCEMENT: '1', ADLC_TEST_MODE: '1' },
    });
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /frozen rail/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    try { rmSync(externalDir, { recursive: true, force: true }); } catch {}
  }
});

test('decide: PURE_READS tool carrying write-target or command args degrades to other and is denied if targeting frozen rail', () => {
  const root = adlcRepo({ rails: ['frozen.txt'], id: 'T1' });
  try {
    const res = decide({
      workspacePaths: [root],
      toolCall: {
        name: 'view_file',
        args: {
          TargetFile: join(root, 'frozen.txt'),
        },
      },
    }, { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TEST_MODE: '1' } });
    assert.equal(res.allow_tool, false);
    assert.equal(res.decision, 'deny');
    assert.match(res.deny_reason, /frozen rail/i);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('checkBuildGate and decide: under ADLC_P4_ENFORCEMENT=1 with transcript containing prior shell calls', () => {
  const root = adlcRepo({ rails: ['frozen.txt'], id: 'T1' });
  const transcriptFile = join(root, 'transcript.jsonl');
  writeFileSync(transcriptFile, [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo "hello"', Cwd: root } }],
      exit_code: 0,
    }),
  ].join('\n') + '\n');
  try {
    const res = decide({
      workspacePaths: [root],
      transcriptPath: transcriptFile,
      conversationId: 'test-session-shell-trans',
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'ls',
          Cwd: root,
        },
      },
    }, { env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TEST_MODE: '1' } });
    assert.equal(res.allow_tool, true);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('canonicalizeExisting: falsy and non-string input is returned unchanged, without attempting resolution', () => {
  assert.equal(canonicalizeExisting(null), null);
  assert.equal(canonicalizeExisting(undefined), undefined);
  // Falsy but a string: the guard must short-circuit on `!p` alone, not fall through
  // into the resolution walk (which would return an unrelated cwd-derived path).
  assert.equal(canonicalizeExisting(''), '');
});

test('canonicalizeExisting: an existing symlinked path resolves through the symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-canon-'));
  try {
    const real = join(root, 'real-target');
    mkdirSync(real, { recursive: true });
    const link = join(root, 'link-to-real');
    symlinkSync(real, link);
    const resolved = canonicalizeExisting(link);
    assert.equal(resolved, realpathSync(link));
    assert.notEqual(resolved, link);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});





