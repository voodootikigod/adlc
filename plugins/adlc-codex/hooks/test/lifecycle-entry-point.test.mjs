import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnHook } from './helpers/run-hook.mjs';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(HOOKS_DIR, 'adlc-lifecycle.mjs');

const CLEAN_ENV = {
  ...process.env,
  ADLC_TICKET_STORE: '',
  ADLC_TICKETS: '',
  ADLC_TICKET: '',
};

function withSandbox(fn) {
  const raw = mkdtempSync(join(tmpdir(), 'adlc-lifecycle-space-'));
  const base = realpathSync(raw);
  try {
    const spaceRoot = join(base, 'adlc lifecycle space');
    mkdirSync(spaceRoot, { recursive: true });
    const hooksCopy = join(spaceRoot, 'hooks');
    cpSync(HOOKS_DIR, hooksCopy, {
      recursive: true,
      filter: (src) => basename(src) !== 'test',
    });

    const repoRoot = join(base, 'repo');
    mkdirSync(join(repoRoot, '.adlc'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.adlc', 'tickets.json'),
      JSON.stringify({
        tickets: [
          {
            id: 'T1',
            title: 'entry point',
            category: 'contract',
            scope: ['src/**'],
            rails: [],
            edges: [],
          },
        ],
      }),
    );
    writeFileSync(
      join(repoRoot, '.adlc', 'current-ticket.json'),
      JSON.stringify({ id: 'T1' }),
    );

    return fn({
      base,
      hookCopyPath: join(hooksCopy, 'adlc-lifecycle.mjs'),
      repoRoot,
    });
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
}

test('AC1: lifecycle hook in space-containing install path runs main() with unknown mode', () => {
  withSandbox(({ hookCopyPath, repoRoot }) => {
    const res = spawnHook([hookCopyPath, 'bogus-mode-xyz'], {
      cwd: repoRoot,
      input: '{}',
      env: CLEAN_ENV,
    });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.match(parsed.systemMessage, /unknown lifecycle mode: bogus-mode-xyz/);
  });
});

test('AC2: lifecycle hook in space-containing install path with no mode runs context mode', () => {
  withSandbox(({ hookCopyPath, repoRoot }) => {
    const res = spawnHook([hookCopyPath], {
      cwd: repoRoot,
      input: JSON.stringify({ cwd: repoRoot }),
      env: CLEAN_ENV,
    });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.match(parsed.hookSpecificOutput?.additionalContext ?? '', /ADLC current ticket: T1/);
  });
});

test('AC3: importing does not run main() and writes nothing to stdout', () => {
  withSandbox(({ base, repoRoot }) => {
    const importerPath = join(base, 'importer.mjs');
    const hookUrl = pathToFileURL(HOOK_PATH).href;
    writeFileSync(importerPath, `await import(${JSON.stringify(hookUrl)});\n`);
    const res = spawnHook([importerPath], {
      cwd: repoRoot,
      input: '',
      env: CLEAN_ENV,
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });
});

test('AC4: importing with no argv[1] does not throw', () => {
  const hookUrl = pathToFileURL(HOOK_PATH).href;
  const res = spawnHook(
    ['--input-type=module', '-e', `await import(${JSON.stringify(hookUrl)})`],
    {
      input: '',
      env: CLEAN_ENV,
    },
  );
  assert.equal(res.status, 0);
  assert.equal(res.stderr, '');
});
