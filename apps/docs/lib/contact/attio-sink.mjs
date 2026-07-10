// AttioSink — asserts a record in Attio via the v2 REST API, matched by email so
// re-submits are idempotent (assert, not blind-create). The bearer token is
// never interpolated into any thrown error (PM-D / AC8).
//
// Two shapes, because Attio value formats differ by attribute type:
//   - object 'people' (standard): structured `name`/`email_addresses` values,
//     matched on `email_addresses`. This is the frozen-rail contract.
//   - any other object (a custom object like `enterprise_inquiries`): flat text
//     attributes (Attio accepts a plain string per text attribute), matched on
//     the configured email attribute.

const ATTIO_API_BASE = 'https://api.attio.com';

/**
 * @param {{ token: string, object?: string, matchAttr?: string,
 *           nameAttr?: string, emailAttr?: string, companyAttr?: string,
 *           messageAttr?: string, sourceAttr?: string, source?: string,
 *           fetch?: typeof globalThis.fetch, apiBase?: string }} opts
 */
export function createAttioSink({
  token,
  object = 'people',
  matchAttr,
  nameAttr = 'name',
  emailAttr = 'email',
  companyAttr = 'company',
  messageAttr = 'message',
  sourceAttr = 'source',
  source = 'Enterprise contact form',
  timeoutMs = 8000,
  fetch = globalThis.fetch,
  apiBase = ATTIO_API_BASE,
}) {
  const isPeople = object === 'people';
  const matching = matchAttr || (isPeople ? 'email_addresses' : emailAttr);

  return {
    async submit(lead) {
      const url = `${apiBase}/v2/objects/${object}/records?matching_attribute=${matching}`;

      let values;
      if (isPeople) {
        const parts = lead.name.split(/\s+/).filter(Boolean);
        values = {
          name: [{ first_name: parts[0] || lead.name, last_name: parts.slice(1).join(' '), full_name: lead.name }],
          email_addresses: [{ email_address: lead.email }],
        };
        if (lead.company) values[companyAttr] = lead.company;
        if (lead.message) values[messageAttr] = lead.message;
      } else {
        // Custom object: text attributes take a plain string value.
        values = {
          [nameAttr]: lead.name,
          [emailAttr]: lead.email,
          [messageAttr]: lead.message,
        };
        if (lead.company) values[companyAttr] = lead.company;
        if (sourceAttr) values[sourceAttr] = source;
      }

      let res;
      try {
        res = await fetch(url, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ data: { values } }),
          // Bounded deadline so a hung upstream can't tie up the invocation;
          // a timeout aborts the fetch and surfaces as sink_failed (502).
          signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
        });
      } catch {
        // Network failure — never echo the request (it carries the token).
        throw Object.assign(new Error('Attio request failed'), { code: 'sink_failed' });
      }
      if (!res.ok) {
        throw Object.assign(new Error(`Attio responded ${res.status}`), { code: 'sink_failed' });
      }
      return { ok: true };
    },
  };
}
