import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// AC10: /enterprise keeps a working mailto: fallback alongside the form.
const enterpriseSrc = readFileSync(
  fileURLToPath(new URL('../app/(home)/enterprise/page.tsx', import.meta.url)),
  'utf8',
);
const kickoffPdf = readFileSync(
  fileURLToPath(new URL('../public/ADLC-for-Engineering-Kickoff.pdf', import.meta.url)),
);

test('the enterprise page still contains the mailto fallback', () => {
  assert.match(enterpriseSrc, /mailto:help@agenticlifecycle\.ai/);
});

test('the enterprise page renders the contact form', () => {
  assert.match(enterpriseSrc, /ContactForm/);
});

test('the enterprise page offers the engineering kickoff deck', () => {
  assert.match(enterpriseSrc, /href="\/ADLC-for-Engineering-Kickoff\.pdf"/);
  assert.match(enterpriseSrc, /download/);
  assert.ok(kickoffPdf.byteLength > 50_000, 'kickoff deck should contain the complete PDF');
  assert.equal(kickoffPdf.subarray(0, 5).toString('ascii'), '%PDF-');
});
