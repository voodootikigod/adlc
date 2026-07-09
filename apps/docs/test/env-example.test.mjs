import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// AC11: .env.example documents every new env var with no real values.

const src = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');

const REQUIRED_VARS = [
  'CONTACT_SINK',
  'ATTIO_API_TOKEN',
  'ATTIO_COMPANY_ATTR',
  'ATTIO_MESSAGE_ATTR',
  'RESEND_API_KEY',
  'CONTACT_FROM_EMAIL',
  'CONTACT_NOTIFY_EMAIL',
  'CONTACT_ALLOWED_ORIGINS',
];

test('documents every contact-capture env var', () => {
  for (const name of REQUIRED_VARS) {
    assert.match(src, new RegExp(`^${name}=`, 'm'), `${name} must be documented`);
  }
});

test('the secret vars carry no real values', () => {
  const lines = src.split('\n');
  const secretVars = ['ATTIO_API_TOKEN', 'RESEND_API_KEY'];
  for (const name of secretVars) {
    const line = lines.find((l) => l.startsWith(`${name}=`));
    assert.ok(line, `${name} line present`);
    const value = line.slice(name.length + 1).trim();
    assert.equal(value, '', `${name} must be empty in the example`);
  }
});

test('no value looks like a real API token', () => {
  // Guard against an accidentally-pasted secret: no sk-/re_ prefixes, no long
  // hex/base64 blobs on any assignment line.
  for (const line of src.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const value = line.slice(line.indexOf('=') + 1).trim();
    assert.ok(!/^sk-/.test(value), `suspicious sk- token: ${line}`);
    assert.ok(!/^re_[A-Za-z0-9]{10,}/.test(value), `suspicious resend token: ${line}`);
    assert.ok(!/[A-Fa-f0-9]{32,}/.test(value), `suspicious hex blob: ${line}`);
  }
});
