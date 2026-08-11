interface MidasLogoProps {
  size?: number;
  className?: string;
  /** Gold mark on transparent — no plate. */
  bare?: boolean;
}

/**
 * Brand mark: a segmented pie/donut around a coin bearing a dollar sign —
 * spend split into categories, which is what Midas is for.
 * Solid segments (rather than outlines) keep it legible down to favicon size;
 * everything rides on currentColor so it works on the plate or on any surface.
 */
export function MidasLogo({ size = 32, className, bare = false }: MidasLogoProps) {
  const mark = (
    <svg
      width={bare ? size : Math.round(size * 0.72)}
      height={bare ? size : Math.round(size * 0.72)}
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, display: 'block' }}
    >
      <g fill="currentColor">
        <path d="M 237.48 491.27 A 236 236 0 0 1 237.48 20.73 L 245.17 118.43 A 138 138 0 0 0 245.17 393.57 Z" />
        <path d="M 274.52 20.73 A 236 236 0 0 1 450.49 122.33 L 369.73 177.84 A 138 138 0 0 0 266.83 118.43 Z" />
        <path d="M 469.01 154.40 A 236 236 0 0 1 469.01 357.60 L 380.56 315.41 A 138 138 0 0 0 380.56 196.59 Z" />
        <path d="M 450.49 389.67 A 236 236 0 0 1 274.52 491.27 L 266.83 393.57 A 138 138 0 0 0 369.73 334.16 Z" />
      </g>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="256" cy="256" r="91" strokeWidth="26" />
        <path d="M 256 192 V 320" strokeWidth="24" />
        <path d="M 286 222 H 246 a 23 23 0 0 0 0 46 h 20 a 23 23 0 0 1 0 46 H 226" strokeWidth="24" />
      </g>
    </svg>
  );

  if (bare) {
    return (
      <span
        className={`inline-flex items-center justify-center text-brand-500 ${className ?? ''}`}
        style={{ width: size, height: size }}
        aria-label="Midas"
        role="img"
      >
        {mark}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center justify-center rounded-[20%] bg-brand-500 text-cream ${className ?? ''}`}
      style={{ width: size, height: size }}
      aria-label="Midas"
      role="img"
    >
      {mark}
    </span>
  );
}

/** Product wordmark — Fraunces, calm tracking. */
export function MidasWordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`font-display font-semibold tracking-[-0.03em] text-ink ${className || 'text-[1.35rem] leading-none'}`}
    >
      Midas
    </span>
  );
}
