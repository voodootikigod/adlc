const DIALS = [
  { name: 'Autonomy', value: 0.7, note: 'How long the agent runs unsupervised' },
  { name: 'Oversight', value: 0.5, note: 'How much of the output humans gate' },
  { name: 'Scope', value: 0.35, note: 'How much surface one ticket may touch' },
] as const;

// Scale ticks at 0 / 25 / 50 / 75 / 100%, as needle rotations about the hub.
const TICK_ANGLES = [-90, -45, 0, 45, 90];

function Dial({ name, value, note }: (typeof DIALS)[number]) {
  // Semi-circle gauge: needle angle from -90° (0) to +90° (1)
  const angle = -90 + value * 180;
  const pct = Math.round(value * 100);
  return (
    <figure className="flex flex-col items-center gap-3">
      <svg viewBox="0 0 100 60" className="w-44" role="img" aria-label={`${name} dial set to ${pct}%`}>
        <path
          d="M 10 55 A 40 40 0 0 1 90 55"
          fill="none"
          stroke="#3f4044"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M 10 55 A 40 40 0 0 1 90 55"
          fill="none"
          stroke="#4fb4d8"
          strokeWidth="6"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${pct} 100`}
        />
        {TICK_ANGLES.map((a) => (
          <line
            key={a}
            x1="50" y1="21" x2="50" y2="25"
            stroke="#3f4044"
            strokeWidth="1.5"
            transform={`rotate(${a} 50 55)`}
          />
        ))}
        <line
          x1="50" y1="55" x2="50" y2="27"
          stroke="#cbcdd2" strokeWidth="2.5" strokeLinecap="round"
          transform={`rotate(${angle} 50 55)`}
        />
        <circle cx="50" cy="55" r="4" fill="#26272c" stroke="#cbcdd2" strokeWidth="2" />
      </svg>
      <figcaption className="text-center">
        <span className="block font-semibold" style={{ color: '#cbcdd2' }}>
          {name}{' '}
          <span className="ml-1 font-mono text-sm font-normal" style={{ color: '#4fb4d8' }}>
            {pct}%
          </span>
        </span>
        <span className="mt-1 block max-w-44 text-xs leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          {note}
        </span>
      </figcaption>
    </figure>
  );
}

export function ThreeDials() {
  return (
    <div className="flex flex-wrap justify-center gap-10">
      {DIALS.map((d) => (
        <Dial key={d.name} {...d} />
      ))}
    </div>
  );
}
