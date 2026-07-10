import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'What the ADLC site collects when you contact us, why, who processes it, and how to have it removed.',
};

// DRAFT — pending Chris's sign-off at the P6 gate. Discloses both possible
// processors (Attio, Resend) so it is accurate regardless of the configured
// sink (PM-F).

const UPDATED = 'July 9, 2026';

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight" style={{ color: '#cbcdd2' }}>
        Privacy Policy
      </h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--mk-muted)' }}>
        Last updated {UPDATED}
      </p>

      <div className="mt-8 space-y-6 leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
        <section>
          <h2 className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
            Scope
          </h2>
          <p className="mt-2">
            This policy covers the ADLC marketing site and its enterprise contact form. It does not
            cover the open-source ADLC toolkit, which runs on your own machines and sends us nothing.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
            What we collect
          </h2>
          <p className="mt-2">
            When you submit the contact form we collect the information you enter: your name, your
            email address, an optional company name, and your message. We do not use tracking cookies
            or advertising trackers. Aggregate, non-identifying analytics may be collected by our
            hosting provider (Vercel) to keep the site fast and reliable.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
            Why we collect it
          </h2>
          <p className="mt-2">
            We use these details for one purpose: to read and respond to your inquiry. We do not sell
            your information, and we do not add you to a marketing list without your explicit consent.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
            Who processes it
          </h2>
          <p className="mt-2">
            To route your message we use one of the following processors, depending on our current
            configuration:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            <li>
              <strong style={{ color: '#cbcdd2' }}>Attio</strong> — a CRM that stores your inquiry so
              we can follow up. See Attio&apos;s own privacy terms for how they handle data.
            </li>
            <li>
              <strong style={{ color: '#cbcdd2' }}>Resend</strong> — an email delivery service that
              sends your message to our inbox.
            </li>
          </ul>
          <p className="mt-2">
            Bot protection on the form is provided by Vercel BotID, which analyzes request signals to
            block automated abuse and does not build advertising profiles.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
            How long we keep it
          </h2>
          <p className="mt-2">
            We retain contact inquiries only as long as needed to handle your request and any
            follow-up, and then remove them during periodic cleanups.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
            Your choices
          </h2>
          <p className="mt-2">
            You can ask us to access, correct, or delete the information you sent at any time. Email{' '}
            <a
              href="mailto:help@agenticlifecycle.ai?subject=Privacy%20request"
              className="underline"
              style={{ color: '#4fb4d8' }}
            >
              help@agenticlifecycle.ai
            </a>{' '}
            and we will take care of it.
          </p>
        </section>
      </div>
    </main>
  );
}
