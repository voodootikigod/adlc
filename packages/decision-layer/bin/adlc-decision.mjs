#!/usr/bin/env node
// bin/adlc-decision.mjs — thin CLI wrapper for the shadow decision layer.
import { main } from '../lib/cli.mjs';

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
