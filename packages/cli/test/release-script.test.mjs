import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packagePublishOrder, repinInternalDependencies } from '../../../scripts/release.mjs';

test('release publish order keeps core first and cli last', () => {
  assert.deepEqual(
    packagePublishOrder(['spec-lint', 'cli', 'core', 'runner', 'behavior-diff']),
    ['core', 'behavior-diff', 'runner', 'spec-lint', 'cli']
  );
});

test('release repins every internal @adlc dependency kind', () => {
  const original = {
    name: '@adlc/cli',
    version: '1.0.2',
    dependencies: {
      '@adlc/core': '1.0.2',
      '@adlc/spec-lint': '1.0.2',
      chalk: '^5.0.0',
    },
    devDependencies: {
      '@adlc/runner': '1.0.2',
    },
    peerDependencies: {
      '@adlc/prosecute': '1.0.2',
    },
    optionalDependencies: {
      '@adlc/rails-guard': '1.0.2',
    },
  };

  const next = repinInternalDependencies(original, '1.1.0');

  assert.equal(next.version, '1.1.0');
  assert.equal(next.dependencies['@adlc/core'], '1.1.0');
  assert.equal(next.dependencies['@adlc/spec-lint'], '1.1.0');
  assert.equal(next.devDependencies['@adlc/runner'], '1.1.0');
  assert.equal(next.peerDependencies['@adlc/prosecute'], '1.1.0');
  assert.equal(next.optionalDependencies['@adlc/rails-guard'], '1.1.0');
  assert.equal(next.dependencies.chalk, '^5.0.0');
  assert.equal(original.version, '1.0.2');
});
