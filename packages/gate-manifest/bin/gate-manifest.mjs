#!/usr/bin/env node
// gate-manifest — ADLC C11 hash-chained agentic provenance ledger.
// Verbs: record | verify | show | attest | repair-chain | generate-key

import { parseArgs, pass, gateFail, opError, printJson } from '@adlc/core';
import { record, parseData, ticketCompletionReminder } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';
import { loadFiltered, renderEntries } from '../lib/show.mjs';
import { buildAttest } from '../lib/attest.mjs';
import { repairChain } from '../lib/repair.mjs';
import { enable, boundedSegmentationState, CI_COVERAGE_WARNING, SEGMENTATION_UNDETERMINED_WARNING } from '../lib/enable.mjs';
import { adopt } from '../lib/adopt.mjs';
import { migrate } from '../lib/migrate.mjs';
import { ADLC_DIR } from '@adlc/core';
import { getKey } from '../lib/sign.mjs';
import { resolveCeremonyKey, writeKeyHandoffFile, computeKeyFingerprint } from '../lib/key-ceremony.mjs';

const USAGE =
  'usage: gate-manifest <verb> [options]\n' +
  'verbs: record <gate-name> [--ticket id] [--data \'{json}\'] [--files a,b,c]\n' +
  '       verify [--json] [--allow-legacy-unsigned]\n' +
  '       show   [--ticket id] [--json]\n' +
  '       attest [--ticket id]\n' +
  '       repair-chain --reason "..." [--write] [--attest-unsigned] [--json]\n' +
  '       generate-key --output <path> [--allow-key-import] [--json]\n' +
  '       enable [--write] [--json] [--allow-keyless]\n' +
  '       migrate --reason "..." [--write] [--attest-unsigned] [--json]\n' +
  '       adopt  [segment-name] [--write] [--json]';

const { values: flags, positionals } = parseArgs({
  usage: USAGE,
  options: {
    ticket: { type: 'string' },
    data:   { type: 'string' },
    files:  { type: 'string' },
    json:   { type: 'boolean', default: false },
    dir:    { type: 'string', default: ADLC_DIR },
    reason: { type: 'string' },
    write:  { type: 'boolean', default: false },
    'attest-unsigned': { type: 'boolean', default: false },
    'allow-legacy-unsigned': { type: 'boolean', default: false },
    output: { type: 'string' },
    'allow-key-import': { type: 'boolean', default: false },
    'allow-keyless': { type: 'boolean', default: false },
  },
});

const verb = positionals[0];

if (!verb) {
  opError(USAGE);
}

// ── record ──────────────────────────────────────────────────────────────────
if (verb === 'record') {
  const gate = positionals[1];
  if (!gate) {
    opError('usage: gate-manifest record <gate-name> [--ticket id] [--data \'{json}\'] [--files a,b,c]');
  }

  // Validate --data early so we get opError (exit 1) on bad JSON
  try {
    parseData(flags.data);
  } catch (err) {
    opError(err.message);
  }

  let entry;
  try {
    entry = record({
      gate,
      ticket: flags.ticket,
      rawData: flags.data,
      rawFiles: flags.files,
      dir: flags.dir,
      key: getKey(),
    });
  } catch (err) {
    opError(err.message);
  }

  if (flags.json) {
    printJson(entry);
  } else {
    const signed = typeof entry.sig === 'string' ? ' (signed)' : ' (unsigned)';
    console.log(`recorded: seq=${entry.seq} gate=${entry.gate} ts=${entry.ts}${signed}`);
  }

  // T74: a p6-accept verdict is not ticket completion. Print a one-line reminder
  // of the command that IS — to stderr, so it never corrupts --json stdout, and
  // WITHOUT touching what was recorded (no auto-mutation).
  const reminder = ticketCompletionReminder(gate, flags.ticket);
  if (reminder) console.error(reminder);

  pass();
}

// ── verify ───────────────────────────────────────────────────────────────────
if (verb === 'verify') {
  // --allow-legacy-unsigned: this ledger's own history predates HMAC signing
  // (signing was enabled partway through its life), so a strict verify with a
  // key present would fail forever at the first pre-signing entry. Passing this
  // flag tolerates a missing sig ONLY on that contiguous legacy prefix; a missing
  // sig on any entry after signing was adopted, or a present-but-invalid sig
  // anywhere, still fails the chain. See verify()'s requireSignatures doc.
  const result = verify(flags.dir, { requireSignatures: !flags['allow-legacy-unsigned'], key: getKey() });

  if (flags.json) {
    printJson(result);
  } else {
    console.log(result.message);
  }

  if (result.valid) {
    pass();
  } else {
    gateFail(`gate-manifest verify: ${result.message}`);
  }
}

// ── show ─────────────────────────────────────────────────────────────────────
if (verb === 'show') {
  const { entries, skipped } = loadFiltered({ ticket: flags.ticket, dir: flags.dir });

  if (flags.json) {
    printJson({ entries, skipped });
  } else {
    const lines = renderEntries(entries);
    for (const l of lines) console.log(l);
    if (skipped.length > 0) {
      console.warn(`warning: ${skipped.length} malformed line(s) skipped`);
    }
  }

  pass();
}

