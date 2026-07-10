import { NextResponse } from 'next/server';
import { checkBotId } from 'botid/server';
import { handleContact, bodyLengthAcceptable, MAX_BODY_BYTES } from '@/lib/contact/handle.mjs';
import { selectSink } from '@/lib/contact/sinks.mjs';
import { createRateLimiter } from '@/lib/contact/rate-limit.mjs';

// Per-instance limiter (see rate-limit.mjs for the serverless caveat).
const limiter = createRateLimiter({ max: 5, windowMs: 10 * 60 * 1000 });

function allowedOrigins(): string[] {
  const raw = process.env.CONTACT_ALLOWED_ORIGINS;
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  return site ? [site] : [];
}

const TOO_LARGE = { ok: false, error: 'payload_too_large' } as const;

export async function POST(request: Request) {
  // Resource-exhaustion guard: require a Content-Length within the cap BEFORE
  // reading. A present Content-Length rules out chunked encoding, so the read is
  // bounded to MAX_BODY_BYTES; missing/oversized ⇒ 413 with nothing buffered.
  if (!bodyLengthAcceptable(request.headers.get('content-length'))) {
    return NextResponse.json(TOO_LARGE, { status: 413 });
  }
  let raw = '';
  try {
    raw = await request.text();
  } catch {
    raw = '';
  }
  if (raw.length > MAX_BODY_BYTES) {
    // Belt-and-suspenders: declared length was within cap but the body wasn't.
    return NextResponse.json(TOO_LARGE, { status: 413 });
  }
  let body: Record<string, unknown> = {};
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }

  const result = await handleContact({
    body,
    getHeader: (name: string) => request.headers.get(name),
    deps: {
      // Vercel BotID — headers are auto-extracted in production.
      checkBot: async () => await checkBotId(),
      selectSink: () => selectSink(process.env),
      rateLimit: (key: string) => limiter.check(key),
      allowedOrigins: allowedOrigins(),
    },
  });

  return NextResponse.json(result.body, { status: result.status });
}
