// AC2 — §4b registry validation rules 1–7: one fixture per violation, each
// rejected AT LOAD with an error naming the rule it broke.
//
// The adapter catalog comes from the REAL `packages/fleet/lib/adapters/` module,
// not a stub. Rule 2 is "adapter must name a module in that directory" and rule 6
// is "reject any alias the ADAPTER declares" — a stubbed catalog would let both
// tests pass while the production allowlist and the production alias set said
// something else entirely. (Sibling packages are imported this way elsewhere in
// the repo, e.g. packages/gate-manifest/test → ../../core/index.mjs.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterCatalog } from '../../fleet/lib/adapters/index.mjs';
import { validateRegistry, RegistryValidationError, RULE } from '../lib/registry.mjs';

const adapters = adapterCatalog();

/** The reference registry from operating-stack.md §4b — the positive control. */
function baseRegistry() {
  return {
    version: 3,
    channels: {
      // Concrete model IDs, not `default`: §4c round-11 forbids binding an alias
      // to an adapter that cannot attest what actually ran, and none can yet (§9.3).
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
      },
    },
  };
}


/**
 * The real catalog with `claude-code` upgraded to attest its resolved model —
 * i.e. the world after spec §9.3. Alias-coverage (rule 7) only becomes reachable
 * there, since §4c round-11 rejects alias channels outright until an adapter can
 * attest. Testing it against this catalog keeps the rule honest for the world it
 * governs, instead of deleting the tests because today's adapters can't get there.
 */
const attestingAdapters = {
  ...adapters,
  'claude-code': { ...adapters['claude-code'], attestsResolvedModel: true },
};

/** A base registry whose frontier channels use an alias, valid only under `attestingAdapters`. */
function aliasRegistry() {
  const r = baseRegistry();
  r.channels.frontier.model = 'default';
  r.channels['frontier-metered'].model = 'default';
  return r;
}

/** Apply `mutate` to a fresh reference registry and return it. */
function withMutation(mutate) {
  const registry = baseRegistry();
  mutate(registry);
  return registry;
}

