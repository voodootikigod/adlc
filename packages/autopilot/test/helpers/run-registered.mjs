// How the coverage gate invokes an exported criterion function: with a scoped
// test context, so every fixture the function mints through the test-kit is
// removed once it settles — on success, failure, or a mutation-induced throw.
import { withScopedContext } from '@adlc/core/test-kit';

export const runRegistered = (fn) => withScopedContext((ctx) => fn(ctx));
