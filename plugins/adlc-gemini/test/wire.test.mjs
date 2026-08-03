import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractToolName, extractFilePaths } from '../hooks/adlc-rails-guard.mjs';

const writePayload = { toolCall: { name: 'write_to_file', args: { TargetFile: '/repo/src/a.js', CodeContent: 'x', Overwrite: true } } };
const viewPayload  = { toolCall: { name: 'view_file', args: { AbsolutePath: '/repo/src/a.js' } } };
const runPayload   = { toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > /repo/x' } } };

test('extractToolName reads toolCall.name', () => {
  assert.equal(extractToolName(writePayload), 'write_to_file');
});
test('extractFilePaths reads write_to_file TargetFile', () => {
  assert.deepEqual(extractFilePaths(writePayload), ['/repo/src/a.js']);
});
test('extractFilePaths reads view_file AbsolutePath', () => {
  assert.deepEqual(extractFilePaths(viewPayload), ['/repo/src/a.js']);
});
test('extractFilePaths does NOT treat CommandLine as a file path', () => {
  // run_command is shell-gated by classification, not path — CommandLine is not a file path.
  assert.deepEqual(extractFilePaths(runPayload), []);
});
test('extractToolName on empty payload is empty string', () => {
  assert.equal(extractToolName({}), '');
});
