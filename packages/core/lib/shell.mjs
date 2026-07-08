// shell.mjs — shell-command classification for in-session rail gating.
//
// CANONICAL copy of the shell parser first built in
// plugins/adlc-codex/hooks/adlc-rails-guard.mjs (which keeps a verbatim inline
// copy because a Codex hook script cannot resolve npm packages at runtime —
// KEEP IN SYNC). Plugins that CAN import ESM (adlc-opencode, future ports)
// must import from here instead of forking a third copy; pi's weaker inline
// parser (plugins/adlc-pi/index.ts) predates this module.
//
// This is a REGEX classifier, not a shell grammar: it errs toward classifying
// a command as mutating/opaque (fail closed) and only treats a command as
// read-only when it positively matches a known-safe prefix. Callers implement
// the enforcement ladder; see classifyShellCommand for the one-call summary.

/**
 * Collect target paths from an OpenAI-style apply_patch envelope body
 * ("*** Add File: x", "*** Update File: y", …). Lets a rail gate treat
 * apply_patch as PATH-TRANSPARENT instead of blanket-denying it — critical on
 * hosts where apply_patch is the ONLY file mutator for GPT-5-class models
 * (OpenCode registry gating). Same verbatim-copy contract as the shell
 * classifiers: the codex hook keeps an inline copy.
 */
export function collectPatchPaths(text, out) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    for (const prefix of ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: ']) {
      if (line.startsWith(prefix)) {
        const path = line.slice(prefix.length).trim();
        if (path) out.add(path);
      }
    }
  }
}

/** Escape-aware tokenization (double-quoted, single-quoted, bare tokens). */
export function shellTokens(text) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s;&|<>]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export function looksPathLike(value) {
  return (
    !value.startsWith('-') &&
    !value.includes('=') &&
    /^[A-Za-z0-9_./@+-]+$/.test(value) &&
    (/[/\\]/.test(value) || /\.[A-Za-z0-9]+$/.test(value))
  );
}

export function looksBarePathLike(value) {
  return !value.startsWith('-') && !value.includes('=') && /^[A-Za-z0-9_./@+-]+$/.test(value);
}

