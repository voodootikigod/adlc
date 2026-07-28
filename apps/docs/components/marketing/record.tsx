import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The record vocabulary.
 *
 * Every marketing surface is a controlled-change record: a header block of
 * fixed fields, numbered clauses, a column naming what acts, and attached exhibits.
 * These are the atoms. Nothing here is a generic card, panel, or pill — a stock
 * component inside a committed form is the lapse this file exists to prevent.
 *
 * Two surfaces, deliberately: the record is paper, the evidence is terminal.
 * A person reads the record; a machine produced the evidence.
 */

/* -------------------------------------------------------------------------- */
/* Chrome                                                                      */
/* -------------------------------------------------------------------------- */

const NAV = [
  { href: '/lifecycle', label: 'Lifecycle' },
  { href: '/failure-modes', label: 'Failure modes' },
  { href: '/vs-sdlc', label: 'vs SDLC' },
  { href: '/toolkit', label: 'Toolkit' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/enterprise', label: 'Enterprise' },
  { href: '/docs', label: 'Docs' },
];

/**
 * The GitHub mark, inlined.
 *
 * lucide-react is the project's icon package and ships 5,975 icons, none of them
 * brand marks — Lucide removed those for trademark reasons — and fumadocs-ui does
 * not export one either. Adding a package for a single glyph costs a dependency
 * and a bundle entry, so the official mark is inlined instead. It inherits
 * currentColor, so it takes the nav's own hover states.
 */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * The masthead stays on the terminal ground. It is the hard top edge that keeps
 * the record attached to the world that produced it, and it is the one place the
 * pass-green appears as identity rather than as a verdict.
 */
export function Masthead() {
  return (
    <header style={{ background: '#1c1d21', color: '#cbcdd2' }}>
      <div className="mx-auto flex h-[52px] max-w-[1180px] items-center justify-between px-6 md:px-8">
        {/* The name is spelled out. "ADLC" alone assumes the visitor already
            knows what it stands for, which is exactly what a first-time
            enterprise reader does not. The initialism follows in parentheses so
            the short form still teaches itself. */}
        <Link
          href="/"
          className="rec-mono flex items-center gap-2.5 text-[12.5px] font-bold tracking-[0.05em]"
          style={{ color: '#cbcdd2' }}
        >
          <span aria-hidden className="block h-[9px] w-[9px] shrink-0 rounded-[1px]" style={{ background: '#78bd65' }} />
          <span className="hidden sm:inline">Agentic Development Lifecycle (ADLC)</span>
          <span className="sm:hidden">ADLC</span>
        </Link>
        <nav className="hidden items-center gap-6 text-[12.5px] font-medium md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} style={{ color: '#9599a6' }} className="hover:text-[#cbcdd2]">
              {n.label}
            </Link>
          ))}
          <a
            href="https://github.com/voodootikigod/adlc"
            className="flex items-center transition-colors hover:text-[#cbcdd2]"
            style={{ color: '#9599a6' }}
            aria-label="ADLC on GitHub"
          >
            <GitHubMark />
          </a>
        </nav>
        {/* Small screens get every route, not a two-link sample: a no-JS
            disclosure on the terminal ground. A mobile visitor who lands on an
            interior page must still be able to reach the install path. */}
        <details className="relative md:hidden">
          <summary
            className="rec-mono flex cursor-pointer list-none items-center border px-2.5 py-1 text-[11px] tracking-[0.1em] [&::-webkit-details-marker]:hidden"
            style={{ color: '#9599a6', borderColor: '#34363d' }}
          >
            MENU
          </summary>
          <nav
            className="absolute right-0 top-[calc(100%+9px)] z-50 flex w-52 flex-col"
            style={{ background: '#1c1d21', border: '1px solid #34363d' }}
            aria-label="All pages"
          >
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="px-4 py-2.5 text-[13px] font-medium"
                style={{ color: '#cbcdd2', borderBottom: '1px solid #2c2e34' }}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </details>
      </div>
    </header>
  );
}

