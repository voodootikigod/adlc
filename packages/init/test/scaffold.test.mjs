import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_AGENT_TEMPLATES, scaffold } from '../index.mjs';
import { loadTicketSnapshot } from '@adlc/tickets';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin/adlc-init.mjs');
const TICKETS_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tickets/bin/adlc-tickets.mjs');

function fixture(fn) {
  const parent = mkdtempSync(join(tmpdir(), 'adlc-init-'));
  const root = join(parent, 'repo');
  try {
    return fn(root, parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('fresh scaffold creates ADLC config, ignores, and current Codex agent files', () => {
  fixture((root) => {
    const result = scaffold({ root });
    assert.equal(result.root, realpathSync(root));
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json')));
    assert.equal(cfg.version, 1);
    assert.equal(cfg.securityMode, 'unsigned-fallback');
    assert.equal(cfg.harnesses.codex.railEnforcement, 'auto');
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /!\.adlc\/specs\//);
    for (const name of Object.keys(CODEX_AGENT_TEMPLATES)) {
      const content = readFileSync(join(root, '.codex/agents', name), 'utf8');
      assert.match(content, /^name = "adlc-/);
      assert.match(content, /developer_instructions/);
    }
  });
});

test('scaffold is idempotent and preserves existing project-owned files', () => {
  fixture((root) => {
    scaffold({ root });
    writeFileSync(join(root, '.adlc/config.json'), '{"owned":true}\n');
    writeFileSync(join(root, '.codex/agents/adlc-reviewer.toml'), 'name = "team-reviewer"\n');
    const beforeIgnore = readFileSync(join(root, '.gitignore'), 'utf8');
    const result = scaffold({ root });
    assert.equal(readFileSync(join(root, '.adlc/config.json'), 'utf8'), '{"owned":true}\n');
    assert.equal(readFileSync(join(root, '.codex/agents/adlc-reviewer.toml'), 'utf8'), 'name = "team-reviewer"\n');
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), beforeIgnore);
    assert.equal(result.updated.length, 0);
  });
});

test('CLI confines writes to --root and returns machine-readable results', () => {
  fixture((root, parent) => {
    const sentinel = join(parent, 'sentinel');
    writeFileSync(sentinel, 'unchanged');
    const result = JSON.parse(execFileSync(process.execPath, [BIN, '--root', root, '--json'], { encoding: 'utf8' }));
    assert.equal(result.ok, true);
    assert.equal(result.root, realpathSync(root));
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  });
});

test('CLI without --no-codex-agents defaults to writing Codex agent files', () => {
  fixture((root) => {
    execFileSync(process.execPath, [BIN, '--root', root, '--json'], { encoding: 'utf8' });
    for (const name of Object.keys(CODEX_AGENT_TEMPLATES)) {
      assert.ok(existsSync(join(root, '.codex/agents', name)), `expected ${name} to exist`);
    }
  });
});

test('scaffold refuses repository symlinks that would escape the supplied root', () => {
  fixture((root, parent) => {
    const outside = join(parent, 'outside');
    const target = join(outside, 'adlc');
    mkdirSync(root, { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(root, '.adlc'), 'dir');
    assert.throws(() => scaffold({ root }), /refusing to follow symlink/);
    assert.equal(existsSync(join(target, 'specs')), false);
  });
});

for (const relativePath of ['.gitignore', '.adlc', '.codex']) {
  test(`scaffold refuses a dangling ${relativePath} symlink`, () => {
    fixture((root, parent) => {
      const outside = join(parent, `outside-${relativePath.replace('.', '')}`);
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, join(root, relativePath));
      assert.throws(() => scaffold({ root }), /refusing to follow symlink/);
      assert.equal(existsSync(outside), false);
    });
  });
}

test('scaffold repairs a whole-directory ADLC ignore so committed state can be re-included', () => {
  fixture((root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.adlc/\n');
    scaffold({ root, codexAgents: false });
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.doesNotMatch(ignore, /^\.adlc\/$/m);
    assert.match(ignore, /^\.adlc\/\*$/m);
    assert.match(ignore, /^!\.adlc\/config\.json$/m);
    assert.match(ignore, /^!\.adlc\/specs\/$/m);
  });
});

test('scaffold repairs the rooted "/.adlc/" ignore form too', () => {
  fixture((root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n/.adlc/\n');
    scaffold({ root, codexAgents: false });
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.doesNotMatch(ignore, /^\/\.adlc\/$/m);
    assert.match(ignore, /^\.adlc\/\*$/m);
  });
});

test('scaffold --harness cursor writes cursor harness config and skips Codex agents', () => {
  fixture((root) => {
    const result = scaffold({ root, harness: 'cursor' });
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.equal(cfg.securityMode, 'unsigned-fallback');
    assert.equal(cfg.harnesses.cursor.railEnforcement, 'auto');
    assert.equal(cfg.harnesses.codex, undefined);
    assert.equal(cfg.acknowledgedNewRailBypass, undefined);
    assert.equal(existsSync(join(root, '.codex')), false);
    assert.ok(result.created.includes('.adlc/config.json'));
  });
});

test('fresh scaffold yields a usable ticket store: create --write succeeds and reads back', () => {
  fixture((root) => {
    const scaffolded = scaffold({ root });
    // A genuinely fresh repo gets a directory store, not a legacy file.
    assert.equal(existsSync(join(root, '.adlc/tickets/.store.json')), true);
    assert.equal(existsSync(join(root, '.adlc/tickets.json')), false);
    // The result must positively account for both provisioned manifests — a
    // silent bookkeeping regression here is exactly the hollow-test class T55 warns of.
    assert.ok(scaffolded.created.includes('.adlc/tickets/.store.json'));
    assert.ok(scaffolded.created.includes('.adlc/ticket-archive/.store.json'));
    assert.equal(scaffolded.warnings.length, 0);

    const input = join(root, 'ticket.json');
    writeFileSync(input, JSON.stringify({ id: 'T1', title: 'first ticket' }));
    // execFileSync throws on a non-zero exit, so a clean return proves the
    // fresh-repo -> first-ticket write path succeeds against the scaffolded store.
    const output = execFileSync(
      process.execPath,
      [TICKETS_BIN, 'create', '--input', input, '--root', root, '--write', '--json'],
      { encoding: 'utf8' },
    );
    assert.match(output, /"applied": true/);

    const snapshot = loadTicketSnapshot({ root });
    assert.deepEqual(snapshot.tickets.map((ticket) => ticket.id), ['T1']);
  });
});

test('scaffold leaves an existing legacy ticket store untouched (no ambiguous dual store)', () => {
  fixture((root) => {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ version: 1, tickets: [] }));
    const result = scaffold({ root });
    assert.equal(existsSync(join(root, '.adlc/tickets')), false);
    assert.equal(result.created.includes('.adlc/tickets/.store.json'), false);
    // Reports the legacy path that actually exists, not the absent directory manifest.
    assert.equal(result.unchanged.includes('.adlc/tickets/.store.json'), false);
    assert.ok(result.unchanged.includes('.adlc/tickets.json'));
  });
});

