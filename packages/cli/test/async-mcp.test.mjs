import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { runStdioServer, DEFAULT_MAX_MCP_CONCURRENCY, DEFAULT_MAX_MCP_INFLIGHT } from '../lib/mcp-server.mjs';

async function waitForCondition(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

test('runStdioServer processes concurrent tools/call and tools/list requests asynchronously via handleRequestAsync without blocking the event loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'async-mcp-'));
  const prevBin = process.env.ADLC_CLI_BIN;
  try {
    const fake = join(dir, 'slow-cli.mjs');
    const logFile = join(dir, 'events.log');
    writeFileSync(fake, `import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(logFile)};
appendFileSync(log, \`start \${Date.now()}\\n\`);
await new Promise((r) => setTimeout(r, 800));
appendFileSync(log, \`end \${Date.now()}\\n\`);
console.log(\`done:\${process.argv.slice(2).join(' ')}\`);
`);
    process.env.ADLC_CLI_BIN = fake;

    const input = new PassThrough();
    const output = new PassThrough();
    const order = [];
    let buffered = '';
    output.on('data', (chunk) => {
      buffered += chunk.toString();
      let idx;
      while ((idx = buffered.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffered.slice(0, idx));
        buffered = buffered.slice(idx + 1);
        order.push(msg);
      }
    });

    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    const done = runStdioServer({ input, output, maxConcurrency: 2 });
    const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'spec-lint' } } });
    input.write(`${JSON.stringify(call(1))}\n`);
    input.write(`${JSON.stringify(call(2))}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } })}\n`);
    input.end();
    await done;
    clearInterval(timer);

    assert.equal(order.length, 4);
    assert.deepEqual(order.map((m) => m.id), [1, 2, 3, 4]);
    assert.ok(Array.isArray(order[2].result.tools));
    assert.equal(order[3].error.code, -32602);
    for (const msg of order.slice(0, 2)) {
      assert.equal(msg.result.isError, false);
      assert.equal(JSON.parse(msg.result.content[0].text).stdout, 'done:spec-lint');
    }
    // The two tool calls overlapped (not serialized) and the event loop kept ticking meanwhile.
    const events = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => l.split(' '));
    const starts = events.filter(([k]) => k === 'start').map(([, t]) => Number(t));
    const ends = events.filter(([k]) => k === 'end').map(([, t]) => Number(t));
    assert.equal(starts.length, 2);
    assert.ok(Math.max(...starts) < Math.min(...ends), 'tool calls did not run concurrently');
    assert.ok(ticks >= 5, `event loop was blocked (ticks=${ticks})`);
  } finally {
    if (prevBin === undefined) delete process.env.ADLC_CLI_BIN;
    else process.env.ADLC_CLI_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStdioServer enforces maxConcurrency semaphore, maxInflight queue bound, and AbortSignal child termination', async () => {
  assert.equal(DEFAULT_MAX_MCP_CONCURRENCY, 4);
  assert.equal(DEFAULT_MAX_MCP_INFLIGHT, 32);
  const dir = mkdtempSync(join(tmpdir(), 'async-mcp-bound-'));
  const prevBin = process.env.ADLC_CLI_BIN;
  try {
    const fake = join(dir, 'bound-cli.mjs');
    const logFile = join(dir, 'events.log');
    writeFileSync(fake, `import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(logFile)};
const ms = process.argv.includes('--json') ? 5000 : 120;
appendFileSync(log, \`start \${Date.now()}\\n\`);
await new Promise((r) => setTimeout(r, ms));
appendFileSync(log, \`end \${Date.now()}\\n\`);
console.log("ok");
`);
    process.env.ADLC_CLI_BIN = fake;
    const countStarts = () =>
      existsSync(logFile)
        ? readFileSync(logFile, 'utf8').trim().split('\n').filter((l) => l.startsWith('start ')).length
        : 0;

    const input = new PassThrough();
    const output = new PassThrough();
    const responses = [];
    let buf = '';
    output.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        responses.push(JSON.parse(buf.slice(0, idx)));
        buf = buf.slice(idx + 1);
      }
    });

    const done = runStdioServer({ input, output, maxConcurrency: 1, maxInflight: 2 });
    const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'spec-lint' } } });
    input.write(`${JSON.stringify(call(1))}\n`);
    input.write(`${JSON.stringify(call(2))}\n`);
    for (let id = 100; id < 150; id++) {
      input.write(`${JSON.stringify(call(id))}\n`);
    }
    await waitForCondition(() => responses.length >= 50);
    assert.equal(responses.length, 50, 'all 50 rejected requests emit -32000 immediately without accumulating on tail');
    for (let i = 0; i < 50; i++) {
      assert.equal(responses[i].id, 100 + i);
      assert.equal(responses[i].error.code, -32000);
      assert.match(responses[i].error.message, /Server busy/);
    }
    // Wait until both queued calls (1 and 2) actually drain rather than
    // assuming two sequential Node child spawns complete within 320ms under CI load.
    await waitForCondition(() => responses.length === 52);
    input.write(`${JSON.stringify(call(4))}\n`);
    input.end();
    await done;

    assert.equal(responses.length, 53);
    const byId = new Map(responses.map((r) => [r.id, r]));
    assert.equal(byId.get(1).result.isError, false);
    assert.equal(byId.get(2).result.isError, false);
    assert.equal(byId.get(4).result.isError, false);

    const events = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => l.split(' '));
    const starts = events.filter(([k]) => k === 'start').map(([, t]) => Number(t));
    const ends = events.filter(([k]) => k === 'end').map(([, t]) => Number(t));
    assert.equal(starts.length, 3, 'rejected third request must not spawn a child while post-drain fourth request succeeds');
    assert.ok(starts[1] >= ends[0] - 5, 'maxConcurrency:1 must serialize child execution');

    // AbortSignal cancels in-flight and queued requests and kills active child processes immediately.
    const ac = new AbortController();
    const in2 = new PassThrough();
    const out2 = new PassThrough();
    const abortDone = runStdioServer({ input: in2, output: out2, maxConcurrency: 1, maxInflight: 2, signal: ac.signal });
    const longCall = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'adlc_prosecute', arguments: { input: 'a.json', ticket: 'T1' } } });
    in2.write(`${JSON.stringify(longCall(10))}\n`);
    in2.write(`${JSON.stringify(longCall(11))}\n`);
    await waitForCondition(() => countStarts() >= 4);
    const abortStart = Date.now();
    ac.abort();
    await abortDone;
    assert.ok(Date.now() - abortStart < 3000, 'abort must kill running child well before its 5s sleep');

    // Process shutdown signals (SIGTERM/SIGINT/SIGHUP) also terminate active children when no AbortSignal is passed
    const in3 = new PassThrough();
    const out3 = new PassThrough();
    const sigDone = runStdioServer({ input: in3, output: out3, maxConcurrency: 1, maxInflight: 2 });
    in3.write(`${JSON.stringify(longCall(20))}\n`);
    await waitForCondition(() => countStarts() >= 5);
    const sigStart = Date.now();
    process.emit('SIGHUP');
    await sigDone;
    assert.ok(Date.now() - sigStart < 3000, 'process SIGHUP must kill running child well before its 5s sleep');
  } finally {
    if (prevBin === undefined) delete process.env.ADLC_CLI_BIN;
    else process.env.ADLC_CLI_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});
