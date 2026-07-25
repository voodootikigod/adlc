import { buildAgentGuide } from '@/lib/agent-guide.mjs';

export const revalidate = false;

// Agent-led onboarding: a human pastes AGENT_PROMPT into whatever agent they
// already run, and the agent fetches this. Served as text/markdown so it renders
// as source in a browser and parses as markdown for the agent.
export function GET() {
  return new Response(buildAgentGuide(), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
