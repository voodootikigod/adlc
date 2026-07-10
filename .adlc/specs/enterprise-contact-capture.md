# Spec: Enterprise contact capture (v1.1 — form + pluggable sink)

Source of truth: `docs/marketing/2026-07-05-adlc-marketing-site-design.md` §5
(Contact capture v1.1) and §8 (out of scope for v1). This is the deferred
v1.1 feature. Today `/enterprise` is `mailto:`-only
(`apps/docs/app/(home)/enterprise/page.tsx:63-69`).

## Goal

Replace the `mailto:`-only CTA on `/enterprise` with an on-brand contact form
that POSTs to a Next.js API route with a **pluggable sink**. The intended sink
is **Attio** (create a person record via Attio's REST API); the fallback sink
is **email via Resend** (for when Attio's free-tier API is unavailable). Ship
the prerequisites the design names: honeypot + **Vercel BotID** spam defense
(the design's Turnstile requirement is satisfied by BotID — platform-native, no
vendor account or secret), rate limiting on the route, and a published privacy
policy.

## Design decisions (binding)

1. **Pluggable sink.** A `ContactSink` interface with one method
   `submit(lead: Lead): Promise<SinkResult>`. Two implementations: `AttioSink`
   (POST to Attio REST) and `ResendSink` (email notification). The active sink
   is chosen by the `CONTACT_SINK` env var (`"attio" | "resend"`). If the
   selected sink's required secret is absent, the route fails closed with a
   specific `503` code (`sink_unconfigured`) so the client can fall back to the
   `mailto:` link — no PII is silently dropped.
2. **Secrets/config are env-only.** `ATTIO_API_TOKEN`, `ATTIO_COMPANY_ATTR`,
   `ATTIO_MESSAGE_ATTR`, `RESEND_API_KEY`, `CONTACT_FROM_EMAIL`, `CONTACT_SINK`,
   `CONTACT_NOTIFY_EMAIL`, `CONTACT_ALLOWED_ORIGINS`. Never hardcoded; documented
   in `.env.example`. **Vercel BotID needs no secret** (platform-native). All
   tests mock external HTTP — no live network, no real token in the repo.
3. **Attio target = standard `people` object.** The route creates/asserts a
   Person record using Attio's standard `people` object and standard attributes
   (`name`, `email_addresses`), with company name and message written to
   configurable attribute slugs (`ATTIO_COMPANY_ATTR`, `ATTIO_MESSAGE_ATTR`,
   defaulted, overridable) so a non-standard workspace schema is a config change,
   not a code change. Uses the assert-by-email endpoint so re-submits are
   idempotent, not duplicate-creating.
4. **Spam defense is layered.** Honeypot field is **always** checked
   (zero-dependency). **Vercel BotID** verifies the request server-side in the
   route (`checkBotId()` from `botid/server`); it is invisible to users, needs no
   vendor account or secret, and on Pro exposes Deep Analysis. Wired via
   `withBotId()` in `next.config.mjs` and `initBotId({ protect: [{ path: '/api/contact', method: 'POST' }] })`
   in `instrumentation-client.ts` (Next 16). Locally BotID is bypassed via
   `developmentOptions.bypass` (default `HUMAN`), so dev/tests need no Vercel
   runtime. A honeypot hit returns a `200` success envelope but discards the lead
   (don't teach bots the tell).
8. **Testable core (injected deps).** The route's logic lives in a pure
   `handleContact({ req, deps })` where `deps = { checkBot, selectSink, now, rateLimit }`.
   The thin Next `POST` export wires the real deps (`checkBotId`, the sink
   selector); unit tests call `handleContact` with fakes, so every branch (bot,
   honeypot, origin, rate-limit, sink-fail) is deterministic without the Vercel or
   Next runtime.
5. **Rate limiting is per-instance, best-effort for v1.** An in-memory
   fixed-window limiter keyed by client IP (5 requests / 10 min). Documented as
   per-serverless-instance (not globally consistent) with an upgrade note to a
   shared store (Upstash) — acceptable for a low-volume enterprise-contact form;
   the honeypot + BotID are the primary defenses.
6. **Progressive enhancement.** The form is the primary path; the existing
   `mailto:` link remains as an always-visible fallback so a JS-disabled or
   sink-down visitor is never stranded.
7. **Privacy policy is real content, Chris-owned.** A `/privacy` page ships with
   an on-brand draft covering what the form collects, why, the sink processors,
   and retention. Flagged for Chris's final sign-off at the P6 gate (legal text
   is his to own); the page shipping is a hard prerequisite because the form
   collects PII.

## P1 human-gate decisions (Chris, 2026-07-09)

1. **Default sink = Attio** (`CONTACT_SINK=attio`). Chris has an Attio workspace +
   token ready; the P6 deploy checklist points at live Attio. Resend stays built
   as the fallback.
2. **Spam defense = honeypot + Vercel BotID** (Pro), rate-limit, same-origin.
   Cloudflare Turnstile is explicitly **not** used (Chris: no Cloudflare). BotID
   replaces it — invisible, platform-native, no vendor keys.
3. **Privacy policy = Claude drafts, Chris signs off at P6.** Draft discloses both
   possible processors (Attio, Resend), purpose, retention, and contact-to-delete.

## Tickets

- **T-CC1** — Lead schema + pluggable sink core (`Lead` Zod schema, `ContactSink`
  interface, `AttioSink`, `ResendSink`, sink selector). Pure logic, fully unit-
  tested with mocked `fetch`.
- **T-CC2** — `POST /api/contact` route: validation, honeypot, same-origin, rate
  limit, Vercel BotID verify, sink dispatch, structured envelope. Unit-tested via
  `handleContact` with injected fake deps (bot check + sink).
- **T-CC3** — `/enterprise` form UI (client component, mailto fallback, success/
  error states) + BotID wiring (`withBotId`, `initBotId`) + `/privacy` page +
  footer link + `.env.example`.

## Acceptance criteria

- **AC1: the `Lead` schema rejects malformed input and accepts a valid lead.**
  VERIFY: `cd apps/docs && node --test test/contact-schema.test.mjs` — asserts
  empty name, invalid email, and over-long message are rejected; a well-formed
  lead parses.
- **AC2: `AttioSink` POSTs an assert-by-email person payload to the configured
  Attio endpoint with the bearer token, and maps company/message to the
  configured attribute slugs.** VERIFY: `node --test test/attio-sink.test.mjs` —
  mocked `fetch` captures the request; test asserts URL, `Authorization` header
  shape, and JSON body attribute mapping; asserts no token value is present in
  any thrown error message.
- **AC3: `ResendSink` sends a notification email to `CONTACT_NOTIFY_EMAIL` with
  the lead fields.** VERIFY: `node --test test/resend-sink.test.mjs` — mocked
  `fetch` asserts the Resend endpoint, auth header, and that the lead's name,
  email, and message appear in the email body.
- **AC4: the sink selector returns the sink named by `CONTACT_SINK`, and throws a
  typed `sink_unconfigured` error when the required secret is missing.** VERIFY:
  `node --test test/sink-select.test.mjs` — asserts selection for each value and
  the typed error when the secret env var is unset.
- **AC5: the route rejects a request whose honeypot field is filled with a `200`
  success envelope while calling the sink zero times.** VERIFY:
  `node --test test/contact-route.test.mjs` (honeypot case) — spy sink asserts
  `submit` was never called; response status is `200`.
- **AC6: the route returns `400` with field errors on invalid input, `429` when
  the rate limit is exceeded, `503` `sink_unconfigured` when the sink secret is
  absent, and `200` on a valid submission that reaches the (mocked) sink.**
  VERIFY: `node --test test/contact-route.test.mjs` — one case per status code.
- **AC7: the route returns `403` when the injected bot check reports `isBot`, and
  proceeds (reaching the sink) when it reports human.** VERIFY: `node --test test/contact-route.test.mjs`
  (botid cases) — `handleContact` with a fake `checkBot` returning bot then human;
  the sink is called zero times on bot, once on human.
- **AC8: no secret value is ever returned in a response body or logged.** VERIFY: `node --test test/contact-route.test.mjs` (leak case) — drives an Attio/sink error path and asserts the response body and captured console output contain none of the test secret values.
- **AC9: `/privacy` renders and is linked from `/enterprise` and the footer.**
  VERIFY: `cd apps/docs && npm run build` succeeds and
  `node --test test/privacy-page.test.mjs` asserts the route module exports a
  component and the enterprise page + footer contain a `/privacy` link.
- **AC10: `/enterprise` keeps a working `mailto:` fallback alongside the form.**
  VERIFY: `node --test test/enterprise-contact.test.mjs` — asserts the page
  source still contains the `mailto:chris@voodootikigod.com` href.
- **AC11: `.env.example` documents every new env var with no real values.**
  VERIFY: `node --test test/env-example.test.mjs` — asserts each var name is
  present and no value looks like a real token (no `sk-`, no long hex/base64).
- **AC12: zero regressions.** VERIFY: `cd apps/docs && npm run build && node --test 'test/*.test.mjs'`
  exits `0`; `cd apps/docs && npm run types:check` exits `0`.

## P1 premortem amendments (binding)

- **PM-A (Attio payload grounded, not guessed).** `AttioSink` builds the exact
  Attio v2 records shape: `PUT /v2/objects/people/records?matching_attribute=email_addresses`
  with body `{ data: { values: { name: [{ first_name, last_name, full_name }], email_addresses: [{ email_address }], <company_attr>: …, <message_attr>: … } } }`.
  AC2 asserts this documented shape (not an arbitrary one). Live verification
  against a real workspace is a **deploy-time checklist item** (needs a token),
  recorded at the P6 gate — not claimed as passing in CI.
- **PM-B (real client IP, bounded limiter).** The rate limiter keys on the first
  hop of `x-forwarded-for` (Next.js 16 removed `request.ip`); the fixed-window
  store **evicts** expired windows on each call so it cannot grow unbounded. The
  serverless per-instance caveat is commented at the code site, not only in this
  spec. Header spoofability is accepted because BotID is the real gate.
- **PM-C (fail closed on abuse, open on infra blip).** (1) Check order is
  honeypot → same-origin → rate limit → BotID → sink. (2) The route enforces a
  **same-origin allowlist** (Origin/Referer must match `CONTACT_ALLOWED_ORIGINS`,
  defaulted to the site origin); a cross-origin POST returns `403`. (3) A
  definitive BotID verdict (`isBot === true`) returns `403`; a BotID *infra error*
  (checkBot throws) is logged and treated as human so a real enterprise lead is
  never lost to a platform blip — honeypot, same-origin, and rate-limit remain
  active. BotID has no secret, so there is no silent-skip misconfiguration.
- **PM-D (no PII or secrets in logs/responses).** The route never logs the lead
  body, headers, or error objects that may embed the token; it logs a redacted
  event marker only. Applies to both sinks. Extends AC8.
- **PM-E (fallback fails loud, never false-success).** A Resend send failure (e.g.
  unverified `CONTACT_FROM_EMAIL`) returns `502` `sink_failed` — the client shows
  an error and the mailto fallback, never a success toast. `from` is env-config.
- **PM-F (privacy page discloses both processors).** `/privacy` names **both**
  possible processors (Attio CRM and email via Resend) as "we use one of the
  following to route your message," so the disclosure is accurate regardless of
  the configured sink.
- **PM-G (one response envelope).** Route and form share a single response-shape
  type `{ ok: true } | { ok: false, error: string, fields?: Record<string,string> }`;
  AC6/AC5 assert the exact shape the form consumes.

## New acceptance criteria (from premortem)

- **AC13: a BotID infra error fails open (through the remaining gates), not closed.** VERIFY: `node --test test/contact-route.test.mjs` (botid-error case) — an injected `checkBot` that throws still lets a clean request reach the sink (honeypot/origin/rate-limit having passed), and the thrown error is not surfaced in the response body.
- **AC14: a cross-origin POST is rejected.** VERIFY: `node --test test/contact-route.test.mjs` (origin case) — a request whose `Origin` is not in `CONTACT_ALLOWED_ORIGINS` returns `403` and the sink is called zero times.
- **AC15: a sink send failure returns `502` and never a success envelope.** VERIFY: `node --test test/contact-route.test.mjs` (sink-failure case) — a mocked sink that rejects yields a `502` `sink_failed` body with `ok: false`; no `ok: true` is ever returned on failure.

## Post-launch amendment (2026-07-10, Chris-directed)

- **Attio target is a custom object, not People.** The deployed sink defaults to
  the `enterprise_inquiries` custom object (flat text attributes, asserted by the
  `email` attribute), provisioned by `scripts/attio-provision.mjs`. `people` mode
  is preserved and selectable via `ATTIO_OBJECT=people`. This supersedes design
  decision 3's "standard People object" default. **Deploy prerequisite:** run
  `npm run attio:provision` before first traffic — provisioning fails closed if
  the unique `email` match attribute can't be created (assert-by-email needs it).
- **Bounded sink deadline.** Both sinks fetch with an `AbortSignal.timeout`
  (default 8s); a hung upstream aborts and surfaces as `sink_failed` (502 +
  mailto), so no serverless invocation hangs indefinitely.

## Rails (frozen for this build — authored from spec before implementation)

- `apps/docs/test/contact-schema.test.mjs`
- `apps/docs/test/attio-sink.test.mjs`
- `apps/docs/test/resend-sink.test.mjs`
- `apps/docs/test/sink-select.test.mjs`
- `apps/docs/test/contact-route.test.mjs`
- `apps/docs/test/enterprise-contact.test.mjs`

## Out of scope (v1.1)

- Persisting leads in a database (the sink is the system of record).
- Globally-consistent rate limiting (per-instance is accepted; Upstash is a
  documented follow-on).
- A double opt-in / confirmation email flow.
- Analytics on form conversion beyond Vercel defaults.
- Live Attio/Resend credentials and real Vercel BotID in CI (all external HTTP is
  mocked and BotID is bypassed in dev; live wiring happens at deploy on Vercel).