/** Assert the fixture is rejected and that SOME violation names the expected rule. */
function assertRejected(registry, expectedRule, { messageMatch } = {}) {
  let error = null;
  try {
    validateRegistry(registry, { adapters });
  } catch (e) {
    error = e;
  }
  assert.ok(error, 'expected the registry to be REJECTED at load, but validation passed');
  assert.ok(error instanceof RegistryValidationError, `expected RegistryValidationError, got ${error.name}: ${error.message}`);
  const rules = error.violations.map((v) => v.rule);
  assert.ok(
    rules.includes(expectedRule),
    `expected a violation naming "${expectedRule}", got:\n${error.violations.map((v) => `  ${v.rule}: ${v.message}`).join('\n')}`
  );
  // The operator must be able to see WHICH rule they broke from the message alone.
  assert.match(error.message, new RegExp(expectedRule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (messageMatch) assert.match(error.message, messageMatch);
  return error;
}

test('positive control: the §4b reference registry validates', () => {
  const registry = validateRegistry(baseRegistry(), { adapters });
  assert.equal(registry.channels.frontier.adapter, 'claude-code');
  assert.equal(registry.reviewerGroups['cross-model-trust-root'].quorum, 2);
});

test('fail closed: no adapter catalog means the allowlist cannot be enforced', () => {
  assert.throws(() => validateRegistry(baseRegistry(), { adapters: {} }), RegistryValidationError);
  assert.throws(() => validateRegistry(baseRegistry(), {}), RegistryValidationError);
});

// ---------------------------------------------------------------- rule 1

test('rule 1: an unknown channel name is an error, not an extension', () => {
  assertRejected(
    withMutation((r) => {
      r.channels.turbo = { adapter: 'opencode', model: 'x/y', transport: 'gateway:opencode-go', provider: 'zai' };
    }),
    RULE.CLOSED_NAMES,
    { messageMatch: /channels\.turbo/ }
  );
});

test('rule 1: a missing §4a channel is an error', () => {
  assertRejected(
    withMutation((r) => { delete r.channels.cheap; }),
    RULE.CLOSED_NAMES,
    { messageMatch: /channels\.cheap is missing/ }
  );
});

test('rule 1: a missing §6 reviewer group is an error', () => {
  assertRejected(
    withMutation((r) => { delete r.reviewerGroups['cross-model-trust-root']; }),
    RULE.CLOSED_NAMES
  );
});

// ---------------------------------------------------------------- rule 2

test('rule 2: an adapter with no module in packages/fleet/lib/adapters/ is rejected', () => {
  assertRejected(
    withMutation((r) => { r.channels.mid.adapter = 'totally-not-an-adapter'; }),
    RULE.ADAPTER_ALLOWLIST,
    { messageMatch: /totally-not-an-adapter/ }
  );
});

test('rule 2: every adapter that can force a model is accepted on a concrete-model channel', () => {
  const forcing = Object.keys(adapters).filter((a) => adapters[a].forcesModel);
  assert.ok(forcing.length >= 3, 'the catalog must actually contain forcing adapters for this to mean anything');
  for (const adapterName of forcing) {
    const registry = withMutation((r) => {
      r.channels.mid.adapter = adapterName;
      r.channels.mid.model = 'concrete/model-id';
      r.channels.mid.provider = 'someprovider';
      // MERGE, don't replace: `codex` already maps the trust-root member's model.
      r.modelProviders[adapterName] = { ...(r.modelProviders[adapterName] ?? {}), 'concrete/model-id': 'someprovider' };
    });
    assert.doesNotThrow(() => validateRegistry(registry, { adapters }), `adapter ${adapterName} should be allowed`);
  }
});

// §4c FORCE half. Registration is not enough: an adapter that cannot pass an
// explicit model would run the harness default while the plan reported the
// registry's model. One fixture per non-forcing adapter in the REAL catalog, so
// a newly-added adapter is covered without editing this test.
test('the real catalog contains adapters that cannot force a model (otherwise the next tests are vacuous)', () => {
  const nonForcing = Object.keys(adapters).filter((a) => !adapters[a].forcesModel);
  assert.ok(nonForcing.length > 0, 'expected at least one non-forcing adapter (cursor/pi/copilot)');
});

for (const adapterName of Object.keys(adapterCatalog()).filter((a) => !adapterCatalog()[a].forcesModel)) {
  test(`§4c: a concrete-model channel on "${adapterName}" (cannot force a model) is rejected`, () => {
    assertRejected(
      withMutation((r) => {
        r.channels.mid.adapter = adapterName;
        r.channels.mid.model = 'vendor/frontier';
        r.modelProviders[adapterName] = { 'vendor/frontier': 'vendor' };
      }),
      RULE.FORCE_MODEL,
      { messageMatch: /silently run the harness default/ }
    );
  });

  test(`§4c: a reviewer seat on "${adapterName}" is rejected — reviewer models are always concrete`, () => {
    assertRejected(
      withMutation((r) => {
        r.reviewerGroups['cross-model-routine'].members[0] = {
          adapter: adapterName, model: 'vendor/reviewer', transport: 'gateway:opencode-go', provider: 'vendor',
        };
        r.modelProviders[adapterName] = { 'vendor/reviewer': 'vendor' };
      }),
      RULE.FORCE_MODEL
    );
  });

  test(`§4c: "${adapterName}" cannot use the default sentinel either — nothing attests it`, () => {
    // The sentinel used to be the honest escape for an adapter that cannot force
    // a model. §4c round-11 closes it: "ambient default" is resolved from state
    // the CANDIDATE can control, so without attestation it is an unverifiable
    // claim, not an honest one. Such an adapter can serve no channel at all today.
    assertRejected(
      withMutation((r) => {
        r.channels.mid.adapter = adapterName;
        r.channels.mid.model = 'default';
        r.modelProviders[adapterName] = { 'vendor/whatever': 'vendor' };
      }),
      RULE.ATTEST_ALIAS,
      { messageMatch: /candidate-controlled/ }
    );
  });
}

test('§4c: an adapter that does not declare forcesModel is treated as unable to force (fail closed)', () => {
  const silent = { ...adapters, quiet: { aliases: ['default'] } }; // no forcesModel key at all
  assert.throws(
    () => validateRegistry(withMutation((r) => { r.channels.mid.adapter = 'quiet'; r.channels.mid.model = 'x/y'; r.modelProviders.quiet = { 'x/y': 'vendor' }; }), { adapters: silent }),
    RegistryValidationError
  );
});

for (const key of ['command', 'args', 'argv', 'exec', 'shell', 'bin']) {
  test(`rule 2: a "${key}" (command/argv-shaped) key is rejected wherever it appears`, () => {
    assertRejected(
      withMutation((r) => { r.channels.mid[key] = 'rm -rf /'; }),
      RULE.NO_ARGV,
      { messageMatch: new RegExp(`channels\\.mid\\.${key}`) }
    );
  });
}

test('rule 2: an argv-shaped key nested deep in the document is still rejected', () => {
  assertRejected(
    withMutation((r) => { r.reviewerGroups['cross-model-routine'].members[0].command = 'curl evil'; }),
    RULE.NO_ARGV
  );
});

// ---------------------------------------------------------------- rule 3

test('rule 3: frontier and frontier-metered sharing a transport is unsatisfiable by construction', () => {
  assertRejected(
    withMutation((r) => { r.channels['frontier-metered'].transport = r.channels.frontier.transport; }),
    RULE.DISTINCT_FALLBACK,
    { messageMatch: /subscription:anthropic-max/ }
  );
});

// ---------------------------------------------------------------- rule 4

test('rule 4: an unknown transport prefix is rejected on a CHANNEL (proxy:shared)', () => {
  assertRejected(
    withMutation((r) => { r.channels.mid.transport = 'proxy:shared'; }),
    RULE.TRANSPORT_TAXONOMY,
    { messageMatch: /proxy:shared/ }
  );
});

test('rule 4: an unknown transport prefix is rejected on a REVIEWER MEMBER (proxy:shared)', () => {
  assertRejected(
    withMutation((r) => { r.reviewerGroups['cross-model-routine'].members[0].transport = 'proxy:shared'; }),
    RULE.TRANSPORT_TAXONOMY,
    { messageMatch: /proxy:shared/ }
  );
});

test('rule 4: a bare, prefix-less transport is rejected on a channel and on a member', () => {
  assertRejected(withMutation((r) => { r.channels.cheap.transport = 'opencode-go'; }), RULE.TRANSPORT_TAXONOMY);
  assertRejected(
    withMutation((r) => { r.reviewerGroups['cross-model-trust-root'].members[0].transport = 'opencode-go'; }),
    RULE.TRANSPORT_TAXONOMY
  );
});

test('rule 4: a prefix with an empty remainder is rejected (gateway: alone names nothing)', () => {
  assertRejected(withMutation((r) => { r.channels.mid.transport = 'gateway:'; }), RULE.TRANSPORT_TAXONOMY);
});

test('rule 4/§6: a non-gateway trust-root member lacking directAuth is rejected', () => {
  assertRejected(
    withMutation((r) => { delete r.reviewerGroups['cross-model-trust-root'].members[1].directAuth; }),
    RULE.DIRECT_AUTH,
    { messageMatch: /directAuth/ }
  );
});

test('rule 4/§6: a gateway member claiming directAuth is rejected', () => {
  assertRejected(
    withMutation((r) => { r.reviewerGroups['cross-model-trust-root'].members[0].directAuth = true; }),
    RULE.DIRECT_AUTH
  );
});

test('rule 4/§6: a quorum-2 group of gateway-only members can never be satisfied', () => {
  assertRejected(
    withMutation((r) => {
      const group = r.reviewerGroups['cross-model-trust-root'];
      group.members[1] = { adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:opencode-go', provider: 'alibaba' };
    }),
    RULE.DIRECT_AUTH,
    { messageMatch: /one family/ }
  );
});

// ---------------------------------------------------------------- rule 6

test('rule 6: a reviewer member with model "default" is rejected...', () => {
  assertRejected(
    withMutation((r) => { r.reviewerGroups['cross-model-routine'].members[0].model = 'default'; }),
    RULE.REVIEWER_ALIAS,
    { messageMatch: /concrete model ID/ }
  );
});

test('...while a BUILD channel with model "default" is accepted (its identity is less load-bearing)', () => {
  // The reference registry already ships `default` on frontier/frontier-metered.
  assert.doesNotThrow(() => validateRegistry(baseRegistry(), { adapters }));
});

// Rule 6 rejects ANY alias the adapter declares — not merely the literal
// 'default'. One fixture per declared alias of the two adapters that carry
// reviewer seats in the reference registry, read from the adapters themselves so
// a newly-declared alias is covered without editing this test.
// claude-code carries the LARGEST alias set and the only open-ended one, so it is
// the adapter where a silently-shrunk list does the most damage: a dropped alias
// stops being rejected and starts passing as a concrete reviewer identity —
// exactly the drift rule 6 exists to stop.
for (const adapterName of ['opencode', 'codex', 'claude-code']) {
  for (const alias of adapters[adapterName].aliases) {
    test(`rule 6: reviewer member on "${adapterName}" using its declared alias "${alias}" is rejected`, () => {
      assertRejected(
        withMutation((r) => {
          r.reviewerGroups['cross-model-trust-root'].members = [
            { adapter: adapterName, model: alias, transport: 'gateway:opencode-go', provider: 'moonshot' },
            { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
          ];
        }),
        RULE.REVIEWER_ALIAS,
        { messageMatch: new RegExp(`"${alias}" is a run-time alias`) }
      );
    });
  }
}

test('rule 6: the alias check reads the ADAPTER, so a concrete ID on the same adapter passes', () => {
  assert.doesNotThrow(() =>
    validateRegistry(
      withMutation((r) => { r.reviewerGroups['cross-model-routine'].members[0].model = 'qwen/qwen3.7-coder'; }),
      { adapters }
    )
  );
});

// ---------------------------------------------------------------- rule 7

test('rule 7: an alias-based build channel whose adapter maps NO models is rejected', () => {
  const registry = aliasRegistry();
  delete registry.modelProviders['claude-code'];
  let error = null;
  try { validateRegistry(registry, { adapters: attestingAdapters }); } catch (e) { error = e; }
  assert.ok(error, 'expected rejection');
  assert.match(error.message, /phase-2 author binding could never complete/);
  // ...and the same registry WITH a table is accepted, so the rejection is
  // about coverage rather than about aliases being refused outright.
  assert.doesNotThrow(() => validateRegistry(aliasRegistry(), { adapters: attestingAdapters }));
});

test('§4c: that very alias registry is REJECTED under the real catalog, where nothing attests', () => {
  assertRejected(aliasRegistry(), RULE.ATTEST_ALIAS);
});

test('rule 7: the same channel with a complete modelProviders table is accepted', () => {
  assert.doesNotThrow(() => validateRegistry(baseRegistry(), { adapters }));
});

test('rule 7: an alias-based channel may instead switch to a concrete model ID', () => {
  assert.doesNotThrow(() =>
    validateRegistry(
      withMutation((r) => {
        // A concrete model needs its OWN entry (it is checkable, so it is
        // checked) — but not the whole enumerable-alias table.
        r.modelProviders['claude-code'] = { 'claude-opus-5': 'anthropic' };
        r.channels.frontier.model = 'claude-opus-5';
        r.channels['frontier-metered'].model = 'claude-opus-5';
      }),
      { adapters }
    )
  );
});

test('rule 7: a concrete channel model absent from modelProviders is rejected', () => {
  assertRejected(
    withMutation((r) => { delete r.modelProviders.opencode['zai/glm-5.2']; }),
    RULE.MODEL_PROVIDERS,
    { messageMatch: /has no entry for it/ }
  );
});

test('rule 7: a concrete model mapped to a DIFFERENT provider than the seat declares is rejected', () => {
  // Worse than missing: binding would resolve the author into the wrong family
  // and could admit a same-family reviewer §6 means to exclude.
  assertRejected(
    withMutation((r) => { r.modelProviders.opencode['zai/glm-5.2'] = 'openai'; }),
    RULE.MODEL_PROVIDERS,
    { messageMatch: /same-family reviewer/ }
  );
});

test('rule 7: a reviewer member with a concrete model is checked the same way', () => {
  assertRejected(
    withMutation((r) => { delete r.modelProviders.codex['gpt-5.3-codex']; }),
    RULE.MODEL_PROVIDERS,
    { messageMatch: /reviewerGroups\.cross-model-trust-root\.members\[1\]/ }
  );
  assertRejected(
    withMutation((r) => { r.modelProviders.codex['gpt-5.3-codex'] = 'anthropic'; }),
    RULE.MODEL_PROVIDERS
  );
});

// §6: quorum counts FAMILIES, not seats.

test('quorum: members sharing one gateway transport collapse to a single family', () => {
  assertRejected(
    withMutation((r) => {
      const group = r.reviewerGroups['cross-model-trust-root'];
      group.quorum = 3;
      group.members = [
        { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:shared', provider: 'moonshot' },
        { adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:shared', provider: 'alibaba' },
        { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
      ];
    }),
    RULE.SCHEMA,
    { messageMatch: /only 2 independent families/ }
  );
});

test('quorum: two direct members on the SAME provider are one family', () => {
  assertRejected(
    withMutation((r) => {
      const group = r.reviewerGroups['cross-model-trust-root'];
      group.quorum = 2;
      group.members = [
        { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
        { adapter: 'codex', model: 'gpt-5.3-mini', transport: 'api:openai-batch', provider: 'openai', directAuth: true },
      ];
      r.modelProviders.codex['gpt-5.3-mini'] = 'openai';
    }),
    RULE.SCHEMA,
    { messageMatch: /only 1 independent family/ }
  );
});

test('quorum: distinct gateways plus a direct seat DO supply enough families', () => {
  assert.doesNotThrow(() =>
    validateRegistry(
      withMutation((r) => {
        const group = r.reviewerGroups['cross-model-trust-root'];
        group.quorum = 3;
        group.members = [
          { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:opencode-go', provider: 'moonshot' },
          { adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:other-mesh', provider: 'alibaba' },
          { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
        ];
      }),
      { adapters }
    )
  );
});

test('rule 7: an empty modelProviders table for an alias-based adapter is rejected', () => {
  assertRejected(
    withMutation((r) => { r.modelProviders['claude-code'] = {}; }),
    RULE.MODEL_PROVIDERS
  );
});

test('rule 7: a blank model key does not count as alias coverage', () => {
  // "Looks covered, resolves to nothing": a key that names no model would
  // otherwise satisfy the coverage count while binding nothing at phase 2.
  for (const blank of ['', '   ']) {
    const registry = aliasRegistry();
    registry.modelProviders['claude-code'] = { [blank]: 'anthropic' };
    let error = null;
    try { validateRegistry(registry, { adapters: attestingAdapters }); } catch (e) { error = e; }
    assert.ok(error, 'expected rejection');
    const messages = error.violations.map((v) => v.message).join('\n');
    assert.match(messages, /empty model key/, 'the blank key itself is named');
    assert.match(messages, /could never complete/, 'and it does not satisfy alias coverage');
  }
});

for (const bad of ['OpenAI', 'open ai', 'anthropic ', 'Ａnthropic', '', 42]) {
  test(`rule 7: modelProviders value ${JSON.stringify(bad)} is not a normalized provider string`, () => {
    assertRejected(
      withMutation((r) => { r.modelProviders.codex = { 'gpt-5.3-codex': bad }; }),
      RULE.MODEL_PROVIDERS
    );
  });
}

test('rule 7: a modelProviders entry for an unknown adapter is rejected', () => {
  assertRejected(
    withMutation((r) => { r.modelProviders['ghost-harness'] = { 'a/b': 'ghost' }; }),
    RULE.ADAPTER_ALLOWLIST
  );
});

test('rule 7: a channel provider that is not normalized is rejected', () => {
  assertRejected(
    withMutation((r) => { r.channels.mid.provider = 'ZAI'; }),
    RULE.MODEL_PROVIDERS,
    { messageMatch: /channels\.mid\.provider/ }
  );
});

// ---------------------------------------------------------------- rule 5

test('rule 5: a non-object registry fails closed', () => {
  for (const bad of [null, 'registry', 42, ['frontier']]) {
    assert.throws(() => validateRegistry(bad, { adapters }), RegistryValidationError);
  }
});

test('rule 5: a registry from a future schema version fails closed', () => {
  assertRejected(withMutation((r) => { r.version = 4; }), RULE.SCHEMA, { messageMatch: /version must be 3/ });
});

test('rule 5: a channel missing a required field fails closed with no default', () => {
  assertRejected(withMutation((r) => { delete r.channels.mid.provider; }), RULE.SCHEMA, { messageMatch: /channels\.mid\.provider/ });
  assertRejected(withMutation((r) => { delete r.channels.mid.model; }), RULE.SCHEMA);
  assertRejected(withMutation((r) => { delete r.channels.mid.transport; }), RULE.TRANSPORT_TAXONOMY);
});

test('rule 5: an unknown key anywhere is an error, not an extension', () => {
  assertRejected(withMutation((r) => { r.channels.mid.fallbackTo = 'cheap'; }), RULE.SCHEMA, { messageMatch: /fallbackTo/ });
  assertRejected(withMutation((r) => { r.extras = { hi: 1 }; }), RULE.SCHEMA, { messageMatch: /registry\.extras/ });
});

test('rule 5: a quorum larger than the member list is unsatisfiable and rejected', () => {
  assertRejected(
    withMutation((r) => { r.reviewerGroups['cross-model-trust-root'].quorum = 3; }),
    RULE.SCHEMA,
    { messageMatch: /exceeds its 2 member/ }
  );
});

test('rule 5: the trust-root group must carry quorum >= 2 (§6)', () => {
  assertRejected(
    withMutation((r) => { r.reviewerGroups['cross-model-trust-root'].quorum = 1; }),
    RULE.SCHEMA,
    { messageMatch: /quorum must be an integer >= 2/ }
  );
});

test('rule 5: a malformed rateWindow is rejected', () => {
  assertRejected(withMutation((r) => { r.channels.mid.rateWindow = 'five hours'; }), RULE.SCHEMA);
});

test('every violation is reported at once, so one fix does not merely reveal the next', () => {
  const error = assertRejected(
    withMutation((r) => {
      r.channels.mid.adapter = 'nope';
      r.channels.mid.transport = 'proxy:shared';
      delete r.channels.cheap;
    }),
    RULE.ADAPTER_ALLOWLIST
  );
  const rules = new Set(error.violations.map((v) => v.rule));
  assert.ok(rules.has(RULE.ADAPTER_ALLOWLIST));
  assert.ok(rules.has(RULE.TRANSPORT_TAXONOMY));
  assert.ok(rules.has(RULE.CLOSED_NAMES));
});
