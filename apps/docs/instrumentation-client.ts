import { initBotId } from 'botid/client/core';

// Register the paths Vercel BotID protects. The contact route is the only
// mutating public endpoint; BotID injects its client signals for these paths so
// checkBotId() can verify them server-side.
initBotId({
  protect: [{ path: '/api/contact', method: 'POST' }],
});
