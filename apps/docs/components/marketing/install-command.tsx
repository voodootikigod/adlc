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
 * The record's primary control.
 *
 * In this world the install command is not a call-to-action button beside the
 * copy — it is the value of the IMPLEMENTATION field, so it is rendered as the
 * form's own executable field: squared, ruled, on the terminal ground, with the
 * command itself as the field's content.
 *
 * Client component only because of the clipboard. The command is rendered
 * server-side, so it is in the HTML — selectable, crawlable, and readable —
 * whether or not JS runs.
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
    <div className="flex flex-col gap-2">
      {label ? (
        <p className="rec-legend flex items-center gap-2">
          <span>{label}</span>
          {beta ? (
            <span
              className="rec-mono border px-1.5 py-[1px] text-[9px]"
              style={{ borderColor: 'var(--rec-gate-edge)', color: 'var(--rec-gate-ink)', background: 'var(--rec-gate-field)' }}
            >
              BETA
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="flex items-stretch" style={{ border: '1px solid var(--rec-ink)', background: '#1c1d21' }}>
        {/* The command wraps at every width rather than scrolling out of sight.
            This is the page's primary action: a visitor who cannot see the
            whole command cannot verify what they are about to pipe to sh — and
            an earlier md:whitespace-pre variant clipped the agent prompt
            mid-sentence at exactly the width where most visitors copy it. */}
        <code
          className="rec-mono flex-1 whitespace-pre-wrap break-all px-4 py-3 text-[13px] md:break-words md:text-[13.5px]"
          style={{ color: '#cbcdd2' }}
        >
          <span aria-hidden className="select-none pr-2.5" style={{ color: '#78bd65' }}>
            $
          </span>
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rec-mono shrink-0 px-4 text-[11px] tracking-[0.14em] transition-colors"
          style={{
            borderLeft: '1px solid #34363d',
            background: '#26272c',
            color: copied ? '#78bd65' : '#cbcdd2',
          }}
          aria-label={copied ? 'Command copied to clipboard' : `Copy: ${command}`}
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
    </div>
  );
}