export function keyValuePath(value) {
  const match = value.match(/^(?:--?[A-Za-z0-9_-]+|[A-Za-z_][A-Za-z0-9_-]*)=(.+)$/);
  if (!match) return null;
  const path = match[1].replace(/^["']|["']$/g, '');
  return looksPathLike(path) ? path : null;
}

/** Does the command contain a recognized file-mutation form? */
export function shellHasMutation(text) {
  return (
    /(^|[\s;&|])(?:>>?|[0-9]>>?|[0-9]>)\s*\S+/.test(text) ||
    /\b(?:tee|touch|rm|mv|cp|install|dd|truncate|rsync|chmod|chown|ln|mkdir|mktemp|shred)\b/.test(text) ||
    /\bcurl\b[^;&|]*(?:\s-[oO]\b|\s--output\b|\s--remote-name\b)/.test(text) ||
    /\bwget\b[^;&|]*(?:\s-O\b|\s--output-document\b)/.test(text) ||
    /\bgit\s+(?:apply|am|checkout|restore|reset|clean|merge|rebase|cherry-pick|stash|commit)\b/.test(text) ||
    /\b(?:patch|tar|unzip)\b/.test(text) ||
    /\bfind\b[^;&|]*(?:-delete|-exec(?:dir)?\b|-ok(?:dir)?\b)/.test(text) ||
    /\b(?:sed|perl)\s+[^;&|]*-(?:i|p?i)\b/.test(text) ||
    /\bsed\b[^;&|]*(?:"[^"\n]*\bw\s+\S+[^"\n]*"|'[^'\n]*\bw\s+\S+[^'\n]*')/.test(text) ||
    /\bawk\b[^;&|]*(?:\s-i(?:\s|=)|\s--in-place\b)/.test(text) ||
    /\b(?:node|python3?|ruby)\b[^;&|]*(?:writeFile|appendFile|rmSync|renameSync|copyFile|truncateSync|mkdirSync|write_text|write_bytes)/.test(text) ||
    /\bopen\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]/.test(text) ||
    /\bFile\.(?:write|open)\b/.test(text)
  );
}

/** Mutating via a command whose write targets can't be read off the command line. */
export function shellHasOpaqueMutation(text) {
  return (
    /\bgit\s+(?:apply|am|checkout|restore|reset|clean|merge|rebase|cherry-pick|stash|commit)\b/.test(text) ||
    /\b(?:patch|tar|unzip)\b/.test(text)
  );
}

/**
 * Positively read-only only if EVERY command segment is individually a known
 * read-only command (empty string counts). Splitting on separators is
 * load-bearing: a read-only prefix must not shadow a later mutator — e.g.
 * `git status && curl -o rail` is NOT read-only.
 */
export function shellIsPositivelyReadOnly(text) {
  const normalized = String(text ?? '').trim();
  if (normalized === '') return true;
  const readOnlyPrefix = /^(?:git\s+(?:status|diff|show|log|rev-parse|branch|ls-files)\b|pwd\b|ls\b|rg\b|grep\b|cat\b|sed\s+-n\b|head\b|tail\b|wc\b|nl\b|node\s+(?:--check|--test)\b|npm\s+(?:test|run\s+test)\b|adlc\s+(?:hollow-test|rails-guard|flail-detector|preflight|run\s+p[34])\b)/;
  return normalized
    .split(/(?:&&|\|\||[;&|\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .every((segment) => readOnlyPrefix.test(segment));
}

/** A nominally read-only command smuggling a write via an output option. */
export function shellHasWriteOption(text) {
  return /\s--(?:output|output-file|test-reporter-destination|reporter-destination)(?:=|\s+)\S+/.test(text);
}

export function shellChangesCwd(text) {
  return /(^|[\s;&|()])(?:cd|pushd|popd)\b/.test(text);
}

export function shellHasExpansion(text) {
  return /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(|`|[*?]|\[[^\]\n]+\])/.test(text);
}

/** Collect literal path candidates (redirect targets, quoted paths, sed w-files, tokens). */
export function collectShellPaths(text, out) {
  const redirectPattern = /(?:^|[\s])(?:>>?|[0-9]>>?|[0-9]>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let redirect;
  while ((redirect = redirectPattern.exec(text)) !== null) {
    out.add(redirect[1] ?? redirect[2] ?? redirect[3]);
  }

  const quotedPathPattern = /["'`]([^"'`\n]*[/\\][^"'`\n]*)["'`]/g;
  let quoted;
  while ((quoted = quotedPathPattern.exec(text)) !== null) {
    const value = quoted[1];
    if (looksPathLike(value)) out.add(value);
  }

  const sedWritePattern = /\bsed\b[^;&|]*(?:"[^"\n]*\bw\s+([A-Za-z0-9_./@+-]+)[^"\n]*"|'[^'\n]*\bw\s+([A-Za-z0-9_./@+-]+)[^'\n]*')/g;
  let sedWrite;
  while ((sedWrite = sedWritePattern.exec(text)) !== null) {
    const value = sedWrite[1] ?? sedWrite[2];
    if (value && looksPathLike(value)) out.add(value);
  }

  for (const token of shellTokens(text)) {
    const path = keyValuePath(token);
    if (path) out.add(path);
    else if (looksPathLike(token)) out.add(token);
    else if (looksBarePathLike(token)) out.add(token);
  }
}

/**
 * One-call classification a caller's enforcement ladder consumes.
 * Mirrors the codex driver ladder (adlc-rails-guard.mjs:365-403):
 *   readOnly && writeOption            → deny (output-option smuggle)
 *   readOnly                           → allow
 *   !mutating                          → deny (neither read-only nor transparent mutation)
 *   opaque                             → deny (targets unreadable)
 *   changesCwd || expands              → deny (path resolution unverifiable)
 *   paths.length === 0                 → deny (mutation with no literal targets)
 *   else                               → check paths against rails
 */
export function classifyShellCommand(text) {
  const command = String(text ?? '');
  const readOnly = shellIsPositivelyReadOnly(command);
  const mutating = shellHasMutation(command);
  const paths = new Set();
  if (mutating) collectShellPaths(command, paths);
  return {
    readOnly: readOnly && !mutating,
    mutating,
    opaque: shellHasOpaqueMutation(command),
    changesCwd: shellChangesCwd(command),
    expands: shellHasExpansion(command),
    writeOption: shellHasWriteOption(command),
    paths: [...paths],
  };
}