// ── attest ───────────────────────────────────────────────────────────────────
if (verb === 'attest') {
  const md = buildAttest({ ticket: flags.ticket, dir: flags.dir, key: getKey() });
  console.log(md);
  pass();
}

// ── repair-chain ─────────────────────────────────────────────────────────────
if (verb === 'repair-chain') {
  let result;
  try {
    result = repairChain({
      key: getKey(),
      dir: flags.dir,
      reason: flags.reason,
      write: flags.write,
      attestUnsigned: flags['attest-unsigned'],
    });
  } catch (err) {
    opError(err.message);
  }
  if (flags.json) printJson(result);
  else {
    const attestation = result.newlySignedEntries > 0
      ? `; cryptographically attested ${result.newlySignedEntries} previously unsigned entr${result.newlySignedEntries === 1 ? 'y' : 'ies'}`
      : '';
    console.log(flags.write
      ? `repaired ${result.path}; original preserved at ${result.backup}${attestation}`
      : `repair plan: ${result.originalEntries} entries → ${result.repairedEntries}${attestation}; rerun with --write`);
  }
  pass();
}

// ── generate-key ─────────────────────────────────────────────────────────────
if (verb === 'generate-key') {
  if (!flags.output) {
    opError('usage: gate-manifest generate-key --output <path> [--allow-key-import] [--json]');
  }

  // The import exception NEVER accepts the key as a CLI argument — argv is visible via
  // `ps`, xtrace, shell history, and any command-logging harness, the exact class of
  // exposure this whole ceremony exists to prevent (see scripts/block-secret-exposure
  // .mjs's own incident history). It is sourced ONLY from the already-established,
  // already-audited ADLC_MANIFEST_KEY environment resolution (getKey(), Layer 2) —
  // an operator who wants to import a legacy key exports it first, exactly as every
  // other signing/verifying command in this codebase already expects.
  const importKey = flags['allow-key-import'] ? getKey() : undefined;
  if (flags['allow-key-import'] && !importKey) {
    opError(
      'generate-key: --allow-key-import requires ADLC_MANIFEST_KEY to be set in the environment — '
      + 'the import exception never accepts a key as a CLI argument (visible via ps, xtrace, and shell history).',
    );
  }

  let resolved;
  try {
    resolved = resolveCeremonyKey({ importKey, allowKeyImport: flags['allow-key-import'] });
  } catch (err) {
    opError(err.message);
  }

  try {
    writeKeyHandoffFile(flags.output, resolved.key);
  } catch (err) {
    opError(err.message);
  }

  const fingerprint = computeKeyFingerprint(resolved.key);

  // The key itself NEVER appears below — only its handoff PATH and its FINGERPRINT
  // (a one-way sha256 commitment, not the key). See lib/key-ceremony.mjs's header for
  // why: this repo has already had a key echoed into a session transcript once.
  if (resolved.imported) {
    console.error(
      'generate-key: used the AUDITED IMPORT EXCEPTION — a caller-supplied key was written to the '
      + 'handoff path instead of a freshly generated one. Doctor reporting of this exception is wired '
      + 'in a later slice, alongside the full adoption transaction.',
    );
  }

  if (flags.json) {
    printJson({ path: flags.output, fingerprint, imported: resolved.imported });
  } else {
    console.log(`key written to ${flags.output} (mode 0600) — store it in your secret manager, then delete this file.`);
    console.log(`fingerprint: ${fingerprint}`);
    console.log('This ceremony does not yet run the custody checkpoint or adopt the key — that is wired into a later slice.');
  }

  pass();
}

