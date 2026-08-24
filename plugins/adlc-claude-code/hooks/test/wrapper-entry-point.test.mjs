// adlc-hook-run entry-point detection — the pure half of the import-time deny fix.
//
// entryPointState is three-valued on purpose. 'unknown' means argv[1] could not be
// resolved on disk, and it must never collapse into 'no': the wrapper may well have been
// invoked as the entry point, and quietly declining to dispatch exits 0, which lets an
// enforcing hook's tool call through ungated — the same fail-open direction seam 6
// (PR #497) closed for timeouts.
//
// The spawned end-to-end assertions live in wrapper-import-time-deny.test.mjs, which
// deliberately does not import this module: evaluating it can exit the process, so a
// detection defect would kill an importing test file mid-load. This file accepts that
// risk in exchange for cheap injected-dependency coverage; the spawn file is the one
// that stays alive to fail.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { entryPointState, importFailureExitCode, ENFORCING_MODES } from '../adlc-hook-run.mjs';

const ADVISORY_MODES = ['preflight', 'context', 'flail', 'manifest', 'review', 'handoffstart'];

describe('adlc-hook-run entryPointState (injected realpath — no fs required)', () => {
  const realpath = (p) => {
    if (p.startsWith('/missing')) {
      const e = new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      e.code = 'ENOENT';
      throw e;
    }
    return p.replace('/link/', '/real/');
  };
  const SELF_URL = pathToFileURL('/real/hooks/adlc-hook-run.mjs').href;

  it('exact path match is "yes" without touching the filesystem', () => {
    // A broken or unreadable filesystem must not be able to demote a direct invocation
    // into a deny, so the plain string match happens before any probe.
    const boom = () => {
      throw new Error('realpath must not be called for an exact match');
    };
    assert.equal(
      entryPointState(SELF_URL, '/real/hooks/adlc-hook-run.mjs', { realpath: boom }),
      'yes',
    );
  });

  it('a symlinked argv[1] resolving to this module is "yes"', () => {
    assert.equal(entryPointState(SELF_URL, '/link/hooks/adlc-hook-run.mjs', { realpath }), 'yes');
  });

  it('a resolvable path that is a different file is "no"', () => {
    assert.equal(entryPointState(SELF_URL, '/real/hooks/other.mjs', { realpath }), 'no');
  });

  it('an absent argv[1] is "no" (nothing claims to be the entry point)', () => {
    assert.equal(entryPointState(SELF_URL, undefined, { realpath }), 'no');
    assert.equal(entryPointState(SELF_URL, '', { realpath }), 'no');
  });

  it('an unresolvable argv[1] is "unknown", never a silent "no"', () => {
    assert.equal(entryPointState(SELF_URL, '/missing/virtual-entry.mjs', { realpath }), 'unknown');
  });

  it('an unresolvable module path is "unknown" too (fail closed on both sides)', () => {
    const missingSelf = pathToFileURL('/missing/hooks/adlc-hook-run.mjs').href;
    assert.equal(entryPointState(missingSelf, '/real/hooks/other.mjs', { realpath }), 'unknown');
  });

  it('the probe never throws, whatever realpath does', () => {
    const throwing = () => {
      throw new Error('boom');
    };
    for (const argv1 of ['/x/other.mjs', '/real/hooks/adlc-hook-run.mjs', '']) {
      assert.doesNotThrow(() => entryPointState(SELF_URL, argv1, { realpath: throwing }));
    }
  });

  it('resolves a real symlink on disk (the injected realpath is not the only proof)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-entrypoint-')));
    try {
      const target = join(dir, 'target.mjs');
      const link = join(dir, 'link.mjs');
      writeFileSync(target, '');
      symlinkSync(target, link);
      const targetUrl = pathToFileURL(target).href;
      assert.equal(entryPointState(targetUrl, link), 'yes');
      assert.equal(entryPointState(targetUrl, target), 'yes');
      assert.equal(entryPointState(targetUrl, dir), 'no');
      assert.equal(entryPointState(targetUrl, join(dir, 'gone.mjs')), 'unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adlc-hook-run importFailureExitCode (fail-closed direction)', () => {
  it('every enforcing mode denies with exit 2', () => {
    for (const m of ENFORCING_MODES) assert.equal(importFailureExitCode(m), 2, m);
  });

  it('no enforcing mode ever yields exit 1 — exit 1 does not block in CC', () => {
    for (const m of ENFORCING_MODES) assert.notEqual(importFailureExitCode(m), 1, m);
  });

  it('advisory, empty and unknown modes never block', () => {
    for (const m of [...ADVISORY_MODES, '', 'bogus']) assert.equal(importFailureExitCode(m), 0, m);
  });

  it('a missing mode argument does not block', () => {
    assert.equal(importFailureExitCode(undefined), 0);
  });
});