/** The strip under the masthead: what record this is, and its standing. */
export function RecordRail({ items }: { items: { k: string; v: ReactNode; open?: boolean }[] }) {
  return (
    <div style={{ background: 'var(--rec-paper-sunk)', borderBottom: '1px solid var(--rec-rule-strong)' }}>
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-y-1 px-6 py-2 md:h-[34px] md:flex-nowrap md:gap-y-0 md:py-0 md:px-8">
        {items.map((it, i) => (
          <span
            key={it.k}
            className="rec-mono whitespace-nowrap text-[11px] uppercase tracking-[0.1em]"
            style={{
              color: 'var(--rec-ink-2)',
              paddingRight: 18,
              marginRight: 18,
              borderRight: i === items.length - 1 ? 'none' : '1px solid var(--rec-rule-strong)',
            }}
          >
            {it.open ? (
              <span
                aria-hidden
                className="mr-2 inline-block h-[6px] w-[6px] rounded-full align-[1px]"
                style={{ background: '#e5cd52' }}
              />
            ) : null}
            {it.k}{' '}
            <b className="font-semibold" style={{ color: 'var(--rec-ink)' }}>
              {it.v}
            </b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function RecordFoot({ children }: { children: ReactNode }) {
  return (
    <div style={{ borderTop: '1px solid var(--rec-rule)' }}>
      <div
        className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-4 px-6 py-8 text-[12px] md:px-8"
        style={{ color: 'var(--rec-ink-3)' }}
      >
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The record body                                                             */
/* -------------------------------------------------------------------------- */

/** The ruled column the whole record sits in. */
export function RecordBody({ children }: { children: ReactNode }) {
  return (
    <div
      className="mx-auto max-w-[1180px]"
      style={{ borderLeft: '1px solid var(--rec-rule)', borderRight: '1px solid var(--rec-rule)' }}
    >
      {children}
    </div>
  );
}

/** The header block: fixed fields, hairline-divided, never a card grid. */
export function FieldBlock({ fields }: { fields: { label: string; value: ReactNode; mono?: boolean }[] }) {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
      style={{ borderBottom: '1px solid var(--rec-rule)' }}
    >
      {fields.map((f, i) => (
        <div
          key={f.label}
          className="px-6 py-4 md:px-6"
          style={{
            borderRight: '1px solid var(--rec-rule)',
            borderBottom: i < fields.length - 1 ? '1px solid var(--rec-rule)' : undefined,
          }}
        >
          <div className="rec-legend">{f.label}</div>
          <div
            className={`mt-1.5 text-[14px] font-medium leading-[1.35] ${f.mono ? 'rec-mono text-[13px]' : ''}`}
            style={{ color: 'var(--rec-ink)' }}
          >
            {f.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A numbered clause. The numbering is the form's own grammar, not decoration:
 * exhibits reference the clause they are attached to, so the reader needs it.
 */
export function Clause({
  n,
  label,
  title,
  lede,
  aside,
  children,
  last = false,
}: {
  n: string;
  label: string;
  title?: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <section style={{ borderBottom: last ? undefined : '1px solid var(--rec-rule)' }}>
      <div className="flex flex-col gap-x-6 px-6 pb-8 pt-10 md:flex-row md:px-8 md:pb-10 md:pt-12">
        <div className="mb-3 shrink-0 md:mb-0 md:w-[104px] md:pt-1">
          <div className="rec-legend whitespace-nowrap">
            §{n} {label}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {title}
          {lede ? (
            <p
              className="mt-4 max-w-[72ch] text-[16.5px] leading-[1.55]"
              style={{ color: 'var(--rec-ink-2)' }}
            >
              {lede}
            </p>
          ) : null}
          {children}
        </div>
        {aside ? (
          <div
            className="mt-6 shrink-0 md:mt-0 md:w-[260px] md:border-l md:pl-6"
            style={{ borderColor: 'var(--rec-rule)' }}
          >
            {aside}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The statement: the one place the width axis runs at panel scale. */
export function Statement({ children }: { children: ReactNode }) {
  return (
    <h1
      className="rec-statement max-w-[26ch] text-balance text-[clamp(30px,4.3vw,54px)] font-bold"
      style={{ color: 'var(--rec-ink)' }}
    >
      {children}
    </h1>
  );
}

export function ClauseTitle({ children }: { children: ReactNode }) {
  return (
    <h2
      className="text-[clamp(19px,2.1vw,26px)] font-bold tracking-[-0.018em]"
      style={{ color: 'var(--rec-ink)' }}
    >
      {children}
    </h2>
  );
}

export function RecordLink({ href, children }: { href: string; children: ReactNode }) {
  const props = {
    className: 'text-[13px]',
    style: { color: 'var(--rec-link)', borderBottom: '1px solid var(--rec-link-edge)' },
  };
  return href.startsWith('http') ? (
    <a href={href} {...props}>
      {children}
    </a>
  ) : (
    <Link href={href} {...props}>
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                    */
/* -------------------------------------------------------------------------- */

export type Verdict = 'pass' | 'fail' | 'attest';

/**
 * A verdict is never carried by colour alone: every chip pairs a glyph with a
 * word, and the machine verdicts carry their exit code too, because the exit
 * code is the actual contract.
 */
export function ExitCode({ verdict, stampDelay }: { verdict: Verdict; stampDelay?: number }) {
  const spec = {
    pass: { glyph: '✓', word: 'PASS', code: '0', ink: 'var(--rec-pass-ink)', edge: 'var(--rec-pass-edge)', field: 'var(--rec-pass-field)' },
    fail: { glyph: '✗', word: 'FAIL', code: '2', ink: 'var(--rec-fail-ink)', edge: 'var(--rec-fail-edge)', field: 'var(--rec-fail-field)' },
    attest: { glyph: '◆', word: 'ATTEST', code: '', ink: 'var(--rec-gate-ink)', edge: 'var(--rec-gate-edge)', field: 'var(--rec-gate-field)' },
  }[verdict];

  return (
    <span
      className={`rec-mono inline-flex items-center gap-1.5 whitespace-nowrap border px-1.5 py-[2px] text-[10.5px] font-semibold${
        stampDelay === undefined ? '' : ' rec-code-stamp'
      }`}
      style={{
        color: spec.ink,
        borderColor: spec.edge,
        background: spec.field,
        animationDelay: stampDelay === undefined ? undefined : `${stampDelay}ms`,
      }}
    >
      <span aria-hidden>{spec.glyph}</span>
      {spec.word}
      {spec.code ? <b className="font-semibold">{spec.code}</b> : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Exhibits — the evidence surface                                             */
/* -------------------------------------------------------------------------- */

/**
 * An exhibit is a verbatim capture, attached to a clause by number. This is the
 * page's whole claim structure: a sentence with no exhibit behind it has no
 * standing here.
 */
export function Exhibit({
  id,
  attachedTo,
  command,
  status,
  verdict,
  children,
}: {
  id: string;
  attachedTo: string;
  command: string;
  status: string;
  verdict: Verdict;
  children: ReactNode;
}) {
  return (
    <figure className="mt-5">
      <figcaption className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <b className="rec-mono text-[11px] font-semibold tracking-[0.1em]" style={{ color: 'var(--rec-ink)' }}>
          EXHIBIT {id}
        </b>
        <span className="text-[12.5px]" style={{ color: 'var(--rec-ink-3)' }}>
          {attachedTo}
        </span>
      </figcaption>
      <div className="rec-capture" style={{ background: '#1c1d21', border: '1px solid #34363d' }}>
        <div
          className="rec-capture-bar rec-mono flex items-center justify-between gap-3 px-3.5 py-2 text-[11px] tracking-[0.1em]"
          style={{ borderBottom: '1px solid #2c2e34', color: '#9093a0' }}
        >
          <span className="truncate text-[12px] tracking-normal">{command}</span>
          <span className="whitespace-nowrap" style={{ color: verdict === 'fail' ? '#eb3d54' : '#78bd65' }}>
            {status}
          </span>
        </div>
        <div className="rec-mono overflow-x-auto px-4 py-3.5 text-[12.5px] leading-[1.75]" style={{ color: '#cbcdd2' }}>
          {children}
        </div>
      </div>
    </figure>
  );
}

/** Real gate output. Verdict lines keep glyph + word; colour only reinforces. */
export function ExhibitOutput({ output }: { output: string }) {
  return (
    <pre className="whitespace-pre-wrap">
      {output.split('\n').map((line, i) => {
        const color = line.startsWith('✓') ? '#78bd65' : line.startsWith('✗') ? '#eb3d54' : '#cbcdd2';
        const isPrompt = line.startsWith('$');
        return (
          <span key={i} style={{ color: isPrompt ? '#cbcdd2' : color }}>
            {i > 0 ? '\n' : ''}
            {isPrompt ? (
              <>
                <span style={{ color: '#686b78' }}>$</span>
                {line.slice(1)}
              </>
            ) : (
              line
            )}
          </span>
        );
      })}
    </pre>
  );
}

/** A small terminal block used where a full exhibit caption would be noise. */
export function Capture({ title, status, fail, children }: { title: string; status: string; fail?: boolean; children: ReactNode }) {
  return (
    <div className="rec-capture" style={{ background: '#1c1d21', border: '1px solid #34363d' }}>
      <div
        className="rec-capture-bar rec-mono flex items-center justify-between gap-3 px-3.5 py-2 text-[11px] tracking-[0.1em]"
        style={{ borderBottom: '1px solid #2c2e34', color: '#9093a0' }}
      >
        <span className="truncate text-[12px] tracking-normal">{title}</span>
        <span className="whitespace-nowrap" style={{ color: fail ? '#eb3d54' : '#78bd65' }}>
          {status}
        </span>
      </div>
      <div className="rec-mono overflow-x-auto px-4 py-3.5 text-[12.5px] leading-[1.75]" style={{ color: '#cbcdd2' }}>
        {children}
      </div>
    </div>
  );
}