// ── enable ──────────────────────────────────────────────────────────────────
// Greenfield forest-mode activation (spec 'Storage modes'). Dry-run by
// default; refusals are gate failures (exit 2) that leave the tree untouched.
if (verb === 'enable') {
  // Keyless activation is a ONE-WAY trap for multi-checkout workflows
  // (adversarial-review finding): keyless-minted first entries carry no v2
  // signature, so configuring a key LATER can never authenticate them, and
  // token-less checkouts of the branch fail closed forever. Activation is
  // the moment to surface that — refuse unless the operator opts into
  // single-checkout keyless mode deliberately. Key resolution is a bin
  // concern (key-hermeticity: libraries never read the environment).
  if (getKey(process.env) === null && !flags['allow-keyless']) {
    const keylessReason = 'no ADLC_MANIFEST_KEY is configured. Keyless forest mode is single-checkout only, PERMANENTLY: '
      + 'keyless-minted segments can never be authenticated by a later key, so every other clone of a branch fails closed on '
      + 'its first write. Configure the signing key first, or re-run with --allow-keyless to accept single-checkout mode deliberately.';
    // This refusal stays FIRST and must not gain a failure mode: a full plan
    // here would turn an immediate refusal into an unbounded read of a large
    // root manifest, and a planning error would downgrade this gate failure
    // (exit 2) to an operational one (exit 1). isMarkerActivated is the
    // bounded, no-follow, never-throwing probe for exactly this position —
    // keyless adopters (activated with --allow-keyless) would otherwise hit
    // this refusal on every run and never hear the disclosure at all.
    const state = boundedSegmentationState(flags.dir);
    const keylessWarnings = state === 'segmented' ? [CI_COVERAGE_WARNING]
      : state === 'undetermined' ? [SEGMENTATION_UNDETERMINED_WARNING]
        : [];
    if (flags.json) {
      printJson({ decision: 'refuse-keyless', reason: keylessReason, ...(keylessWarnings.length ? { warnings: keylessWarnings } : {}) });
      process.exit(2);
    }
    for (const warning of keylessWarnings) console.log(`warning [${warning.code}]: ${warning.message}`);
    gateFail(`enable refused: ${keylessReason}`);
  }
  let out;
  try {
    out = enable(flags.dir, { write: flags.write, auth: getKey(process.env) === null ? 'keyless' : 'keyed' });
  } catch (err) {
    opError(err.message);
  }
  const refused = out.decision.startsWith('refuse-');
  if (flags.json) {
    // Exactly ONE JSON document on stdout, in every mode (AC11).
    printJson(out);
    process.exit(refused ? 2 : 0);
  }
  // Human mode must surface what --json already carries, and this must run
  // BEFORE both exits below: gateFail() for a refusal and pass() for success
  // each terminate the process. An already-segmented repo can refuse (ignore
  // drift) while still needing the disclosure, so printing after the refusal
  // check would drop it exactly where it matters.
  for (const warning of out.warnings ?? []) console.log(`warning [${warning.code}]: ${warning.message}`);
  if (refused) gateFail(`enable refused: ${out.reason}`);
  if (out.decision === 'already-enabled') pass(out.reason);
  if (out.written) pass(`forest mode enabled — wrote ${out.markerPath}`);
  pass(`dry-run: would write ${out.markerPath} to enable forest mode — re-run with --write to apply`);
}

// ── migrate ─────────────────────────────────────────────────────────────────
// The history-preserving cutover ceremony (spec §8). Dry-run by default;
// --write applies. Key resolution is a bin concern; the library refuses
// keyless itself, so no precheck is duplicated here.
if (verb === 'migrate') {
  let out;
  try {
    out = migrate(flags.dir, {
      key: getKey(process.env),
      reason: flags.reason ?? '',
      attestUnsigned: flags['attest-unsigned'],
      write: flags.write,
    });
  } catch (err) {
    opError(err.message);
  }
  const refused = out.decision.startsWith('refuse-');
  if (flags.json) {
    printJson(out); // exactly ONE JSON document on stdout, in every mode
    process.exit(refused ? 2 : 0);
  }
  if (refused) gateFail(`migrate refused: ${out.reason}`);
  const sealsLine = `${out.seals.length} standing approve${out.seals.length === 1 ? '' : 's'} sealed`;
  if (out.written) {
    console.log(`cutover applied: ${sealsLine}; backup at ${out.backupPath}; marker at ${out.markerPath}`);
    for (const step of out.followUps) console.log(`  next: ${step}`);
    pass();
  }
  console.log(`dry-run plan: ${sealsLine}; cutover reason "${out.cutover.reason}"; backup would be ${out.backupPath}`);
  for (const seal of out.seals) {
    console.log(`  seal: provider ${seal.provider}, revision ${seal.revision}${seal.ticket ? `, ticket ${seal.ticket}` : ''}`);
  }
  pass('re-run with --write to apply');
}

// ── adopt ───────────────────────────────────────────────────────────────────
// Operator remediation for an ambiguous lineage (spec §7.1(b)). With no
// segment named, LISTS this branch's candidates; with one, adopts it after
// applying the resolver's own authentication gate. Dry-run by default.
if (verb === 'adopt') {
  let out;
  try {
    out = adopt(flags.dir, { cwd: process.cwd(), key: getKey(process.env), segment: positionals[1] ?? null, write: flags.write });
  } catch (err) {
    opError(err.message);
  }
  const refused = out.decision.startsWith('refuse-');
  if (flags.json) {
    printJson(out); // exactly ONE JSON document on stdout, in every mode
    process.exit(refused ? 2 : 0);
  }
  if (refused) gateFail(`adopt refused: ${out.reason}`);
  if (out.decision === 'list') {
    if (out.candidates.length === 0) pass(`no committed segments declare branch ${out.branch} — nothing to adopt`);
    console.log(`candidate lineages for branch ${out.branch}:`);
    for (const c of out.candidates) {
      console.log(`  ${c.name}  entries=${c.entries}  first=${c.firstTs ?? '?'}  last=${c.lastTs ?? '?'}  authenticated=${c.authenticated}`);
    }
    pass('choose one and re-run: gate-manifest adopt <segment> --write');
  }
  if (out.written) pass(`adopted ${out.segment} — this checkout now extends that lineage`);
  pass(`dry-run: would adopt ${out.segment} for branch ${out.branch} — re-run with --write to apply`);
}

// Unknown verb
opError(`unknown verb: ${verb}. Expected: record | verify | show | attest | repair-chain | generate-key | enable | adopt`);
