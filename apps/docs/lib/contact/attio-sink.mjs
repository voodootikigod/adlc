// AttioSink — asserts a Person record in Attio via the v2 REST API.
// PM-A: the payload is the documented Attio v2 records shape, matched by email
// so re-submits are idempotent (assert, not blind-create). The bearer token is
// never interpolated into any thrown error (PM-D / AC8).

const ATTIO_API_BASE = 'https://api.attio.com';

/**
 * @param {{ token: string, companyAttr?: string, messageAttr?: string,
 *           fetch?: typeof globalThis.fetch, apiBase?: string }} opts
 */
export function createAttioSink({
  token,
  companyAttr = 'company',
  messageAttr = 'message',
  fetch = globalThis.fetch,
  apiBase = ATTIO_API_BASE,
}) {
  return {
    async submit(lead) {
      const url = `${apiBase}/v2/objects/people/records?matching_attribute=email_addresses`;
      const parts = lead.name.split(/\s+/).filter(Boolean);
      const firstName = parts[0] || lead.name;
      const lastName = parts.slice(1).join(' ');

      const values = {
        name: [{ first_name: firstName, last_name: lastName, full_name: lead.name }],
        email_addresses: [{ email_address: lead.email }],
      };
      if (lead.company) values[companyAttr] = lead.company;
      if (lead.message) values[messageAttr] = lead.message;

      let res;
      try {
        res = await fetch(url, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ data: { values } }),
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
