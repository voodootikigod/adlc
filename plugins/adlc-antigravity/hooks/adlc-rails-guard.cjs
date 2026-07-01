#!/usr/bin/env node
/* adlc-rails-guard.cjs — fail-safe entry for the agy PreToolUse hook (spec F1/G4).
 * agy fails OPEN on a non-zero exit (V5), so this shim's ONLY jobs are: register
 * error handlers FIRST, then dynamic-import the ESM adapter inside try/catch, and
 * ALWAYS exit 0. Minimal syntax surface, zero imports at load time. */
'use strict';
var enforcing = process.env.ADLC_P4_ENFORCEMENT === '1';
function emit(v) { try { process.stdout.write(JSON.stringify(v)); } catch (_) {} process.exit(0); }
function failSafe(reason) {
  emit(enforcing ? { allow_tool: false, deny_reason: 'ADLC rails-guard: ' + reason } : { allow_tool: true });
}
process.on('uncaughtException', function (e) { failSafe('uncaught ' + (e && e.message)); });
process.on('unhandledRejection', function (e) { failSafe('rejection ' + (e && e.message)); });

var mod = process.env.ADLC_AGY_ADAPTER_OVERRIDE || (__dirname + '/adlc-rails-guard.mjs');
(async function () {
  try {
    var chunks = [];
    for await (var c of process.stdin) chunks.push(c);
    var raw = Buffer.concat(chunks).toString('utf8');
    var adapter = await import(require('node:url').pathToFileURL(mod).href);
    emit(adapter.runFromStdin(raw, process.env));
  } catch (e) { failSafe('load/exec ' + (e && e.message)); }
})();
