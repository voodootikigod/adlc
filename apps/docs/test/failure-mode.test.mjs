import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_MODES } from '../lib/failure-modes.mjs';
import { theoryLink } from '../lib/theory-links.mjs';

test('all eight failure modes F1..F8 are defined with names', () => {
  for (let i = 1; i <= 8; i++) {
    const fm = FAILURE_MODES[`F${i}`];
    assert.ok(fm && typeof fm.name === 'string' && fm.name.length > 0, `F${i} missing`);
  }
});

test('F2 is Sycophancy and links to the thesis post', () => {
  assert.equal(FAILURE_MODES.F2.name, 'Sycophancy');
  assert.equal(theoryLink('F2'), 'https://voodootikigod.com/adlc-1-models-arent-human');
});

test('all failure mode names match the canonical map', () => {
  assert.equal(FAILURE_MODES.F1.name, 'Premature satisfaction');
  assert.equal(FAILURE_MODES.F2.name, 'Sycophancy');
  assert.equal(FAILURE_MODES.F3.name, 'Context rot');
  assert.equal(FAILURE_MODES.F4.name, 'Confident hallucination');
  assert.equal(FAILURE_MODES.F5.name, 'Reward hacking');
  assert.equal(FAILURE_MODES.F6.name, 'Finding-count prior');
  assert.equal(FAILURE_MODES.F7.name, 'Generative bloat');
  assert.equal(FAILURE_MODES.F8.name, 'Coherence loss');
});
