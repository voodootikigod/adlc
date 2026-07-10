import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// AC10: /enterprise keeps a working mailto: fallback alongside the form.
const enterpriseSrc = readFileSync(
  fileURLToPath(new URL('../app/(home)/enterprise/page.tsx', import.meta.url)),
  'utf8',
);

test('the enterprise page still contains the mailto fallback', () => {
  assert.match(enterpriseSrc, /mailto:help@agenticlifecycle\.ai/);
});

test('the enterprise page renders the contact form', () => {
  assert.match(enterpriseSrc, /ContactForm/);
});
