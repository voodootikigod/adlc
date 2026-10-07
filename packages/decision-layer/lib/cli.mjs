// `adlc decision` — the command-line front end.
import { parseCommand, validateConfig } from './config.mjs';
import { ConfigError } from './errors.mjs';
import { runEvaluate } from './evaluate.mjs';

export const USAGE = `adlc decision evaluate --mode shadow --provider <jev|mock> --model <id> \\
  --pack <pack-id> [--revision <rev>] [--ticket <id>] [--pr <number>] \\
  [--mock-response <file>] [--json]

Ask a typed classifier a versioned question pack about a change and record the
answers to .adlc/decisions/runs.jsonl in the main checkout. Shadow mode only:
the answers never change an exit code, ticket, rail, routing or verdict.

  --mode            off (default: does nothing) or shadow
  --provider        mock, or jev (not available until its live fixture exists)
  --model           model identifier to request
  --pack            question pack ID (shipped: change-risk-v1)
  --revision        revision to describe (default HEAD)
  --ticket, --pr    join keys recorded with the run; never sent to the provider
  --mock-response   with --provider mock: file holding the reply to return
  --json            print the run record as JSON

Exit codes:
  0  the run was recorded (whatever the answers), or --mode off
  1  a configuration, pack, git-output or sanitization failure before dispatch:
     nothing was sent and nothing recorded; or the record could not be written: the
     provider may have been asked, but the run was not recorded`;

/**
 * @param {string[]} argv
 * @param {{ cwd: string, env: Record<string, string|undefined>, stdout: { write: (s: string) => void }, stderr: { write: (s: string) => void } }} io
 * @returns {Promise<0|1>}
 */
export async function main(argv, { cwd, env, stdout, stderr }) {
  let config;
  let json = false;
  try {
    const { command, options } = parseCommand(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (command !== 'evaluate') throw new ConfigError(command === undefined ? 'missing command; expected "evaluate"' : `unknown command "${command}"; expected "evaluate"`);
    json = options.json === true;
    config = validateConfig(options, env);
  } catch (error) {
    stderr.write(`adlc decision: ${error.message}\n`);
    return 1;
  }
  const result = await runEvaluate(config, { cwd });
  if (result.exitCode !== 0) {
    stderr.write(`adlc decision: ${result.error.message}\n`);
    return 1;
  }
  if (!result.record) return 0;
  if (json) {
    stdout.write(`${JSON.stringify(result.record)}\n`);
  } else {
    stdout.write(`decision: ${result.record.outcome} (status ${result.record.status}) recorded to ${result.path}\n`);
  }
  return 0;
}
