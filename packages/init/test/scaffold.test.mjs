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

// #970 D7: configForHarness's old ternary special-cased only cursor/copilot
// and silently mapped EVERY other value — including the real names of four
// other supported harnesses — to "codex". A fresh repo scaffolded from
// inside a Claude Code (or pi, or opencode, or gemini) session got a config
// claiming codex, with no warning.
for (const harness of ['claude-code', 'pi', 'opencode', 'gemini']) {
  test(`scaffold --harness ${harness} registers the real harness name, not codex (D7)`, () => {
    fixture((root) => {
      const result = scaffold({ root, harness });
      const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
      assert.equal(cfg.securityMode, 'unsigned-fallback');
      assert.equal(cfg.harnesses[harness].railEnforcement, 'auto');
      assert.equal(cfg.harnesses.codex, undefined);
      assert.deepEqual(result.warnings, [], 'an explicit --harness must never warn');
      // A non-Codex harness must not be scaffolded with Codex agent
      // templates by default (adversarial review, round 1) — codexAgents
      // was only ever suppressed for cursor/copilot, so extending
      // --harness to these four names without extending the suppression
      // meant a claude-code/pi/opencode/gemini repo got .codex/ pollution.
      assert.equal(existsSync(join(root, '.codex')), false, `--harness ${harness} must not scaffold .codex/`);
    });
  });
}

test('scaffold --harness codex (or no --harness) still defaults codexAgents to true', () => {
  fixture((root) => {
    scaffold({ root, harness: 'codex' });
    assert.ok(existsSync(join(root, '.codex', 'agents')), '--harness codex must still scaffold .codex/agents');
  });
  fixture((root) => {
    scaffold({ root });
    assert.ok(existsSync(join(root, '.codex', 'agents')), 'no --harness must still default to scaffolding .codex/agents');
  });
});

test('scaffold with no --harness at all still defaults to codex, but WARNS rather than mislabeling silently (D7)', () => {
  fixture((root) => {
    const result = scaffold({ root });
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.equal(cfg.harnesses.codex.railEnforcement, 'auto');
    // Round-2 review, correcting round 1's `notices` split: the harness
    // guess belongs in `result.warnings` — the one documented,
    // JSON-consumer-visible contract (bin/adlc-init.mjs's own `ok =
    // warnings.length === 0` reporting path) — not a second, undocumented
    // channel a --json caller would never think to check.
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /--harness/);
    assert.match(result.warnings[0], /codex/);
    for (const name of ['cursor', 'copilot', 'claude-code', 'pi', 'opencode', 'gemini']) {
      assert.match(result.warnings[0], new RegExp(name), `warning must name ${name} as a recognized value`);
    }
    // Pins the exact `--harness <a|b|c>` placeholder syntax (mutation
    // regression: an operator that flips `<` to `>=` inside the template
    // literal changes printed text no earlier assertion here observed).
    assert.match(
      result.warnings[0],
      /--harness <codex\|cursor\|copilot\|claude-code\|pi\|opencode\|gemini>/,
      'warning must render the accepted values as a literal <a|b|c> placeholder',
    );
  });
});

test('an idempotent re-scaffold with no --harness re-warns every time (D7)', () => {
  // Gating the warning on result.created would mean a second no-harness run
  // against an already-existing config stays silent — even one whose
  // config.json is itself a stale guess from an earlier no-harness run. The
  // ambiguity is a property of THIS invocation's arguments (no --harness
  // passed), not of whether a write happened this time, so it must be
  // reported every time.
  fixture((root) => {
    const first = scaffold({ root });
    assert.equal(first.warnings.length, 1);
    const second = scaffold({ root });
    assert.equal(second.warnings.length, 1, 'omitting --harness is still ambiguous on a re-run');
    assert.match(second.warnings[0], /--harness/);
    assert.match(second.warnings[0], /codex/);
  });
});

test('explicit --harness after a bare init actually corrects the stale guess (round-6 review)', () => {
  // writeOrReconcileConfig reconciles just the requested harness into an
  // already-existing config.json rather than leaving it untouched — the
  // warning from the FIRST (guessing) call told the operator to "pass
  // --harness ... naming the harness you actually use", so doing exactly
  // that must actually register it. Every other field (the stale codex
  // entry, securityMode) survives — this is a merge, not a rewrite.
  fixture((root) => {
    const first = scaffold({ root });
    assert.equal(first.warnings.length, 1);
    const beforeCfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));

    const second = scaffold({ root, harness: 'pi' });
    assert.deepEqual(second.warnings, [], 'an explicit --harness never itself warns');
    assert.deepEqual(second.updated.filter((p) => p === '.adlc/config.json'), ['.adlc/config.json']);
    const afterCfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.deepEqual(afterCfg.harnesses.pi, { railEnforcement: 'auto' }, 'pi is now registered');
    assert.deepEqual(afterCfg.harnesses.codex, beforeCfg.harnesses.codex, 'the pre-existing codex entry survives untouched');
    assert.equal(afterCfg.securityMode, beforeCfg.securityMode, 'unrelated fields are preserved, not rewritten');

    // Idempotent: registering the SAME harness again is a true no-op.
    const third = scaffold({ root, harness: 'pi' });
    assert.deepEqual(third.unchanged.filter((p) => p === '.adlc/config.json'), ['.adlc/config.json']);
    assert.equal(third.updated.includes('.adlc/config.json'), false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8')), afterCfg);
  });
});

test('a re-scaffold that DOES pass --harness never warns, whether or not the config already exists', () => {
  fixture((root) => {
    const first = scaffold({ root, harness: 'pi' });
    assert.deepEqual(first.warnings, []);
    const second = scaffold({ root, harness: 'pi' });
    assert.deepEqual(second.warnings, [], '--harness was given both times, so nothing is ambiguous');
  });
});

