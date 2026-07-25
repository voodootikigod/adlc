import { agentGuideResponse } from '@/lib/agent-guide.mjs';

// Generated at build time from repo data, so it never needs revalidating.
export const revalidate = false;

// Agent-led onboarding: a human pastes AGENT_PROMPT into whatever agent they
// already run, and the agent fetches this. The response is built in
// lib/agent-guide.mjs — this route is a one-line delegation on purpose, because
// a .ts route behind the `@/` alias cannot be imported by the test runner and
// anything expressed here would be untested.
export function GET() {
  return agentGuideResponse();
}
