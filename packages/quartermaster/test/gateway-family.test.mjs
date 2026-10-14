// §6 family capacity: a gateway seat and a direct seat that declare the same
// provider are ONE family. The consuming cross-model gate reduces approvals to a
// set of normalized providers, so a registry that counted them as two would
// accept a trust-root group that can never be satisfied — or, with a third
// provider as author, record two same-vendor approvals as cross-family diversity.
//
// The adapter catalog is the REAL fleet catalog, as in registry-validation.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterCatalog } from '../../fleet/lib/adapters/index.mjs';
import { validateRegistry, RegistryValidationError, RULE, familyCapacity } from '../lib/registry.mjs';

const adapters = adapterCatalog();

function baseRegistry() {
  return {
    version: 3,
    channels: {
      frontier: { adapter: 'claude-code', model: 'claude-opus-5', transport: 'subscription:anthropic-max', provider: 'anthropic' },
      'frontier-metered': { adapter: 'claude-code', model: 'claude-opus-5', transport: 'api:anthropic-batch', provider: 'anthropic' },
      mid: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'gateway:opencode-go', provider: 'zai', rateWindow: '5h' },
      cheap: { adapter: 'opencode', model: 'deepseek/v4-flash', transport: 'gateway:opencode-go', provider: 'deepseek', rateWindow: '5h' },
    },
    reviewerGroups: {
      'cross-model-routine': {
        quorum: 1,
        members: [{ adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:opencode-go', provider: 'alibaba' }],
      },
      'cross-model-trust-root': {
        quorum: 2,
        members: [
          { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:opencode-go', provider: 'moonshot' },
          { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
        ],
      },
    },
    modelProviders: {
      'claude-code': { 'claude-opus-5': 'anthropic', 'claude-sonnet-5': 'anthropic', 'claude-haiku-4-5': 'anthropic' },
      codex: { 'gpt-5.3-codex': 'openai' },
      opencode: {
        'zai/glm-5.2': 'zai',
        'deepseek/v4-flash': 'deepseek',
        'qwen/qwen3.7-coder': 'alibaba',
        'moonshot/kimi-k3': 'moonshot',
        'anthropic/claude-opus-5': 'anthropic',
      },
    },
  };
}

function rejectionOf(registry) {
  try {
    validateRegistry(registry, { adapters });
  } catch (e) {
    return e;
  }
  return null;
}

const directAnthropic = {
  adapter: 'claude-code', model: 'claude-opus-5', transport: 'subscription:anthropic-max', provider: 'anthropic', directAuth: true,
};
const gatewayAnthropic = {
  adapter: 'opencode', model: 'anthropic/claude-opus-5', transport: 'gateway:opencode-go', provider: 'anthropic',
};

test('AC1: direct-anthropic + gateway-anthropic quorum-2 trust-root group is rejected', () => {
  const registry = baseRegistry();
  registry.reviewerGroups['cross-model-trust-root'].members = [directAnthropic, gatewayAnthropic];
  const error = rejectionOf(registry);
  assert.ok(error, 'expected the registry to be rejected, but it validated');
  assert.ok(error instanceof RegistryValidationError);
  const capacity = error.violations.find((v) => /independent famil/.test(v.message));
  assert.ok(capacity, `no family-capacity violation in:\n${error.message}`);
  assert.equal(capacity.rule, RULE.SCHEMA);
  assert.match(capacity.message, /quorum 2 but only 1 independent family across its 2 member\(s\)/);
  assert.match(capacity.message, /a gateway seat and a direct seat on the same provider/);
});

test('AC1: the rejection holds whichever order the members are listed in', () => {
  const registry = baseRegistry();
  registry.reviewerGroups['cross-model-trust-root'].members = [gatewayAnthropic, directAnthropic];
  assert.ok(rejectionOf(registry));
});

test('AC1: provider spelling is normalized before comparison', () => {
  assert.equal(familyCapacity([directAnthropic, { ...gatewayAnthropic, provider: ' Anthropic ' }]), 1);
});

test('AC2: transitive collapse — gateway X and gateway Y on one transport, direct Y, count 1', () => {
  const members = [
    { transport: 'gateway:mesh', provider: 'moonshot' },
    { transport: 'gateway:mesh', provider: 'openai' },
    { transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
  ];
  assert.equal(familyCapacity(members), 1);
  // Order must not matter for a union, only for a naive one-pass key.
  assert.equal(familyCapacity([members[2], members[0], members[1]]), 1);
  assert.equal(familyCapacity([members[0], members[2], members[1]]), 1);
});

test('AC2: a chain across two gateways via shared providers collapses to one family', () => {
  const members = [
    { transport: 'gateway:a', provider: 'p1' },
    { transport: 'gateway:a', provider: 'p2' },
    { transport: 'gateway:b', provider: 'p2' },
    { transport: 'gateway:b', provider: 'p3' },
    { transport: 'api:p3-direct', provider: 'p3', directAuth: true },
  ];
  assert.equal(familyCapacity(members), 1);
});

test('AC3: two direct seats on different providers count 2', () => {
  assert.equal(
    familyCapacity([
      { transport: 'subscription:anthropic-max', provider: 'anthropic' },
      { transport: 'subscription:chatgpt-plus', provider: 'openai' },
    ]),
    2
  );
});

test('AC3: two direct seats on the same provider count 1', () => {
  assert.equal(
    familyCapacity([
      { transport: 'subscription:chatgpt-plus', provider: 'openai' },
      { transport: 'api:openai-batch', provider: 'openai' },
    ]),
    1
  );
});

test('AC3: two gateway seats on one transport count 1', () => {
  assert.equal(
    familyCapacity([
      { transport: 'gateway:opencode-go', provider: 'moonshot' },
      { transport: 'gateway:opencode-go', provider: 'alibaba' },
    ]),
    1
  );
});

test('AC3: two gateway seats on different transports with different providers count 2', () => {
  assert.equal(
    familyCapacity([
      { transport: 'gateway:opencode-go', provider: 'moonshot' },
      { transport: 'gateway:other-mesh', provider: 'alibaba' },
    ]),
    2
  );
});

test('AC3: a direct seat and a gateway seat on different providers count 2', () => {
  assert.equal(familyCapacity([directAnthropic, { ...gatewayAnthropic, provider: 'moonshot' }]), 2);
});

test('a gateway seat without a declared provider joins only its transport', () => {
  assert.equal(
    familyCapacity([
      { transport: 'gateway:opencode-go' },
      { transport: 'gateway:other-mesh' },
      { transport: 'subscription:chatgpt-plus', provider: 'openai' },
    ]),
    3
  );
  assert.equal(
    familyCapacity([
      { transport: 'gateway:opencode-go' },
      { transport: 'gateway:opencode-go', provider: 'openai' },
      { transport: 'subscription:chatgpt-plus', provider: 'openai' },
    ]),
    1
  );
});

test('direct seats without a declared provider are one family, like the existing keying', () => {
  assert.equal(
    familyCapacity([{ transport: 'subscription:a' }, { transport: 'subscription:b' }]),
    1
  );
});

test('members that are not seats are ignored, and nothing is mutated', () => {
  const members = Object.freeze([
    Object.freeze({ transport: 'gateway:mesh', provider: 'moonshot' }),
    null,
    'gateway:mesh',
    Object.freeze({ provider: 'openai' }),
    Object.freeze({ transport: 'subscription:chatgpt-plus', provider: 'openai' }),
  ]);
  assert.equal(familyCapacity(members), 2);
  assert.equal(familyCapacity([]), 0);
});

test('AC3: the reference registry still validates', () => {
  assert.doesNotThrow(() => validateRegistry(baseRegistry(), { adapters }));
});

test('AC3: a group with enough independent families still validates', () => {
  const registry = baseRegistry();
  registry.reviewerGroups['cross-model-trust-root'].members = [
    directAnthropic,
    { ...gatewayAnthropic, model: 'moonshot/kimi-k3', provider: 'moonshot' },
  ];
  assert.equal(rejectionOf(registry), null);
});
