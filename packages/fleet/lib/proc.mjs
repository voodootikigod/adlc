// Process-identity probes for the lock's PID-reuse-proof liveness check
// (spec §6.4; adversarial-review N5). Re-exported from @adlc/core.

export { thisHost, pidAlive, procStartTimeOf, selfProcessIdentity as selfIdentity, defaultLockProbes as lockProbes } from '@adlc/core';
