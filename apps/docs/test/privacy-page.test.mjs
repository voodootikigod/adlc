import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// AC9: /privacy renders and is linked from /enterprise and the footer.

const privacyPath = fileURLToPath(new URL('../app/privacy/page.tsx', import.meta.url));
const enterprisePath = fileURLToPath(new URL('../app/(home)/enterprise/page.tsx', import.meta.url));
const contactFormPath = fileURLToPath(new URL('../app/(home)/enterprise/contact-form.tsx', import.meta.url));
// The footer moved from the home page into the shared marketing layout during
// the record redesign, so every marketing route carries the privacy link rather
// than only `/`. Assert against the layout that actually renders it: pinning the
// link to page.tsx would now pass only by putting a second copy on one route.
const homeLayoutPath = fileURLToPath(new URL('../app/(home)/layout.tsx', import.meta.url));

test('the privacy page module exists and default-exports a component', () => {
  assert.ok(existsSync(privacyPath), 'app/privacy/page.tsx must exist');
  const src = readFileSync(privacyPath, 'utf8');
  assert.match(src, /export default function/);
});

test('the privacy page discloses both processors (PM-F)', () => {
  const src = readFileSync(privacyPath, 'utf8');
  assert.match(src, /Attio/);
  assert.match(src, /Resend/);
});

test('/privacy is linked from the enterprise flow and the home footer', () => {
  const enterprise = readFileSync(enterprisePath, 'utf8');
  const contactForm = readFileSync(contactFormPath, 'utf8');
  const homeLayout = readFileSync(homeLayoutPath, 'utf8');
  // The contact form (rendered on /enterprise) links to the policy...
  assert.match(contactForm, /["']\/privacy["']/);
  // ...and the marketing footer — which wraps the home page — carries the link.
  assert.match(homeLayout, /["']\/privacy["']/);
  // Sanity: the enterprise page renders the form that carries the link.
  assert.match(enterprise, /ContactForm/);
});
