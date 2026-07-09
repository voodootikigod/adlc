import { NextResponse } from 'next/server';
import { checkBotId } from 'botid/server';
import { handleContact } from '@/lib/contact/handle.mjs';
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

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
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
