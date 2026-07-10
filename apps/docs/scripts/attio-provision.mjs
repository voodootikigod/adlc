#!/usr/bin/env node
// Provision the Attio custom object that receives enterprise contact-form leads.
//
// Idempotent: safe to re-run. It creates only what's missing and never updates
// or deletes anything. Reads ATTIO_API_TOKEN from the environment or a .env.local
// (apps/docs/.env.local or the repo root). The token is never printed.
//
//   node apps/docs/scripts/attio-provision.mjs
//   # or, from apps/docs:  npm run attio:provision
//
// Verified against the Attio v2 REST API:
//   POST /v2/objects                      { data: { api_slug, singular_noun, plural_noun } }
//   GET  /v2/objects
//   POST /v2/objects/{object}/attributes  { data: { title, description, api_slug, type, is_required, is_unique, is_multiselect, config } }
//   GET  /v2/objects/{object}/attributes

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ATTIO_API_BASE = 'https://api.attio.com';

// The object the AttioSink will write leads into. Change these slugs only if you
// also update the sink's target configuration.
export const OBJECT = {
  api_slug: 'enterprise_inquiries',
  singular_noun: 'Enterprise Inquiry',
  plural_noun: 'Enterprise Inquiries',
};

// Attribute slugs must match what the AttioSink writes. `email` is unique so a
// repeat submission asserts (updates) the same record instead of duplicating.
// All fields are plain text to avoid Attio type-slug ambiguity; switch `email`
// to a dedicated email type in the Attio UI later if you want email features.
export const ATTRIBUTES = [
  { api_slug: 'name', title: 'Name', type: 'text', is_required: true },
  { api_slug: 'email', title: 'Email', type: 'text', is_required: true, is_unique: true },
  { api_slug: 'company', title: 'Company', type: 'text', is_required: false },
  { api_slug: 'message', title: 'Message', type: 'text', is_required: true },
  { api_slug: 'source', title: 'Source', type: 'text', is_required: false },
];

export function buildObjectPayload(obj = OBJECT) {
  return {
    data: {
      api_slug: obj.api_slug,
      singular_noun: obj.singular_noun,
      plural_noun: obj.plural_noun,
    },
  };
}

export function buildAttributePayload(attr) {
  // Attio's create-attribute endpoint requires the FULL shape — title,
  // description, api_slug, type, is_required, is_unique, is_multiselect, and
  // config are all mandatory. Omitting is_multiselect/config yields a 400
  // "Body payload validation error", so always send them.
  const data = {
    title: attr.title,
    description: attr.description ?? null,
    api_slug: attr.api_slug,
    type: attr.type,
    is_required: !!attr.is_required,
    is_unique: !!attr.is_unique,
    is_multiselect: false,
    config: {},
  };
  return { data };
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export function loadToken(env = process.env, startDir = dirname(fileURLToPath(import.meta.url))) {
  if (env.ATTIO_API_TOKEN) return env.ATTIO_API_TOKEN;
  const candidates = [
    resolve(startDir, '..', '.env.local'), // apps/docs/.env.local
    resolve(startDir, '..', '..', '..', '.env.local'), // repo root
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const token = parseEnv(readFileSync(p, 'utf8')).ATTIO_API_TOKEN;
    if (token) return token;
  }
  return '';
}

// A tiny error snippet for diagnostics. Attio error bodies carry code/message and
// never the request token, so this is safe to print.
function short(json) {
  if (!json) return '';
  const code = json.code || json.type || '';
  const message = json.message || '';
  return [code, message].filter(Boolean).join(': ').slice(0, 200);
}

export function makeApi(token, fetchImpl = globalThis.fetch) {
  return async function api(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${ATTIO_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // Never echo the request — it carries the token.
      throw new Error(`network error calling ${method} ${path}`);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, ok: res.ok, json };
  };
}

export async function provision({ api, log = console.log }) {
  // 1. Object.
  const list = await api('GET', '/v2/objects');
  if (!list.ok) throw new Error(`could not list objects (status ${list.status})`);
  const objects = list.json?.data || [];
  const exists = objects.some((o) => o.api_slug === OBJECT.api_slug);

  if (exists) {
    log(`✓ object "${OBJECT.api_slug}" already exists`);
  } else {
    const created = await api('POST', '/v2/objects', buildObjectPayload());
    if (created.status === 409) {
      log(`✓ object "${OBJECT.api_slug}" already exists (slug conflict)`);
    } else if (!created.ok) {
      throw new Error(`failed to create object (status ${created.status}) ${short(created.json)}`);
    } else {
      log(`+ created object "${OBJECT.api_slug}"`);
    }
  }

  // 2. Attributes.
  const attrsRes = await api('GET', `/v2/objects/${OBJECT.api_slug}/attributes`);
  if (!attrsRes.ok) throw new Error(`could not list attributes (status ${attrsRes.status})`);
  const existingBySlug = new Map((attrsRes.json?.data || []).map((a) => [a.api_slug, a]));

  for (const attr of ATTRIBUTES) {
    const existing = existingBySlug.get(attr.api_slug);
    if (existing) {
      // Idempotent skip — but a match attribute that already exists as NON-unique
      // is a trap: the sink asserts by it and Attio needs it unique. Fail closed
      // (only on a definite `false`; an absent flag is left alone).
      if (attr.is_unique && existing.is_unique === false) {
        throw new Error(
          `attribute "${attr.api_slug}" already exists but is NOT unique — the contact sink asserts ` +
            `records by "${attr.api_slug}" (matching_attribute), which requires uniqueness. Make it ` +
            `unique in the Attio UI, then re-run.`,
        );
      }
      log(`  ✓ attribute "${attr.api_slug}" exists`);
      continue;
    }
    const created = await api(
      'POST',
      `/v2/objects/${OBJECT.api_slug}/attributes`,
      buildAttributePayload(attr),
    );
    if (created.status === 409) {
      log(`  ✓ attribute "${attr.api_slug}" exists (slug conflict)`);
    } else if (!created.ok) {
      // Fail closed. In particular, DO NOT silently downgrade a unique match
      // attribute to non-unique: the sink asserts records by this attribute
      // (matching_attribute), which Attio requires to be unique — a non-unique
      // email would make every submit fail or duplicate. Better a loud setup
      // failure now than silent data loss in production.
      const hint = attr.is_unique
        ? ` — the contact sink asserts records by "${attr.api_slug}", which REQUIRES a unique ` +
          `attribute. Ensure your token can create unique attributes, or create "${attr.api_slug}" ` +
          `as unique in the Attio UI, then re-run.`
        : '';
      throw new Error(
        `failed to create attribute "${attr.api_slug}" (status ${created.status}) ${short(created.json)}${hint}`,
      );
    } else {
      log(`  + created attribute "${attr.api_slug}"`);
    }
  }

  return { object: OBJECT.api_slug, attributes: ATTRIBUTES.map((a) => a.api_slug) };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const token = loadToken();
  if (!token) {
    console.error(
      '✖ ATTIO_API_TOKEN not found. Add it to apps/docs/.env.local (or export it) and re-run.',
    );
    process.exit(1);
  }
  const api = makeApi(token);
  provision({ api })
    .then((r) => {
      console.log(`\nDone. Object "${r.object}" ready with attributes: ${r.attributes.join(', ')}.`);
      console.log(
        `The contact form's Attio sink already targets "${r.object}" by default ` +
          '(ATTIO_OBJECT). No further wiring needed.',
      );
    })
    .catch((e) => {
      console.error(`✖ ${e.message}`);
      process.exit(1);
    });
}
