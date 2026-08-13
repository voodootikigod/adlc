// capture-transcript.test.mjs — host-side extraction of the model narrative
// from a Claude Code transcript (spec §Capture).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_NARRATIVE_BYTES,
  NARRATIVE_TRUNCATION_MARKER,
  extractFinalAssistantMessage,
  finalAssistantMessageFrom,
  parseTranscript,
} from '../lib/transcript-extract.mjs';

const line = (entry) => JSON.stringify(entry);
const assistant = (requestId, ...texts) =>
  line({
    type: 'assistant',
    requestId,
    message: { role: 'assistant', content: texts.map((text) => ({ type: 'text', text })) },
  });
const user = (text) => line({ type: 'user', message: { role: 'user', content: text } });

test('the final assistant message is the trailing run sharing one requestId', () => {
  const jsonl = [
    user('go'),
    assistant('req_1', 'an earlier turn'),
    user('keep going'),
    assistant('req_2', 'first half'),
    assistant('req_2', 'second half'),
  ].join('\n');
  assert.equal(extractFinalAssistantMessage(jsonl), 'first half\nsecond half');
});

test('an earlier request id is not swept into the final message', () => {
  const jsonl = [assistant('req_1', 'older'), assistant('req_2', 'newest')].join('\n');
  assert.equal(extractFinalAssistantMessage(jsonl), 'newest');
});

test('tool_use blocks are skipped and the surrounding text is joined', () => {
  const jsonl = line({
    type: 'assistant',
    requestId: 'req_9',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'before the call' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'after the call' },
      ],
    },
  });
  assert.equal(extractFinalAssistantMessage(jsonl), 'before the call\nafter the call');
});

test('trailing non-assistant entries do not hide the last assistant message', () => {
  const jsonl = [assistant('req_1', 'the message'), line({ type: 'user', message: { role: 'user', content: 'ok' } })].join('\n');
  assert.equal(extractFinalAssistantMessage(jsonl), 'the message');
});

test('malformed lines are skipped rather than losing the transcript', () => {
  // A live process may be mid-write on the last line; that must not cost the
  // narrative in the lines before it.
  const jsonl = ['{ not json', '[]', 'null', assistant('req_1', 'survived'), '{"half'].join('\n');
  const parsed = parseTranscript(jsonl);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.skipped, 4);
  assert.equal(finalAssistantMessageFrom(parsed.entries), 'survived');
});

test('nothing extractable reads as null, never as an empty narrative', () => {
  assert.equal(extractFinalAssistantMessage(''), null);
  assert.equal(extractFinalAssistantMessage('{ not json\n'), null);
  assert.equal(extractFinalAssistantMessage([user('only users')].join('\n')), null);
  assert.equal(extractFinalAssistantMessage(assistant('req_1', '   ')), null);
  assert.equal(
    extractFinalAssistantMessage(
      line({ type: 'assistant', requestId: 'r', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't' }] } }),
    ),
    null,
  );
  assert.equal(extractFinalAssistantMessage(null), null);
  assert.equal(finalAssistantMessageFrom(null), null);
});

test('a string content field is accepted the way the array form is', () => {
  const jsonl = line({ type: 'assistant', requestId: 'req_1', message: { role: 'assistant', content: 'plain text turn' } });
  assert.equal(extractFinalAssistantMessage(jsonl), 'plain text turn');
});

test('entries that merely both lack a requestId are not treated as one turn', () => {
  const jsonl = [
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } }),
  ].join('\n');
  assert.equal(extractFinalAssistantMessage(jsonl), 'final');
});

test('a huge narrative is capped with a visible marker', () => {
  const jsonl = assistant('req_1', 'z'.repeat(MAX_NARRATIVE_BYTES * 2));
  const got = extractFinalAssistantMessage(jsonl);
  assert.ok(got.endsWith(NARRATIVE_TRUNCATION_MARKER), 'truncation must be visible');
  assert.ok(Buffer.byteLength(got, 'utf8') <= MAX_NARRATIVE_BYTES);
});
