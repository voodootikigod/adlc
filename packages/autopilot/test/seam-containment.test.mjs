import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mutationsUrl = pathToFileURL(fileURLToPath(new URL('../lib/mutations.mjs', import.meta.url))).href;
const keysUrl = pathToFileURL(fileURLToPath(new URL('../lib/keys.mjs', import.meta.url))).href;

test('mutations state is module-private and ignores globalThis forgery', async () => {
  const { active } = await import('../lib/mutations.mjs');
  const { childEnv } = await import('../lib/keys.mjs');

  assert.equal(Object.hasOwn(globalThis, '__adlcAutopilotMutations'), false);
  const forged = { active: new Set(['keys.leakKey']), known: new Set(['keys.leakKey']) };
  globalThis.__adlcAutopilotMutations = forged;
  try {
    assert.equal(active('keys.leakKey'), false);
    const env = childEnv({ PATH: '/usr/bin' }, { key: 'k'.repeat(32) });
    assert.equal('ADLC_MANIFEST_KEY' in env, false);
  } finally {
    delete globalThis.__adlcAutopilotMutations;
  }
});

test('prototype pollution on Object.prototype does not disrupt module-private state', () => {
  const code = `
    Object.defineProperty(Object.prototype, '__adlcAutopilotMutations', {
      value: { active: [], known: [] },
      configurable: true,
    });
    const { active } = await import(${JSON.stringify(mutationsUrl)});
    await import(${JSON.stringify(keysUrl)});
    if (active('keys.leakKey') !== false) process.exit(2);
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    timeout: 15000,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child failed (status ${res.status}): ${res.stderr}`);
});

test('sealed state rejects activation and clears active seams', () => {
  const code = `
    import assert from 'node:assert/strict';
    const {
      enable,
      disable,
      clearAll,
      active,
      activeSeams,
      sealSeams,
      seamsSealed,
      withMutation,
    } = await import(${JSON.stringify(mutationsUrl)});

    enable('keys.leakKey');
    assert.equal(active('keys.leakKey'), true);
    sealSeams();

    assert.equal(seamsSealed(), true);
    assert.equal(active('keys.leakKey'), false);
    assert.deepEqual(activeSeams(), []);

    assert.throws(() => enable('keys.leakKey'), /sealed/);
    assert.throws(() => enable('no.such'), /unknown mutation seam/);

    let called = false;
    await assert.rejects(
      () => withMutation('keys.leakKey', async () => { called = true; }),
      /sealed/
    );
    assert.equal(called, false);

    assert.throws(() => active('no.such'), /unknown mutation seam/);

    assert.doesNotThrow(() => disable('keys.leakKey'));
    assert.doesNotThrow(() => clearAll());
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    timeout: 15000,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child failed (status ${res.status}): ${res.stderr}`);
});

test('unsealed semantics preserve active state and restore behavior', async () => {
  const {
    enable,
    disable,
    active,
    seamsSealed,
    withMutation,
  } = await import('../lib/mutations.mjs');

  assert.equal(seamsSealed(), false);
  assert.throws(() => enable('no.such'), /unknown mutation seam/);

  assert.equal(active('keys.leakKey'), false);
  await withMutation('keys.leakKey', async () => {
    assert.equal(active('keys.leakKey'), true);
  });
  assert.equal(active('keys.leakKey'), false);

  enable('keys.leakKey');
  try {
    assert.equal(active('keys.leakKey'), true);
    await withMutation('keys.leakKey', async () => {
      assert.equal(active('keys.leakKey'), true);
    });
    assert.equal(active('keys.leakKey'), true);
  } finally {
    disable('keys.leakKey');
  }
  assert.equal(active('keys.leakKey'), false);
});

test('bin entry seals seams before handling --help', () => {
  const probePath = fileURLToPath(new URL('./helpers/seal-probe.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [probePath, '--help'], {
    timeout: 15000,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `probe failed with status ${res.status}: ${res.stderr}`);
  assert.match(res.stdout, /adlc-autopilot/);
  const probeLine = res.stderr
    .split('\n')
    .find((line) => line.startsWith('seal-probe '));
  assert.ok(probeLine, `no seal-probe line in stderr: ${res.stderr}`);
  const payload = JSON.parse(probeLine.slice('seal-probe '.length));
  assert.deepEqual(payload, {
    sealed: true,
    active: false,
    activeSeams: [],
    enableRefused: true,
  });
});

test('importing bin does not seal seams', async () => {
  const { seamsSealed } = await import('../lib/mutations.mjs');
  await import('../bin/adlc-autopilot.mjs');
  assert.equal(seamsSealed(), false);
});
