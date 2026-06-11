# Feature Spec

## Requirements

- Database writes must succeed: `db.write()` returns true
- Cache invalidation works: assert stale entries purged

## Definition of Done

* Deployed to staging: `deploy.sh staging && exit code 0`
* All tests green: verified by ci/pipeline.test.yml

## Success

1. Smoke test passes: `smoke-test.sh` asserts HTTP 200
2. Metrics collected: test: prometheus scrape returns non-empty

## Random heading

- This item should NOT appear in output