test('reconciling --harness against a corrupt or shape-mismatched existing config.json degrades to unchanged, never crashes or corrupts further', () => {
  fixture((root) => {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/config.json'), '{ not valid json');
    const result = scaffold({ root, harness: 'pi' });
    assert.deepEqual(result.unchanged.filter((p) => p === '.adlc/config.json'), ['.adlc/config.json']);
    assert.equal(readFileSync(join(root, '.adlc/config.json'), 'utf8'), '{ not valid json', 'left exactly as found');
  });
  fixture((root) => {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    // Valid JSON, but the top level is an array — a shape this function does
    // not understand at all — so it is left exactly as found rather than
    // guessing at a merge target.
    writeFileSync(join(root, '.adlc/config.json'), JSON.stringify(['not', 'an', 'object']));
    const result = scaffold({ root, harness: 'pi' });
    assert.deepEqual(result.unchanged.filter((p) => p === '.adlc/config.json'), ['.adlc/config.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8')), ['not', 'an', 'object']);
  });
  fixture((root) => {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    // Valid JSON, top-level object, but "harnesses" itself is the WRONG
    // shape (not a plain object) — cannot safely merge a harness entry into
    // it, so leave it exactly as found rather than clobbering it.
    writeFileSync(join(root, '.adlc/config.json'), JSON.stringify({ version: 1, harnesses: 'codex' }));
    const result = scaffold({ root, harness: 'pi' });
    assert.deepEqual(result.unchanged.filter((p) => p === '.adlc/config.json'), ['.adlc/config.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8')), { version: 1, harnesses: 'codex' });
  });
});

test('reconciling --harness against a valid existing config.json with NO harnesses field creates one (round-7 review)', () => {
  // A different plugin's own scaffolder (e.g. cursor, opencode) can create a
  // valid .adlc/config.json without a "harnesses" field at all. Round 6's
  // reconciliation fix only merged into an EXISTING harnesses object and
  // left this case unregistered — extend it to create the field.
  fixture((root) => {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/config.json'), JSON.stringify({ version: 1, securityMode: 'unsigned-fallback' }));
    const result = scaffold({ root, harness: 'pi' });
    assert.deepEqual(result.updated.filter((p) => p === '.adlc/config.json'), ['.adlc/config.json']);
    const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
    assert.deepEqual(cfg.harnesses, { pi: { railEnforcement: 'auto' } });
    assert.equal(cfg.securityMode, 'unsigned-fallback', 'unrelated fields are preserved');
    assert.equal(cfg.version, 1);
  });
});

test('CLI still exits 0 for a bare `adlc init` with no --harness, even though it now carries a warning (D7)', () => {
  // The harness guess is advisory, not a broken/ambiguous store — it must
  // not turn the single most common invocation, bare `adlc init`, into a
  // failing run by default. The CLI's ok/exit-code contract distinguishes
  // this ADVISORY_WARNING_PREFIX class from every OTHER warning (a broken
  // store, a corrupt manifest) rather than treating result.warnings as
  // uniformly fatal.
  fixture((root) => {
    const result = JSON.parse(execFileSync(process.execPath, [BIN, '--root', root, '--json'], { encoding: 'utf8' }));
    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /--harness/);
  });
});

// #970 D8: securityMode: 'unsigned-fallback' weakens config-integrity
// verification with zero user-facing documentation of what that means.
test('scaffold documents what unsigned-fallback weakens, in the README (D8)', () => {
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
  assert.match(readme, /unsigned-fallback/);
  assert.match(readme, /unsigned/i);
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
    // The one expected warning here is the D7 harness-guess advisory (no
    // --harness was passed) — the ticket-store provisioning itself must
    // still carry none.
    assert.deepEqual(scaffolded.warnings, scaffolded.warnings.filter((w) => w.includes('--harness')));

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
  // An explicit --harness keeps this test's concern (ticket-store
  // idempotency) isolated from the separate no-harness warning contract:
  // that warning fires on every no-harness call, regardless of
  // create/update/unchanged state — see the D7 tests above.
  fixture((root) => {
    scaffold({ root, harness: 'codex', codexAgents: false });
    const second = scaffold({ root, harness: 'codex', codexAgents: false });
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

// #970 D7: the CLI parser only ever accepted codex|cursor|copilot — there
// was no flag spelling that could register claude-code/pi/opencode/gemini
// at all, so a fresh scaffold from any of those hosts had no correct value
// to pass even if the operator knew to look for one.
for (const harness of ['claude-code', 'pi', 'opencode', 'gemini']) {
  test(`CLI --harness ${harness} registers the real harness name (D7)`, () => {
    fixture((root) => {
      const result = JSON.parse(
        execFileSync(process.execPath, [BIN, '--root', root, '--harness', harness, '--json'], { encoding: 'utf8' }),
      );
      assert.equal(result.ok, true);
      const cfg = JSON.parse(readFileSync(join(root, '.adlc/config.json'), 'utf8'));
      assert.equal(cfg.harnesses[harness].railEnforcement, 'auto');
      assert.equal(cfg.harnesses.codex, undefined);
    });
  });
}

test('CLI rejects an unrecognized --harness value, naming every accepted one', () => {
  fixture((root) => {
    assert.throws(
      () => execFileSync(process.execPath, [BIN, '--root', root, '--harness', 'nonexistent-host'], { encoding: 'utf8', stdio: 'pipe' }),
      (err) => {
        const text = String(err.stderr ?? err.stdout ?? err.message);
        for (const name of ['codex', 'cursor', 'copilot', 'claude-code', 'pi', 'opencode', 'gemini']) {
          assert.match(text, new RegExp(name), `error must name ${name} as an accepted value`);
        }
        return true;
      },
    );
  });
});
