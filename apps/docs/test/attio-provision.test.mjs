import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObjectPayload,
  buildAttributePayload,
  parseEnv,
  provision,
  OBJECT,
  ATTRIBUTES,
} from '../scripts/attio-provision.mjs';

// Verifies the provisioning logic against a fake Attio API — no live token, no
// network. Covers payload shapes, idempotent skips, and the uniqueness fallback.

function fakeApi({ objects = [], attributes = [], fail = {} } = {}) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/v2/objects') {
      return { ok: true, status: 200, json: { data: objects } };
    }
    if (method === 'POST' && path === '/v2/objects') {
      return { ok: true, status: 201, json: { data: { api_slug: body.data.api_slug } } };
    }
    if (method === 'GET' && path.endsWith('/attributes')) {
      return { ok: true, status: 200, json: { data: attributes } };
    }
    if (method === 'POST' && path.endsWith('/attributes')) {
      const slug = body.data.api_slug;
      // Optional injected failure: e.g. reject unique attributes once.
      if (fail[slug] && body.data.is_unique) {
        return { ok: false, status: 400, json: { code: 'invalid', message: 'uniqueness unsupported' } };
      }
      return { ok: true, status: 201, json: { data: { api_slug: slug } } };
    }
    return { ok: false, status: 404, json: { code: 'not_found' } };
  };
  return { api, calls };
}

test('buildObjectPayload emits the data-wrapped object shape', () => {
  assert.deepEqual(buildObjectPayload(), {
    data: {
      api_slug: 'enterprise_inquiries',
      singular_noun: 'Enterprise Inquiry',
      plural_noun: 'Enterprise Inquiries',
    },
  });
});

test('buildAttributePayload emits the full Attio-required shape', () => {
  // Attio requires title, description, api_slug, type, is_required, is_unique,
  // is_multiselect, and config on every create — a partial body is a 400.
  assert.deepEqual(buildAttributePayload({ api_slug: 'name', title: 'Name', type: 'text', is_required: true }), {
    data: {
      title: 'Name',
      description: null,
      api_slug: 'name',
      type: 'text',
      is_required: true,
      is_unique: false,
      is_multiselect: false,
      config: {},
    },
  });
  const email = buildAttributePayload({ api_slug: 'email', title: 'Email', type: 'text', is_required: true, is_unique: true });
  assert.equal(email.data.is_unique, true);
});

test('parseEnv reads KEY=VALUE and strips quotes/comments', () => {
  const env = parseEnv('# comment\nATTIO_API_TOKEN="abc123"\nOTHER=plain\n');
  assert.equal(env.ATTIO_API_TOKEN, 'abc123');
  assert.equal(env.OTHER, 'plain');
});

test('creates the object and all attributes on an empty workspace', async () => {
  const { api, calls } = fakeApi();
  const result = await provision({ api, log: () => {} });
  assert.deepEqual(result, { object: OBJECT.api_slug, attributes: ATTRIBUTES.map((a) => a.api_slug) });
  // Object POST happened with the right payload.
  const objPost = calls.find((c) => c.method === 'POST' && c.path === '/v2/objects');
  assert.equal(objPost.body.data.api_slug, 'enterprise_inquiries');
  // One attribute POST per attribute.
  const attrPosts = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/attributes'));
  assert.equal(attrPosts.length, ATTRIBUTES.length);
});

test('is idempotent: skips the object and attributes that already exist', async () => {
  const { api, calls } = fakeApi({
    objects: [{ api_slug: OBJECT.api_slug }],
    attributes: ATTRIBUTES.map((a) => ({ api_slug: a.api_slug })),
  });
  await provision({ api, log: () => {} });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no writes when everything exists');
});

test('creates only the missing attributes', async () => {
  const { api, calls } = fakeApi({
    objects: [{ api_slug: OBJECT.api_slug }],
    attributes: [{ api_slug: 'name' }, { api_slug: 'email' }],
  });
  await provision({ api, log: () => {} });
  const posted = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/attributes')).map((c) => c.body.data.api_slug);
  assert.deepEqual(posted.sort(), ['company', 'message', 'source']);
});

test('fails closed when an existing email attribute is not unique', async () => {
  // A pre-existing non-unique email (manual setup or prior failed run) would
  // break assert-by-email; provisioning must refuse, not skip-and-succeed.
  const { api } = fakeApi({
    objects: [{ api_slug: OBJECT.api_slug }],
    attributes: [{ api_slug: 'email', is_unique: false }],
  });
  await assert.rejects(
    () => provision({ api, log: () => {} }),
    (err) => /email/.test(err.message) && /unique/i.test(err.message),
  );
});

test('fails closed when the unique email attribute cannot be created', async () => {
  // The sink asserts by email (matching_attribute), which needs a unique
  // attribute. If Attio rejects uniqueness, provisioning must NOT silently
  // downgrade to non-unique and report success — it must fail loudly.
  const { api, calls } = fakeApi({ fail: { email: true } });
  await assert.rejects(
    () => provision({ api, log: () => {} }),
    (err) => /email/.test(err.message) && /unique/i.test(err.message),
  );
  // Exactly one attempt for email — no silent non-unique retry.
  const emailPosts = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/attributes') && c.body.data.api_slug === 'email');
  assert.equal(emailPosts.length, 1);
  assert.equal(emailPosts[0].body.data.is_unique, true);
});
