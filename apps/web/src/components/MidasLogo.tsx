interface MidasLogoProps {
  size?: number;
  className?: string;
}

export function MidasLogo({ size = 32, className }: MidasLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Midas"
      role="img"
      className={className}
      style={{ flexShrink: 0 }}
    >
      <rect width="100" height="100" rx="18" fill="#9a6f3b" />
      <path
        d="M18 80 L18 20 L50 48 L82 20 L82 80 L70 80 L70 30 L50 60 L30 30 L30 80 Z"
        fill="white"
      />
    </svg>
  );
}
