// ResendSink — the fallback: emails the lead to CONTACT_NOTIFY_EMAIL via Resend.
// PM-E: a send failure throws sink_failed (loud) so the route returns 502 and
// the client shows an error + mailto, never a false success. The API key is
// never interpolated into a thrown error (PM-D / AC8).

const RESEND_API_BASE = 'https://api.resend.com';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{ apiKey: string, from: string, to: string | string[],
 *           fetch?: typeof globalThis.fetch, apiBase?: string }} opts
 */
export function createResendSink({
  apiKey,
  from,
  to,
  timeoutMs = 8000,
  fetch = globalThis.fetch,
  apiBase = RESEND_API_BASE,
}) {
  const recipients = Array.isArray(to) ? to : [to];
  return {
    async submit(lead) {
      const subject = `ADLC enterprise inquiry — ${lead.name}`;
      const text = [
        `Name: ${lead.name}`,
        `Email: ${lead.email}`,
        lead.company ? `Company: ${lead.company}` : null,
        '',
        lead.message,
      ]
        .filter((line) => line !== null)
        .join('\n');
      const html =
        `<h2>${escapeHtml(subject)}</h2>` +
        `<p><strong>Email:</strong> ${escapeHtml(lead.email)}</p>` +
        (lead.company ? `<p><strong>Company:</strong> ${escapeHtml(lead.company)}</p>` : '') +
        `<p>${escapeHtml(lead.message)}</p>`;

      let res;
      try {
        res = await fetch(`${apiBase}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from, to: recipients, reply_to: lead.email, subject, text, html }),
          // Bounded deadline (see attio-sink) — timeout surfaces as sink_failed.
          signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
        });
      } catch {
        throw Object.assign(new Error('Resend request failed'), { code: 'sink_failed' });
      }
      if (!res.ok) {
        throw Object.assign(new Error(`Resend responded ${res.status}`), { code: 'sink_failed' });
      }
      return { ok: true };
    },
  };
}