test('scaffold warns for a corrupt legacy ticket store rather than reporting it healthy', () => {
  fixture((root) => {
    // A pre-existing legacy store must get the same health check as a directory
    // store: corrupt JSON is surfaced, not reported as an 'unchanged' success.
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets.json'), '{ not valid json');
    const result = scaffold({ root, codexAgents: false });
    assert.equal(result.unchanged.includes('.adlc/tickets.json'), false);
    assert.ok(result.warnings.some((w) => w.includes('.adlc/tickets.json')));
  });
});

test('scaffolded .gitignore does not ignore the ticket archive the store makes reachable', () => {
  fixture((root) => {
    scaffold({ root, codexAgents: false });
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    // The store now makes .adlc/ticket-archive/ reachable (lazily created on the
    // first archive op); without these negations archived tickets would be
    // silently git-ignored and lost, unlike a migrated legacy repo.
    assert.match(ignore, /^!\.adlc\/ticket-archive\/$/m);
    assert.match(ignore, /^!\.adlc\/ticket-archive\/\*\*$/m);
    assert.match(ignore, /^!\.adlc\/tickets\/\*\*$/m);
  });
});

test('scaffold warns instead of reporting success for a manifest-less store directory', () => {
  fixture((root) => {
    // A previous init that created .adlc/tickets/ but never landed the manifest
    // (crash, ENOSPC) leaves a broken store. Re-running init must not assert
    // 'unchanged' success over it — every ticket command would fail INVALID_MANIFEST.
    mkdirSync(join(root, '.adlc/tickets'), { recursive: true });
    const result = scaffold({ root, codexAgents: false });
    assert.equal(existsSync(join(root, '.adlc/tickets/.store.json')), false);
    assert.equal(result.created.includes('.adlc/tickets/.store.json'), false);
    assert.equal(result.unchanged.includes('.adlc/tickets/.store.json'), false);
    assert.ok(result.warnings.some((w) => w.includes('.adlc/tickets')));
  });
});

test('scaffold warns instead of reporting success for a pre-existing ambiguous dual store', () => {
  fixture((root) => {
    // Both backends present (interrupted migration, bad merge) is the ambiguous
    // state detectTicketStore refuses to resolve. init must surface it, not report
    // 'unchanged' success over a repo every ticket command will reject.
    mkdirSync(join(root, '.adlc/tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets/.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ version: 1, tickets: [] }));
    const result = scaffold({ root, codexAgents: false });
    assert.equal(result.unchanged.includes('.adlc/tickets/.store.json'), false);
    assert.equal(result.created.includes('.adlc/tickets/.store.json'), false);
    assert.ok(result.warnings.some((w) => w.toLowerCase().includes('ticket store')));
  });
});

test('scaffold warns for a directory store with a corrupt manifest rather than reporting it healthy', () => {
  fixture((root) => {
    // A torn write (crash/ENOSPC mid durableWrite) leaves .store.json as a regular
    // file with invalid JSON. A file-type check alone would call this healthy; the
    // manifest must actually load before init reports 'unchanged'.
    mkdirSync(join(root, '.adlc/tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets/.store.json'), '{ this is not valid json');
    const result = scaffold({ root, codexAgents: false });
    assert.equal(result.unchanged.includes('.adlc/tickets/.store.json'), false);
    assert.ok(result.warnings.some((w) => w.includes('.adlc/tickets/.store.json')));
  });
});

test('the ticket-store step is idempotent: a second scaffold reports it unchanged, not recreated', () => {
  fixture((root) => {
    scaffold({ root, codexAgents: false });
    const second = scaffold({ root, codexAgents: false });
    assert.equal(second.warnings.length, 0);
    assert.ok(second.unchanged.includes('.adlc/tickets/.store.json'));
    assert.ok(second.unchanged.includes('.adlc/ticket-archive/.store.json'));
    assert.equal(second.created.includes('.adlc/tickets/.store.json'), false);
    assert.equal(second.created.includes('.adlc/ticket-archive/.store.json'), false);
  });
});

test('scaffold refuses to provision the store through a symlinked .adlc/tickets', () => {
  fixture((root, parent) => {
    const outside = join(parent, 'outside-store');
    mkdirSync(join(root, '.adlc'), { recursive: true });
    symlinkSync(outside, join(root, '.adlc/tickets'), 'dir');
    assert.throws(() => scaffold({ root, codexAgents: false }), /refusing to follow symlink/);
    assert.equal(existsSync(join(outside, '.store.json')), false);
  });
});

test('CLI surfaces a store warning (does not silently swallow a broken pre-existing store)', () => {
  fixture((root) => {
    // Ambiguous dual store: the CLI must report the warning, not hide it behind ok:true.
    mkdirSync(join(root, '.adlc/tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets/.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ version: 1, tickets: [] }));
    // A broken store makes the CLI exit non-zero, so execFileSync throws; the
    // JSON contract must report ok:false with the warning rather than ok:true.
    let out;
    try {
      out = execFileSync(process.execPath, [BIN, '--root', root, '--no-codex-agents', '--json'], { encoding: 'utf8' });
      assert.fail('expected a non-zero exit for a broken store');
    } catch (error) {
      out = error.stdout;
    }
    const result = JSON.parse(out);
    assert.equal(result.ok, false);
    assert.ok(result.warnings.some((w) => w.toLowerCase().includes('ticket store')));
  });
});

test('CLI --harness cursor implies no Codex agents', () => {
  fixture((root) => {
    const result = JSON.parse(execFileSync(process.execPath, [BIN, '--root', root, '--harness', 'cursor', '--json'], { encoding: 'utf8' }));
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(root, '.codex')), false);
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.equal(cfg.harnesses.cursor.railEnforcement, 'auto');
  });
});
