// Lead validation for the enterprise contact form. Dependency-free (no zod) so
// it runs under `node --test` without a build step and is shared by the API
// route and the client form. Returns a discriminated result, never throws.

export const LEAD_LIMITS = { name: 120, company: 200, message: 5000 };

// Pragmatic email check: a single @, non-empty local/domain, a dotted domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {{ name?: unknown, email?: unknown, company?: unknown, message?: unknown }} input
 * @returns {{ ok: true, value: { name: string, email: string, company: string, message: string } }
 *          | { ok: false, errors: Record<string, string> }}
 */
export function parseLead(input = {}) {
  const errors = {};
  const name = String(input.name ?? '').trim();
  const email = String(input.email ?? '').trim().toLowerCase();
  const company = String(input.company ?? '').trim();
  const message = String(input.message ?? '').trim();

  if (!name) errors.name = 'Name is required.';
  else if (name.length > LEAD_LIMITS.name)
    errors.name = `Name must be ${LEAD_LIMITS.name} characters or fewer.`;

  if (!email) errors.email = 'Email is required.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';

  if (company.length > LEAD_LIMITS.company)
    errors.company = `Company must be ${LEAD_LIMITS.company} characters or fewer.`;

  if (!message) errors.message = 'Message is required.';
  else if (message.length > LEAD_LIMITS.message)
    errors.message = `Message must be ${LEAD_LIMITS.message} characters or fewer.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, email, company, message } };
}
