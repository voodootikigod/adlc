// Stands in for lib/mock-provider.mjs in the end-to-end request test: the real
// mock, unchanged, except that every request it receives is first appended to
// the file named by DECISION_REQUEST_LOG. The `?real` query keeps the import of
// the real module from being redirected back here.
import { appendFileSync } from 'node:fs';
import { MOCK_DEFAULT_RESPONSE, createMockProvider as createRealMockProvider } from '../../lib/mock-provider.mjs?real';

export { MOCK_DEFAULT_RESPONSE };

export function createMockProvider(options) {
  const real = createRealMockProvider(options);
  return {
    ...real,
    call: async (request) => {
      appendFileSync(process.env.DECISION_REQUEST_LOG, `${JSON.stringify(request)}\n`);
      return real.call(request);
    },
  };
}
