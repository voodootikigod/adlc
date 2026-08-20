// capture-redact.test.mjs — credential redaction for capture content.
//
// A capture quotes whatever the previous session was looking at and then gets
// written to disk AND pasted into the successor's prompt, so a credential that
// travels through it outlives the session that leaked it. Table-driven: every
// pattern is proven to fire, and every pattern is proven NOT to fire on a
// benign near-miss, because a redactor that eats ordinary prose is one people
// turn off.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REDACTION_PATTERNS, redactSecrets, redactionMarker } from '../lib/redact.mjs';
import { composeBrief } from '../lib/brief.mjs';
import { assertPublishableFinding } from '@adlc/core';

/** [name, the secret value itself, the near-miss that must survive intact] */
const CASES = [
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE', 'AKIA is a prefix, AKIASHORT is not a key'],
  // Same shape with a ZERO in the body: the character class is [0-9A-Z], and a
  // table that only ever tests 1-9 cannot tell that from [1-9A-Z].
  ['AWS access key id', 'AKIA0IOSFODNN7EXAMPL', 'AKIA0 alone is not a key'],
  ['AWS temporary access key id', 'ASIAIOSFODNN7EXAMPLE', 'ASIA region notes'],
  // Zero-digit twin, same reason as the AKIA0 case above: a body whose only
  // digit is 7 cannot tell [0-9A-Z] from [1-9A-Z].
  ['AWS temporary access key id', 'ASIA0IOSFODNN7EXAMPL', 'ASIA0 alone is not a key'],
  ['GitHub token', 'ghp_abcdefghij0123456789ABCDEFGHIJ0123', 'ghp_short'],
  ['GitHub fine-grained token', 'github_pat_11ABCDE0123456789abcdefghij', 'github_pat_x'],
  ['GitLab token', 'glpat-abcdefghij0123456789', 'glpat-tiny'],
  ['API key', 'sk-ant-api03-abcdefghij0123456789ABCDEFGH', 'sk-1 is too short'],
  ['Slack token', 'xoxb-123456789012-abcdefghij', 'xoxb-1'],
  ['Google API key', 'AIzaSyA0123456789abcdefghijklmnopqrstuv', 'AIza'],
  ['bearer token', 'Bearer abcdefghij0123456789ABCDEF', 'Bearer with no token'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'eyJ short'],
  // A head of EXACTLY the minimum length — 10 characters after `eyJ` — so the
  // boundary of the quantifier is exercised rather than only its comfortable
  // middle.
  ['JWT', 'eyJ0123456789.abcdefghij0.sig', 'eyJ0123456.short'],
  ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'a note about a PRIVATE KEY policy'],
];

test('every credential shape in the table is removed and named', () => {
  for (const [kind, secret] of CASES) {
    const got = redactSecrets(`before ${secret} after`);
    assert.ok(got.redactions.length > 0, `${kind} must be redacted`);
    // The CATEGORY marker, not just any marker: a broken pattern whose value
    // falls through to the high-entropy net would otherwise stay invisible.
    assert.ok(got.text.includes(redactionMarker(kind)), `${kind} must leave its own named marker`);
    assert.ok(got.text.startsWith('before '), `${kind}: surrounding prose survives`);
    assert.ok(got.text.endsWith(' after'), `${kind}: surrounding prose survives`);
    // The point of the exercise: no line of the value survives anywhere.
    for (const line of secret.split('\n')) {
      if (line.trim().length === 0) continue;
      assert.ok(!got.text.includes(line), `${kind}: "${line}" must not survive`);
    }
  }
});

test('benign near-misses are left exactly as written', () => {
  for (const [kind, , benign] of CASES) {
    const got = redactSecrets(benign);
    assert.equal(got.text, benign, `${kind}: near-miss must survive untouched`);
    assert.deepEqual(got.redactions, [], `${kind}: near-miss must not report a redaction`);
  }
});

test('an inline credential assignment keeps its key and loses its value', () => {
  const got = redactSecrets('password=hunter2hunter2 and token: abcdefgh12345678');
  assert.ok(got.text.includes(`password=${redactionMarker('credential')}`));
  assert.ok(got.text.includes(`token: ${redactionMarker('credential')}`));
  assert.ok(!got.text.includes('hunter2hunter2'));
  assert.ok(!got.text.includes('abcdefgh12345678'));

  // Short values are not credentials worth mangling a brief over.
  assert.equal(redactSecrets('token: TODO').text, 'token: TODO');
  assert.equal(redactSecrets('password policy discussion').text, 'password policy discussion');
});

test('a hash keeps its meaning through quotes, JSON and punctuation', () => {
  // The failure this guards: punctuation is not part of the value, but leaving
  // it attached both breaks the pure-hex exemption AND raises the token's
  // entropy — a uniform digest scores 4.00 bare and 4.07 quoted, so the quoted
  // form crosses the threshold. The capture would lose the content_hash the
  // successor verifies against, and only for SOME digests, which is worse.
  const uniform = '0123456789abcdef'.repeat(4);
  for (const wrapped of [`"${uniform}"`, `"${uniform}",`, `(${uniform})`, `${uniform}.`, `[${uniform}]`]) {
    const got = redactSecrets(`hash ${wrapped} end`);
    assert.ok(got.text.includes(uniform), `${wrapped.slice(0, 3)}… must survive intact`);
    assert.deepEqual(got.redactions, []);
  }

  const json = JSON.stringify({ content_hash: uniform, session_id: 'denier-1' }, null, 2);
  const round = redactSecrets(json);
  assert.equal(round.text, json, 'a JSON capture field must round-trip byte for byte');
  assert.equal(JSON.parse(round.text).content_hash, uniform);
});

