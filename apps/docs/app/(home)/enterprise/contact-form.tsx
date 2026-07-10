'use client';

import { useState } from 'react';
import { HONEYPOT_FIELD } from '@/lib/contact/handle.mjs';

type Status = 'idle' | 'submitting' | 'success' | 'error';

const MAILTO = 'mailto:help@agenticlifecycle.ai?subject=ADLC%20enterprise';

export function ContactForm() {
  const [status, setStatus] = useState<Status>('idle');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errorMsg, setErrorMsg] = useState<string>('');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('submitting');
    setFields({});
    setErrorMsg('');

    const form = e.currentTarget;
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') ?? ''),
      email: String(data.get('email') ?? ''),
      company: String(data.get('company') ?? ''),
      message: String(data.get('message') ?? ''),
      [HONEYPOT_FIELD]: String(data.get(HONEYPOT_FIELD) ?? ''),
    };

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        fields?: Record<string, string>;
      };
      if (res.ok && json.ok) {
        setStatus('success');
        form.reset();
        return;
      }
      if (res.status === 400 && json.fields) {
        setFields(json.fields);
        setStatus('error');
        setErrorMsg('Please fix the highlighted fields.');
        return;
      }
      setStatus('error');
      setErrorMsg(
        "Something went wrong sending your message. Please email us directly and we'll get right back to you.",
      );
    } catch {
      setStatus('error');
      setErrorMsg(
        "We couldn't reach the server. Please email us directly and we'll get right back to you.",
      );
    }
  }

  if (status === 'success') {
    return (
      <div
        className="max-w-xl rounded-lg border p-6"
        style={{ borderColor: '#3f4044', background: '#26272c' }}
      >
        <p className="font-semibold" style={{ color: '#4fb4d8' }}>
          Thanks — your message is in.
        </p>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          We read every enterprise inquiry ourselves and reply within a couple of business days.
        </p>
      </div>
    );
  }

  const inputStyle = {
    borderColor: '#3f4044',
    background: '#1c1d21',
    color: '#cbcdd2',
  };
  const labelStyle = { color: 'var(--mk-muted)' };

  return (
    <form onSubmit={onSubmit} className="max-w-xl" noValidate>
      {/* Honeypot: hidden from users, tempting to bots. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px' }}>
        <label htmlFor={HONEYPOT_FIELD}>Company website</label>
        <input
          id={HONEYPOT_FIELD}
          name={HONEYPOT_FIELD}
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="block text-sm font-medium" style={labelStyle}>
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            style={inputStyle}
          />
          {fields.name ? <p className="mt-1 text-xs" style={{ color: '#f2788a' }}>{fields.name}</p> : null}
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium" style={labelStyle}>
            Work email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            style={inputStyle}
          />
          {fields.email ? <p className="mt-1 text-xs" style={{ color: '#f2788a' }}>{fields.email}</p> : null}
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor="company" className="block text-sm font-medium" style={labelStyle}>
          Company <span style={{ opacity: 0.6 }}>(optional)</span>
        </label>
        <input
          id="company"
          name="company"
          type="text"
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
          style={inputStyle}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="message" className="block text-sm font-medium" style={labelStyle}>
          What are you rolling out?
        </label>
        <textarea
          id="message"
          name="message"
          required
          rows={5}
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
          style={inputStyle}
        />
        {fields.message ? <p className="mt-1 text-xs" style={{ color: '#f2788a' }}>{fields.message}</p> : null}
      </div>

      {status === 'error' && errorMsg ? (
        <p className="mt-4 text-sm" style={{ color: '#f2788a' }}>
          {errorMsg}{' '}
          <a href={MAILTO} className="underline" style={{ color: '#4fb4d8' }}>
            Email us instead
          </a>
          .
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={status === 'submitting'}
          className="rounded-md px-5 py-2.5 font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
          style={{ background: '#4fb4d8', color: '#1c1d21' }}
        >
          {status === 'submitting' ? 'Sending…' : 'Send message'}
        </button>
        <span className="text-sm" style={{ color: 'var(--mk-muted)' }}>
          Prefer email?{' '}
          <a href={MAILTO} className="underline" style={{ color: '#4fb4d8' }}>
            help@agenticlifecycle.ai
          </a>
        </span>
      </div>

      <p className="mt-4 text-xs" style={{ color: 'var(--mk-muted)' }}>
        We use your details only to respond to this inquiry. See our{' '}
        <a href="/privacy" className="underline" style={{ color: '#4fb4d8' }}>
          privacy policy
        </a>
        .
      </p>
    </form>
  );
}
