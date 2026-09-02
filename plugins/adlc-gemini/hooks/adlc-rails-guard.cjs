#!/usr/bin/env node
/* adlc-rails-guard.cjs — fail-safe entry for the agy PreToolUse hook (spec F1/G4).
 * agy fails OPEN on a non-zero exit (V5), so this shim's ONLY jobs are: register
 * error handlers FIRST, then dynamic-import the ESM adapter inside try/catch, and
 * ALWAYS exit 0 for tool hooks. CLI subcommands (status/doctor) print human-readable errors. */
'use strict';
var enforcing = process.env.ADLC_P4_ENFORCEMENT === '1';
function emit(v) { try { process.stdout.write(JSON.stringify(v)); } catch (_) {} process.exit(0); }
function failSafe(reason) {
  emit(enforcing ? {
    decision: 'deny',
    reason: 'ADLC rails-guard: ' + reason,
    allow_tool: false,
    deny_reason: 'ADLC rails-guard: ' + reason,
  } : {
    decision: 'allow',
    allow_tool: true,
  });
}

var MAX_STDIN_BYTES = parseInt(process.env.ADLC_MAX_STDIN_BYTES, 10) || (25 * 1024 * 1024); // 25 MiB default or configurable
async function readStdinBounded(maxBytes) {
  var limit = typeof maxBytes === 'number' ? maxBytes : MAX_STDIN_BYTES;
  var chunks = [];
  var total = 0;
  for await (var c of process.stdin) {
    total += c.length;
    if (total > limit) {
      throw new Error('payload exceeds maximum allowed stdin size');
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolveAdapterPath() {
  if (process.env.ADLC_TEST_MODE === '1' && process.env.ADLC_AGY_ADAPTER_OVERRIDE) {
    return process.env.ADLC_AGY_ADAPTER_OVERRIDE;
  }
  return __dirname + '/adlc-rails-guard.mjs';
}

var subcmd = process.argv[2];
if (subcmd === 'status' || subcmd === 'doctor') {
  var modPath = resolveAdapterPath();
  import(require('node:url').pathToFileURL(modPath).href).then(function (adapter) {
    if (subcmd === 'status') adapter.printStatus();
    else adapter.printDoctor();
  }).catch(function (err) {
    console.error('[ADLC ' + subcmd + ' error]', (err && err.message) || err);
    process.exit(1);
  });
} else if (subcmd === 'preinvocation' || subcmd === 'pre-invocation') {
  process.on('uncaughtException', function () { emit({ injectSteps: [] }); });
  process.on('unhandledRejection', function () { emit({ injectSteps: [] }); });
  var modPre = resolveAdapterPath();
  (async function () {
    try {
      var adapter = await import(require('node:url').pathToFileURL(modPre).href);
      var raw = await readStdinBounded();
      var payload = raw ? JSON.parse(raw) : {};
      emit(adapter.preInvocation(payload, { env: process.env }));
    } catch (_) { emit({ injectSteps: [] }); }
  })();
} else if (subcmd === 'posttooluse' || subcmd === 'post-tool-use') {
  process.on('uncaughtException', function () { emit({ decision: 'allow', allow_tool: true }); });
  process.on('unhandledRejection', function () { emit({ decision: 'allow', allow_tool: true }); });
  var modPost = resolveAdapterPath();
  (async function () {
    try {
      var adapter = await import(require('node:url').pathToFileURL(modPost).href);
      var raw = await readStdinBounded();
      var payload = raw ? JSON.parse(raw) : {};
      emit(adapter.postToolUse(payload, { env: process.env }));
    } catch (_) { emit({ decision: 'allow', allow_tool: true }); }
  })();
} else if (subcmd === 'stop') {
  var stopFail = function () {
    var enf = process.env.ADLC_P4_ENFORCEMENT === '1';
    emit(enf ? { decision: 'continue', reason: 'ADLC Rails-Guard: Internal error evaluating Stop hook under enforcement.' } : { decision: 'stop' });
  };
  process.on('uncaughtException', stopFail);
  process.on('unhandledRejection', stopFail);
  var modStop = resolveAdapterPath();
  (async function () {
    try {
      var adapter = await import(require('node:url').pathToFileURL(modStop).href);
      var raw = await readStdinBounded();
      var payload = raw ? JSON.parse(raw) : {};
      emit(adapter.onStop(payload, { env: process.env }));
    } catch (_) { stopFail(); }
  })();
} else {
  process.on('uncaughtException', function (e) { failSafe('uncaught ' + (e && e.message)); });
  process.on('unhandledRejection', function (e) { failSafe('rejection ' + (e && e.message)); });

  var mod = resolveAdapterPath();
  (async function () {
    try {
      var adapter = await import(require('node:url').pathToFileURL(mod).href);
      var raw = await readStdinBounded();
      emit(adapter.runFromStdin(raw, process.env));
    } catch (e) { failSafe('load/exec ' + (e && e.message)); }
  })();
}
