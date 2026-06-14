# Security Policy

## Supported versions

The `@adlc` suite publishes in lockstep; the latest released version of each package is
the supported version. Please upgrade to the latest release before reporting an issue.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately using GitHub's
[private vulnerability reporting](https://github.com/voodootikigod/adlc/security/advisories/new),
or email **chris@voodootikigod.com** with the details.

Please include:

- The affected package and version.
- A description of the vulnerability and its impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- Any suggested remediation.

## What to expect

- We aim to acknowledge reports within **72 hours**.
- We'll work with you to confirm the issue and determine its severity.
- Once a fix is ready, we'll publish a patched release and credit you in the advisory
  (unless you prefer to remain anonymous).

## Scope notes

These are zero-dependency, offline CLI tools. Some commands invoke external processes
(`git`, test commands you pass via flags) and some optionally call LLM providers when you
supply credentials. When evaluating reports, keep in mind:

- Tools never call LLM providers unless explicitly invoked without `--prompt-only` and
  with credentials present.
- Tools never mutate the working tree without an explicit write flag.
- Test suites run fully offline.

Reports about command injection, path traversal, unsafe handling of untrusted ticket/spec
input, or accidental credential/secret leakage are especially valued.
