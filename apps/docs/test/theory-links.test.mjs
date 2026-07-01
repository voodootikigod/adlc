import { test } from 'node:test';
import assert from 'node:assert/strict';
import { theoryLink, SERIES_BASE } from '../lib/theory-links.mjs';

test('phase P5 links to the prosecution post', () => {
  assert.equal(theoryLink('P5'), 'https://voodootikigod.com/adlc-4-prosecution-not-code-review');
});

test('failure modes link to the thesis post', () => {
  for (const id of ['F1', 'F4', 'F8']) {
    assert.equal(theoryLink(id), 'https://voodootikigod.com/adlc-1-models-arent-human');
  }
});

test('unknown ids fall back to the series landing', () => {
  assert.equal(theoryLink('nope'), `${SERIES_BASE}/series/adlc`);
});

test('every resolved link is an absolute https URL', () => {
  for (const id of ['P0','P1','P2','P3','P4','P5','P6','P7','F1','F8','toolkit','three-dials','vs-sdlc','gates']) {
    assert.match(theoryLink(id), /^https:\/\/voodootikigod\.com\//);
  }
});
