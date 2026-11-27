// lib/cli-capture.mjs — Shell-free CLI behavioral capture logic

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { sanitizeCandidateEnv, sha256 } from '@adlc/core';
import { MAX_BODY_BYTES } from './capture.mjs';

const DEFAULT_CLI_TIMEOUT_MS = 10_000;
const FORBIDDEN_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);

function isForbiddenShell(cmd) {
  const base = basename(cmd.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
  return FORBIDDEN_SHELLS.has(base);
}

function cmdHasDotDot(cmd) {
  return cmd.split(/[\\/]+/).includes('..');
}

export function resolveContainedCwd(cwd, baseCwd = process.cwd()) {
  const realBase = realpathSync(baseCwd);
  const realTarget = realpathSync(resolve(baseCwd, cwd));
  if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
    throw new Error(`cwd "${cwd}" resolves outside workspace root (${realBase})`);
  }
  return realTarget;
}

/**
 * Validate the `commands` array of a capture config.
 * Returns an array of error strings.
 */
export function validateCommandsConfig(commands, baseCwd = process.cwd()) {
  const errors = [];
  if (!Array.isArray(commands) || commands.length === 0) {
    errors.push('config.commands must be a non-empty array');
    return errors;
  }

  const seenIds = new Set();
  for (const [i, entry] of commands.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`config.commands[${i}] must be an object`);
      continue;
    }

    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      errors.push(`config.commands[${i}].id must be a non-empty string`);
    } else {
      const id = entry.id.trim();
      if (seenIds.has(id)) {
        errors.push(`config.commands[${i}].id duplicates an earlier "${id}" command`);
      }
      seenIds.add(id);
    }

    if (typeof entry.cmd !== 'string' || entry.cmd.trim() === '') {
      errors.push(`config.commands[${i}].cmd must be a non-empty string`);
    } else {
      const cmd = entry.cmd.trim();
      if (cmdHasDotDot(cmd)) {
        errors.push(`config.commands[${i}].cmd must not contain ".." path traversal: ${entry.cmd}`);
      }
      if (isForbiddenShell(cmd)) {
        errors.push(`config.commands[${i}].cmd forbids shell binary: ${entry.cmd}`);
      }
    }

    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string')) {
        errors.push(`config.commands[${i}].args must be an array of strings`);
      }
    }

    if (entry.stdin !== undefined && typeof entry.stdin !== 'string') {
      errors.push(`config.commands[${i}].stdin must be a string`);
    }

    if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0)) {
      errors.push(`config.commands[${i}].timeoutMs must be a positive integer`);
    }

    if (entry.cwd !== undefined) {
      if (typeof entry.cwd !== 'string' || entry.cwd.trim() === '') {
        errors.push(`config.commands[${i}].cwd must be a non-empty string`);
      } else {
        try {
          resolveContainedCwd(entry.cwd, baseCwd);
        } catch (err) {
          errors.push(`config.commands[${i}].cwd is invalid: ${err.message}`);
        }
      }
    }
  }

  return errors;
}

/**
 * Capture a single CLI command entry via shell-free spawn.
 */
export async function captureCommand(entry, defaultTimeoutMs = DEFAULT_CLI_TIMEOUT_MS, baseCwd = process.cwd()) {
  const id = typeof entry?.id === 'string' ? entry.id.trim() : String(entry?.id ?? '');
  const cmd = typeof entry?.cmd === 'string' ? entry.cmd.trim() : String(entry?.cmd ?? '');
  const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
  const timeoutMs = Number.isInteger(entry?.timeoutMs) && entry.timeoutMs > 0 ? entry.timeoutMs : defaultTimeoutMs;

  if (!id || !cmd || cmdHasDotDot(cmd) || isForbiddenShell(cmd)) {
    return { id, cmd, args, error: `invalid or forbidden command: ${cmd}` };
  }

  let resolvedCwd;
  try {
    resolvedCwd = entry.cwd !== undefined ? resolveContainedCwd(entry.cwd, baseCwd) : realpathSync(baseCwd);
  } catch (err) {
    return { id, cmd, args, error: err.message };
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    const finish = (record) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(record);
    };

    let child;
    try {
      child = spawn(cmd, args, {
        shell: false,
        cwd: resolvedCwd,
        env: sanitizeCandidateEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ id, cmd, args, error: err.message });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
      try { child.stdin?.destroy(); } catch {}
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      finish({ id, cmd, args, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();

    const outChunks = [];
    let outLen = 0;
    let outTruncated = false;

    const errChunks = [];
    let errLen = 0;

    child.stdout.on('data', (chunk) => {
      const buf = Buffer.from(chunk);
      if (outLen < MAX_BODY_BYTES) {
        const remaining = MAX_BODY_BYTES - outLen;
        if (buf.length > remaining) {
          outChunks.push(buf.subarray(0, remaining));
          outTruncated = true;
        } else {
          outChunks.push(buf);
        }
      } else {
        outTruncated = true;
      }
      outLen += buf.length;
    });

    child.stderr.on('data', (chunk) => {
      const buf = Buffer.from(chunk);
      if (errLen < MAX_BODY_BYTES) {
        const remaining = MAX_BODY_BYTES - errLen;
        errChunks.push(buf.length > remaining ? buf.subarray(0, remaining) : buf);
      }
      errLen += buf.length;
    });

    child.on('error', (err) => {
      finish({ id, cmd, args, error: err.message });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ id, cmd, args, error: `timeout after ${timeoutMs}ms` });
        return;
      }
      if (code === null) {
        finish({ id, cmd, args, error: `terminated by signal ${signal ?? 'unknown'}` });
        return;
      }

      const stdoutBuffer = Buffer.concat(outChunks);
      const stderrText = Buffer.concat(errChunks).toString('utf8');
      const stdoutText = stdoutBuffer.toString('utf8');
      const trimmed = stdoutText.trim();

      let stdoutFormat = 'text';
      let stdoutVal;
      if (!outTruncated && trimmed !== '') {
        try {
          stdoutVal = JSON.parse(stdoutText);
          stdoutFormat = 'json';
        } catch {
          stdoutFormat = 'text';
          stdoutVal = { textHash: sha256(stdoutBuffer), bytes: stdoutBuffer.length };
        }
      } else {
        stdoutVal = {
          textHash: sha256(stdoutBuffer),
          bytes: stdoutBuffer.length,
          ...(outTruncated ? { truncated: true } : {}),
        };
      }

      finish({
        id,
        cmd,
        args,
        exitCode: code,
        stdoutFormat,
        stdout: stdoutVal,
        stderr: stderrText,
      });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (typeof entry.stdin === 'string' && entry.stdin.length > 0) {
        child.stdin.end(entry.stdin, 'utf8');
      } else {
        child.stdin.end();
      }
    }
  });
}

/**
 * Capture all CLI commands in a config.
 */
export async function runCommandsCapture(commands, timeoutMs = DEFAULT_CLI_TIMEOUT_MS, baseCwd = process.cwd()) {
  const results = [];
  for (const entry of commands) {
    results.push(await captureCommand(entry, timeoutMs, baseCwd));
  }
  return results;
}
