export const SERIES_BASE = 'https://voodootikigod.com';
const post = (slug) => `${SERIES_BASE}/${slug}`;

const LINKS = {
  P0: post('adlc-1-models-arent-human'),
  P1: post('adlc-2-two-human-gates'),
  P2: post('adlc-5-three-dials-parallel-agents'),
  P3: post('adlc-3-tests-are-the-spec'),
  P4: post('adlc-3-tests-are-the-spec'),
  P5: post('adlc-4-prosecution-not-code-review'),
  P6: post('adlc-2-two-human-gates'),
  P7: post('adlc-6-lifecycle-gets-cheaper'),
  F1: post('adlc-1-models-arent-human'),
  F2: post('adlc-1-models-arent-human'),
  F3: post('adlc-1-models-arent-human'),
  F4: post('adlc-1-models-arent-human'),
  F5: post('adlc-1-models-arent-human'),
  F6: post('adlc-1-models-arent-human'),
  F7: post('adlc-1-models-arent-human'),
  F8: post('adlc-1-models-arent-human'),
  gates: post('adlc-2-two-human-gates'),
  toolkit: post('adlc-7-built-with-the-lifecycle'),
  prosecution: post('adlc-4-prosecution-not-code-review'),
  'three-dials': post('adlc-5-three-dials-parallel-agents'),
  distill: post('adlc-6-lifecycle-gets-cheaper'),
  'vs-sdlc': post('adlc-8-vs-enterprise-sdlc'),
};

export function theoryLink(id) {
  return LINKS[id] ?? `${SERIES_BASE}/series/adlc`;
}