test('quoting does not hide a real secret either', () => {
  // The other direction of the same fix: stripping punctuation must not become
  // a way to smuggle a credential past the classifier.
  const secret = 'Xk7Qm2ZpLr9TvB4nWsE6yH1jCdF8gAiU';
  for (const wrapped of [`"${secret}"`, `'${secret}',`, `("${secret}")`, `${secret};`]) {
    const got = redactSecrets(`value ${wrapped}`);
    assert.ok(!got.text.includes(secret), `${wrapped} must still be redacted`);
    assert.ok(got.text.includes(redactionMarker('high-entropy token')));
  }
  // …and the punctuation is preserved so the surrounding syntax still parses.
  const quoted = redactSecrets(`{"k": "${secret}"}`).text;
  assert.ok(quoted.startsWith('{"k": "['), `punctuation kept: ${quoted}`);
  assert.ok(quoted.endsWith(']"}'), `punctuation kept: ${quoted}`);
});

test('a marker from a specific rule is not re-redacted into a generic one', () => {
  // The assignment pass captures the value WITH its quote, so a check that
  // looked for a leading `[adlc:` missed the marker an earlier rule had already
  // written — replacing a named category with the generic one.
  const first = redactSecrets('api_key: "ghp_abcdefghij0123456789ABCDEFGHIJ0123"');
  assert.ok(first.text.includes(redactionMarker('GitHub token')), first.text);

  const second = redactSecrets(first.text);
  assert.equal(second.text, first.text, 'a second pass must change nothing');
  assert.ok(second.text.includes('GitHub token'), 'the specific category survives');
  assert.ok(!second.text.includes('redacted credential'), 'and is not downgraded');
  assert.deepEqual(second.redactions, []);
});

test('unlabelled high-entropy tokens go, git shas and hashes stay', () => {
  const sha = 'a'.repeat(40);
  const contentHash = '0123456789abcdef'.repeat(4); // 64-char hex, a content_hash
  const kept = `sha ${sha} hash ${contentHash}`;
  assert.equal(redactSecrets(kept).text, kept, 'hex identifiers a brief quotes must survive');

  const random = 'Xk7Qm2ZpLr9TvB4nWsE6yH1jCdF8gAiU';
  const got = redactSecrets(`leaked ${random}`);
  assert.ok(got.text.includes(redactionMarker('high-entropy token')));
  assert.ok(!got.text.includes(random));
});

test('redaction is deterministic and does not nest markers', () => {
  const input = 'password=hunter2hunter2 ghp_abcdefghij0123456789ABCDEFGHIJ0123';
  const once = redactSecrets(input).text;
  assert.equal(once, redactSecrets(input).text, 'same input, same bytes — the brief is hashed');
  const twice = redactSecrets(once).text;
  assert.equal(twice, once, 'redacting a redacted brief changes nothing');
});

test('non-string input is handled without throwing', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.deepEqual(redactSecrets(input), { text: '', redactions: [] });
  }
});

test('the redactor agrees with the ledger that these are secrets', () => {
  // Behavioural pin against packages/core/lib/ledger.mjs, which REFUSES to
  // commit a finding containing one of these shapes. The two tables live apart
  // (one detects, one rewrites); this fails if a shape core knows about stops
  // being redacted here.
  for (const [kind, secret] of CASES) {
    assert.throws(
      () => assertPublishableFinding({ desc: `finding ${secret}` }),
      `core must consider ${kind} a secret — if not, this corpus is stale`,
    );
    assert.ok(redactSecrets(secret).redactions.length > 0, `${kind} must also be redacted here`);
  }
});

test('a brief cannot be composed with a credential left in it', () => {
  // Redaction is part of composing, not a step a caller remembers: the brief is
  // persisted and pasted into a prompt on one path.
  const brief = composeBrief({
    ticketId: 'T155',
    ticketTitle: 'Rotate ghp_abcdefghij0123456789ABCDEFGHIJ0123',
    gitBranch: 'feat/AKIAIOSFODNN7EXAMPLE',
    gitStatus: [' M .env password=hunter2hunter2'],
    evidenceTail: ['seq=1 gate=build token: abcdefgh12345678'],
    modelNarrative: 'I exported Bearer abcdefghij0123456789ABCDEF to test the API.',
  });
  for (const leaked of [
    'ghp_abcdefghij0123456789ABCDEFGHIJ0123',
    'AKIAIOSFODNN7EXAMPLE',
    'hunter2hunter2',
    'abcdefgh12345678',
    'abcdefghij0123456789ABCDEF',
  ]) {
    assert.ok(!brief.includes(leaked), `${leaked} must not reach the capture`);
  }
  assert.ok(brief.includes('[adlc: redacted'), 'and the reader is told content was removed');
  // The rest of the brief still says what it said.
  assert.ok(brief.includes('- id: T155'));
  assert.ok(brief.includes('I exported'));
});

test('the pattern table is exercised, not just declared', () => {
  // A table with an entry no case covers is a rule nobody has ever seen fire.
  assert.ok(REDACTION_PATTERNS.length > 0);
  const kinds = new Set(REDACTION_PATTERNS.map(([, kind]) => kind));
  for (const kind of kinds) {
    assert.ok(
      CASES.some(([name]) => name === kind),
      `pattern "${kind}" has no case in this table`,
    );
  }
});
