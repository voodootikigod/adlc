import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readBypassGrant, writeBypassGrant } from '../lib/bypass-grant.mjs';
import { matchRecoveryCommand, formatRecoveryCommand } from '../lib/recovery-exception.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CC_GATE = join(REPO_ROOT, 'plugins', 'adlc-claude-code', 'hooks', 'handoff-gate.mjs');
const CODEX_GATE = join(REPO_ROOT, 'plugins', 'adlc-codex', 'hooks', 'adlc-handoff-gate.mjs');

const { readVerifiedBypassGrant: ccReadGrant, matchRecoveryCommand: ccMatch, formatRecoveryCommand: ccFormat } = await import(CC_GATE);
const { readVerifiedBypassGrant: codexReadGrant, matchRecoveryCommand: codexMatch, formatRecoveryCommand: codexFormat } = await import(CODEX_GATE);

test('#611: readBypassGrant and hook twins fail closed (null) when O_NOFOLLOW or O_NONBLOCK is undefined (Windows)', () => {
  const root = mkdtempSync(join(tmpdir(), 'win-grant-'));
  try {
    mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
    writeBypassGrant(root, 'sess-1', {}, { key: 'test-key' });
    // Sanity: with real POSIX constants, the grant reads and verifies.
    const ok = readBypassGrant(root, 'sess-1', { key: 'test-key' });
    assert.equal(ok?.verified, true);

    const noFollowMissing = { O_RDONLY: constants.O_RDONLY, O_NONBLOCK: constants.O_NONBLOCK };
    const nonBlockMissing = { O_RDONLY: constants.O_RDONLY, O_NOFOLLOW: constants.O_NOFOLLOW };
    const bothMissing = { O_RDONLY: constants.O_RDONLY };
    for (const fsConstants of [noFollowMissing, nonBlockMissing, bothMissing, null, {}]) {
      let opened = false;
      const res = readBypassGrant(root, 'sess-1', {
        key: 'test-key',
        fsConstants,
        open: () => { opened = true; return 99; },
      });
      assert.equal(res, null);
      assert.equal(opened, false, 'must not call open() when O_NOFOLLOW/O_NONBLOCK is absent');
      assert.equal(ccReadGrant(root, 'sess-1', { key: 'test-key', fsConstants }), null);
      assert.equal(codexReadGrant(root, 'sess-1', { key: 'test-key', fsConstants }), null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#611: matchRecoveryCommand and hook twins accept Windows drive-letter absolute paths when quoted or forward-slashed', () => {
  const winNode = 'C:\\Program Files\\nodejs\\node.exe';
  const winScript = 'D:\\repo\\packages\\context-handoff\\bin\\handoff.mjs';
  const winSlashNode = 'C:/nodejs/node.exe';
  const winSlashScript = 'D:/repo/handoff.mjs';
  const fakeRealpath = (p) => p.replace(/\//g, '\\').toLowerCase();

  for (const matcher of [matchRecoveryCommand, ccMatch, codexMatch]) {
    const quotedCmd = `'${winNode}' '${winScript}' bypass --session sess-1 --write`;
    const r1 = matcher(quotedCmd, {
      interpreterPath: winNode,
      scriptPath: winScript,
      sessionId: 'sess-1',
      realpath: fakeRealpath,
    });
    assert.deepEqual(r1, { matched: true, subcommand: 'bypass' });

    const slashCmd = `'${winSlashNode}' '${winSlashScript}' unlock --session sess-1 --write`;
    const r2 = matcher(slashCmd, {
      interpreterPath: winSlashNode,
      scriptPath: winSlashScript,
      sessionId: 'sess-1',
      realpath: fakeRealpath,
    });
    assert.deepEqual(r2, { matched: true, subcommand: 'unlock' });

    // Relative paths and drive-relative paths (C:foo) must still be rejected
    for (const rel of ['node.exe', 'C:node.exe', './node', '..\\node']) {
      const badCmd = `'${rel}' '${winScript}' bypass --session sess-1 --write`;
      assert.deepEqual(
        matcher(badCmd, { interpreterPath: rel, scriptPath: winScript, sessionId: 'sess-1', realpath: (p) => p }),
        { matched: false },
      );
    }
    // Non-matching script path on Windows must fail closed
    const badScriptCmd = `'${winNode}' 'D:\\other\\handoff.mjs' bypass --session sess-1 --write`;
    assert.deepEqual(
      matcher(badScriptCmd, { interpreterPath: winNode, scriptPath: winScript, sessionId: 'sess-1', realpath: fakeRealpath }),
      { matched: false },
    );
  }
});

test('#609: README discloses the inherited ADLC_MANIFEST_KEY self-bypass residual and Phase 1 follow-up', () => {
  const readme = readFileSync(join(REPO_ROOT, 'packages', 'context-handoff', 'README.md'), 'utf8');
  assert.match(readme, /ADLC_MANIFEST_KEY/);
  assert.match(readme, /#609/);
  assert.match(readme, /#520/);
  assert.match(readme, /advisory/i);
});

test("#806, #800, #1232: formatRecoveryCommand output on Windows paths round-trips through matchRecoveryCommand", () => {
  const winNode = "C:\\Program Files\\nodejs\\node.exe";
  const winScript = "D:\\repo\\packages\\context-handoff\\bin\\handoff.mjs";
  const fakeRealpath = (p) => p.replace(/\//g, "\\").toLowerCase();
  const pairs = [
    [formatRecoveryCommand, matchRecoveryCommand],
    [ccFormat, ccMatch],
    [codexFormat, codexMatch],
  ];
  for (const [fmt, matcher] of pairs) {
    const rendered = fmt({ interpreterPath: winNode, scriptPath: winScript, sessionId: "sess-win-1" });
    const cmdLine = rendered.split("\n")[0];
    assert.deepEqual(
      matcher(cmdLine, { interpreterPath: winNode, scriptPath: winScript, sessionId: "sess-win-1", realpath: fakeRealpath }),
      { matched: true, subcommand: "bypass" },
    );
    assert.deepEqual(
      matcher(cmdLine + " --dir /repo/.adlc --write", { interpreterPath: winNode, scriptPath: winScript, sessionId: "sess-win-1", realpath: fakeRealpath }),
      { matched: true, subcommand: "bypass" },
    );
  }
});
