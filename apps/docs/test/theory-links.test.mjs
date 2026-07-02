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

test('all theory link ids map to their exact expected URLs', () => {
  const expectedMap = {
    // Phase gates
    P0: 'https://voodootikigod.com/adlc-1-models-arent-human',
    P1: 'https://voodootikigod.com/adlc-2-two-human-gates',
    P2: 'https://voodootikigod.com/adlc-5-three-dials-parallel-agents',
    P3: 'https://voodootikigod.com/adlc-3-tests-are-the-spec',
    P4: 'https://voodootikigod.com/adlc-3-tests-are-the-spec',
    P5: 'https://voodootikigod.com/adlc-4-prosecution-not-code-review',
    P6: 'https://voodootikigod.com/adlc-2-two-human-gates',
    P7: 'https://voodootikigod.com/adlc-6-lifecycle-gets-cheaper',
    // Failure modes
    F1: 'https://voodootikigod.com/adlc-1-models-arent-human',
    F2: 'https://voodootikigod.com/adlc-1-models-arent-human',
    F3: 'https://voodootikigod.com/adlc-1-models-arent-human',
    F4: 'https://voodootikigod.com/adlc-1-models-arent-human',
    F5: 'https://voodootikigod.com/adlc-1-models-arent-human',
    F6: 'https://voodootikigod.com/adlc-1-models-arent-human',
    F7: 'https://voodootikigod.com/adlc-1-models-arent-human',
    F8: 'https://voodootikigod.com/adlc-1-models-arent-human',
    // Named concepts
    gates: 'https://voodootikigod.com/adlc-2-two-human-gates',
    toolkit: 'https://voodootikigod.com/adlc-7-built-with-the-lifecycle',
    prosecution: 'https://voodootikigod.com/adlc-4-prosecution-not-code-review',
    'three-dials': 'https://voodootikigod.com/adlc-5-three-dials-parallel-agents',
    distill: 'https://voodootikigod.com/adlc-6-lifecycle-gets-cheaper',
    'vs-sdlc': 'https://voodootikigod.com/adlc-8-vs-enterprise-sdlc',
  };

  for (const [id, expectedUrl] of Object.entries(expectedMap)) {
    assert.equal(theoryLink(id), expectedUrl, `theory link for id "${id}" should map to exact URL`);
  }
});
