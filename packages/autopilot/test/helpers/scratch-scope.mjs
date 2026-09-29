// One cleanup scope for scratch directories minted by helpers that are called
// without a per-test context (fixture builders, and exported criterion
// functions invoked directly by the coverage gate). Everything registered on it
// is removed when the importing process's root test finishes.
import { createScope } from '@adlc/core/test-kit';
import { after } from './node-test.mjs';

export const SCRATCH_SCOPE = createScope();
after(() => SCRATCH_SCOPE.dispose());
