// Deliberately invalid: the self-test in ../type-declarations.test.mjs points
// the compile gate here and requires a non-zero exit, so a tsc invocation that
// silently checks nothing cannot masquerade as a passing gate.
export function broken(value: ThisTypeDoesNotExist): string;
