interface MidasLogoProps {
  size?: number;
  className?: string;
  /** Gold mark on transparent — no plate. */
  bare?: boolean;
}

/**
 * Brand mark: two mirrored planes forming an abstract M (coin / crown / lift).
 * Solid fills stay crisp from favicon size up; center gap forms the M valley.
 */
export function MidasLogo({ size = 32, className, bare = false }: MidasLogoProps) {
  const mark = (
    <svg
      width={bare ? size : Math.round(size * 0.7)}
      height={bare ? size : Math.round(size * 0.7)}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ flexShrink: 0, display: 'block' }}
    >
      <path d="M5 40 V11 L22 29.5 V40 Z" fill="currentColor" />
      <path d="M43 40 V11 L26 29.5 V40 Z" fill="currentColor" />
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
