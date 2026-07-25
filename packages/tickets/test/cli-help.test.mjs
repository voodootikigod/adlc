import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDirectory, ticket } from './helpers.mjs';

const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'adlc-tickets.mjs');

function run(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd });
}

function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-help-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('`create --help` describes create, not the generic usage', () => {
  withTemp((root) => {
    const generic = run(['--help'], root);
    const create = run(['create', '--help'], root);
    assert.equal(create.status, 0, create.stderr);
    assert.notEqual(create.stdout, generic.stdout, 'subcommand --help must not fall through to the generic usage');
    assert.match(create.stdout, /--input/);
    assert.match(create.stdout, /ULID/);
    assert.match(create.stdout, /"rails"/);
  });
});

test('subcommand help works with no ticket store present', () => {
  // Help must be reachable before a store exists — an author asking "what
  // shape is this?" should never have to bootstrap a workspace to find out.
  withTemp((root) => {
    const result = run(['create', '--help'], root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});

test('`update --help` documents the compare-and-swap flag', () => {
  withTemp((root) => {
    const result = run(['update', '--help'], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--expect/);
  });
});

test('`schema` prints the ticket JSON Schema and exits 0', () => {
  withTemp((root) => {
    const result = run(['schema'], root);
    assert.equal(result.status, 0, result.stderr);
    const schema = JSON.parse(result.stdout);
    assert.equal(schema.$id, 'https://adlc.dev/schemas/ticket-v1.json');
    for (const field of ['title', 'body', 'category', 'duration', 'scope', 'rails', 'edges']) {
      assert.ok(schema.properties[field], `schema must describe ${field}`);
    }
  });
});

test('`schema` needs no ticket store and emits the same document with --json', () => {
  withTemp((root) => {
    const plain = run(['schema'], root);
    const json = run(['schema', '--json'], root);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), JSON.parse(plain.stdout));
  });
});

test('the documented create example is accepted by the real create path', () => {
  // The worked example in the help is executable, not illustrative: piping it
  // straight into `create --input -` produces a valid dry-run plan.
  withTemp((root) => {
    writeDirectory(root, [ticket('T1')]);
    const help = run(['create', '--help'], root).stdout;
    const example = help.slice(help.indexOf('{'), help.lastIndexOf('}') + 1);
    const result = spawnSync(process.execPath, [BIN, 'create', '--input', '-', '--json'], {
      encoding: 'utf8', cwd: root, input: example,
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dryRun, true);
    assert.match(plan.ticketId, /^T-[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'an omitted id is minted as a ULID');
  });
});

test('a scope-widening update fails without --authorize and succeeds with it', () => {
  // Pins the claim `update --help` now makes. Without this the help could drift
  // back to omitting the flag and only a user hitting AUTHORIZATION_REQUIRED
  // would find out.
  withTemp((root) => {
    writeDirectory(root, [ticket('T1', { scope: ['src/a/**'] })]);
    const widened = JSON.stringify({ ...ticket('T1', { scope: ['src/a/**', 'src/b/**'] }) });
    const attempt = (args) => spawnSync(process.execPath, [BIN, 'update', 'T1', '--input', '-', ...args], {
      encoding: 'utf8', cwd: root, input: widened,
    });

    const denied = attempt(['--json']);
    assert.equal(denied.status, 2, denied.stderr);
    assert.match(denied.stderr, /AUTHORIZATION_REQUIRED/);
    assert.match(denied.stderr, /scope-widening/);

    const allowed = attempt(['--authorize', '--json']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).dryRun, true);
  });
});

test('the generic usage still lists the commands and points at per-command help', () => {
  withTemp((root) => {
    const result = run(['--help'], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /adlc ticket <command> --help/);
    assert.match(result.stdout, /schema/);
  });
});

test('an unknown command still fails as an unknown command', () => {
  withTemp((root) => {
    writeDirectory(root, [ticket('T1')]);
    // Only `--help` short-circuits early; an unknown command must still reach
    // the dispatcher and fail there (kind 'invalid' => exit 2), unchanged.
    const result = run(['nope'], root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /UNKNOWN_COMMAND/);
  });
});
