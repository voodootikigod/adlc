import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHelp } from '../lib/help.mjs';

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'adlc.mjs');

function makeTempDir(t, prefix = 'adlc-cli-triage-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('renderHelp and adlc --help document triage and simplify subcommands', () => {
  const helpText = renderHelp('1.13.0');
  assert.match(helpText, /adlc triage \[args\.\.\.\]/);
  assert.match(helpText, /adlc simplify \[args\.\.\.\]/);

  const cliHelp = runCli(['--help']);
  assert.equal(cliHelp.status, 0, cliHelp.stderr);
  assert.match(cliHelp.stdout, /adlc triage/);
  assert.match(cliHelp.stdout, /adlc simplify/);
});

test('adlc triage --files --json dispatches to @adlc/runner and classifies tracks', (t) => {
  const dir = makeTempDir(t);

  const trivialRes = runCli(['triage', '--files', 'packages/foo/lib/a.mjs', '--json'], dir);
  assert.equal(trivialRes.status, 0, trivialRes.stderr);
  const trivialJson = JSON.parse(trivialRes.stdout);
  assert.equal(trivialJson.track, 'trivial');
  assert.equal(trivialJson.ticketRequired, false);

  const archRes = runCli(
    ['triage', '--files', 'packages/foo/package.json,packages/bar/lib/index.mjs', '--json'],
    dir,
  );
  assert.equal(archRes.status, 0, archRes.stderr);
  const archJson = JSON.parse(archRes.stdout);
  assert.equal(archJson.track, 'architectural');
  assert.equal(archJson.ticketRequired, true);
  assert.equal(archJson.requireFreshContext, true);
});

test('adlc simplify --root --json dispatches to @adlc/runner and detects duplicates and core reinventions', (t) => {
  const root = makeTempDir(t, 'adlc-cli-simplify-');
  mkdirSync(join(root, 'packages/one/lib'), { recursive: true });
  mkdirSync(join(root, 'packages/two/lib'), { recursive: true });

  const dupBlock = Array.from({ length: 12 }, (_, idx) => `const v${idx} = transform(${idx});`).join('\n');
  writeFileSync(join(root, 'packages/one/lib/a.mjs'), `${dupBlock}\nexport function resolveTrustedBinary(n) { return n; }\n`);
  writeFileSync(join(root, 'packages/two/lib/b.mjs'), `${dupBlock}\n`);

  const res = runCli(['simplify', '--root', root, '--json'], root);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.duplicateBlocks.length, 1);
  assert.equal(parsed.coreReinventions.length, 1);
  assert.equal(parsed.coreReinventions[0].helper, 'resolveTrustedBinary');

  const missingRoot = runCli(['simplify', '--root', join(root, 'missing-dir')], root);
  assert.equal(missingRoot.status, 1);
});

test('adlc run forwards --track and --require-fresh-context with operational vs gate exit codes', (t) => {
  const dir = makeTempDir(t);
  const badTrack = runCli(['run', 'p0', '--ticket', 'T1', '--track', 'invalid-track', '--dir', join(dir, '.adlc')], dir);
  assert.equal(badTrack.status, 1);

  const missingGate = runCli(['run', 'p0', '--ticket', 'T1', '--track', 'substantial', '--dir', join(dir, '.adlc')], dir);
  assert.equal(missingGate.status, 2);
});
