'use client';

import { useCallback, useState } from 'react';

interface InstallCommandProps {
  /** The command, rendered verbatim. Never reworded — it is contractual. */
  command: string;
  /** Optional short label above the command, e.g. "macOS / Linux". */
  label?: string;
  /** Marks a command as not yet stable. Rendered next to the label. */
  beta?: boolean;
}

/**
 * A copy-able install command. Client component only because of the clipboard —
 * the command itself is rendered server-side, so it is present in the HTML (and
 * therefore selectable, crawlable, and readable) whether or not JS runs.
 */
export function InstallCommand({ command, label, beta = false }: InstallCommandProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    // No clipboard in insecure contexts or older browsers. Failing silently is
    // fine: the command is right there to select by hand.
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  }, [command]);

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--mk-muted)' }}>
          <span>{label}</span>
          {beta ? (
            <span className="rounded border px-1.5 py-0.5 text-[0.65rem]" style={{ borderColor: '#e5cd52', color: '#e5cd52' }}>
              beta
            </span>
          ) : null}
        </p>
      ) : null}
      <div
        className="flex items-center gap-3 rounded-lg border px-4 py-3"
        style={{ borderColor: '#3f4044', background: '#26272c' }}
      >
        <span aria-hidden className="select-none font-mono text-sm" style={{ color: '#4fb4d8' }}>
          $
        </span>
        <code className="flex-1 overflow-x-auto whitespace-pre font-mono text-sm" style={{ color: '#cbcdd2' }}>
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded border px-2.5 py-1 font-mono text-xs transition-colors"
          style={{ borderColor: '#3f4044', color: copied ? '#78bd65' : 'var(--mk-muted)' }}
          aria-label={copied ? 'Command copied to clipboard' : `Copy: ${command}`}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );
}
