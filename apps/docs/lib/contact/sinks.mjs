// Sink selector — picks the active ContactSink from env config (CONTACT_SINK).
// Fails closed with a typed sink_unconfigured error when the required secret is
// absent, so the route returns 503 and the client falls back to mailto rather
// than silently dropping a lead (design decision 1).

import { createAttioSink } from './attio-sink.mjs';
import { createResendSink } from './resend-sink.mjs';

export class SinkError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SinkError';
    this.code = code;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch?: typeof globalThis.fetch }} [deps]
 */
export function selectSink(env = {}, { fetch = globalThis.fetch } = {}) {
  // Attio is the contracted default (P1 gate): an operator who sets
  // ATTIO_API_TOKEN but omits CONTACT_SINK still gets the Attio path, not a 503.
  const which = env.CONTACT_SINK || 'attio';

  if (which === 'attio') {
    if (!env.ATTIO_API_TOKEN) {
      throw new SinkError('sink_unconfigured', 'ATTIO_API_TOKEN is not set');
    }
    return createAttioSink({
      token: env.ATTIO_API_TOKEN,
      // Deployed default: the custom object provisioned by
      // scripts/attio-provision.mjs. Set ATTIO_OBJECT=people to use the
      // standard People object instead.
      object: env.ATTIO_OBJECT || 'enterprise_inquiries',
      matchAttr: env.ATTIO_MATCH_ATTR || undefined,
      nameAttr: env.ATTIO_NAME_ATTR || 'name',
      emailAttr: env.ATTIO_EMAIL_ATTR || 'email',
      companyAttr: env.ATTIO_COMPANY_ATTR || 'company',
      messageAttr: env.ATTIO_MESSAGE_ATTR || 'message',
      sourceAttr: env.ATTIO_SOURCE_ATTR || 'source',
      fetch,
    });
  }

  if (which === 'resend') {
    if (!env.RESEND_API_KEY) {
      throw new SinkError('sink_unconfigured', 'RESEND_API_KEY is not set');
    }
    if (!env.CONTACT_FROM_EMAIL || !env.CONTACT_NOTIFY_EMAIL) {
      throw new SinkError(
        'sink_unconfigured',
        'CONTACT_FROM_EMAIL and CONTACT_NOTIFY_EMAIL must be set for the resend sink',
      );
    }
    return createResendSink({
      apiKey: env.RESEND_API_KEY,
      from: env.CONTACT_FROM_EMAIL,
      to: env.CONTACT_NOTIFY_EMAIL,
      fetch,
    });
  }

  throw new SinkError(
    'sink_unconfigured',
    `CONTACT_SINK must be "attio" or "resend" (got ${which ?? 'unset'})`,
  );
}
