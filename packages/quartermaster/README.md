# @adlc/quartermaster

The ADLC **supply layer**: which model runs which lifecycle job, decided by the
operator — never by the repo under review, and never by a model at run time.

Implements [`docs/specs/operating-stack.md`](../../docs/specs/operating-stack.md)
§4–§5. No LLM calls. No defaults.

Two seams, nothing else:

**1. The operator-local channel registry (§4b).** `quartermaster.json` lives
outside every candidate tree. A configured path that is relative or inside the
repo under review *disables* loading with a loud notice rather than reading it,
mirroring how `adversarial-review` treats `ADVERSARIAL_REVIEW_CONFIG`. Load-time
validation enforces rules 1–7 — closed channel names, an adapter allowlist drawn
from `packages/fleet/lib/adapters/`, no argv-shaped fields at any depth, distinct
fallback transports, a closed transport taxonomy, concrete model IDs for reviewer
seats, and a complete `(adapter, model) → provider` table. Every failure is fail
closed; there are no default channels.

**2. The lifecycle-job routing contract (§5).** `routeJob` is a total function
over a closed job enum that does not trust its caller: for `build.*` jobs the
class is *derived* from `ticket.category` and `assignment.float`, and a
caller-supplied label that disagrees with the derivation throws.

```js
import { loadRegistry, routeJob, resolveRoute } from '@adlc/quartermaster';

const { registry, notices } = loadRegistry({ repoDir, adapters });
const route = routeJob({ job: 'build.critical-path', assignment, ticket });
const seat = resolveRoute(registry, route); // { adapter, model, transport, provider }
```

`assignment` is `@adlc/model-router`'s `assignTicket` output, consumed exactly as
emitted. Float comes from the **assignment**, never from the ticket: stored
tickets have no `float` field, and defaulting an absent one would silently
downgrade critical-path work to the cheap channel.

The adapter catalog is **injected** rather than imported. `@adlc/fleet` owns the
adapter modules and consumes this package, so importing it here would make the
publish graph circular — and injection keeps the alias contract adapter-owned
instead of restating harness knowledge in the validator.

## Schema reference

[`docs/integrations/quartermaster-registry.md`](../../docs/integrations/quartermaster-registry.md)
— annotated example, field reference, and the full rule table. The repo carries
no registry of its own; dispatch never reads one from the tree.

## License

MIT
