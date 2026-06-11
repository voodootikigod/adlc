# Auth Module Spec

## Overview
Some context.

MUST validate JWT tokens: `jwt-cli verify $TOKEN`
SHOULD log failures: verified by audit.spec.ts
MUST encrypt at rest: exit code 0 from `encrypt-check`
SHOULD have nice UI
MUST run fast
