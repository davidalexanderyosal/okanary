/** Okanary the canary: flat sunshine yellow, peach beak and cheeks, standing on a gold coin. */
export function Mascot({ className = "h-[72px] w-[72px]", coin = true }: { className?: string; coin?: boolean }) {
  return (
    <div className={`relative shrink-0 ${className}`} aria-hidden="true">
      {coin && (
        <span
          className="absolute -bottom-1 left-2 right-1 h-[15px] rounded-[50%]"
          style={{ background: "radial-gradient(ellipse at 50% 30%, var(--coin-top), var(--coin-bottom))", boxShadow: "0 2px 0 var(--coin-edge)" }}
        />
      )}
      <svg viewBox="0 0 100 100" className="bob relative h-[calc(100%-6px)] w-full overflow-visible">
        <path d="M26 56 L4 74 L10 50 Z" fill="#FFB43A" />
        <ellipse cx="50" cy="58" rx="30" ry="26" fill="#FFD54A" />
        <circle cx="62" cy="34" r="18" fill="#FFD54A" />
        <path d="M30 56 Q44 43 60 57 Q47 77 30 56Z" fill="#FFB43A" />
        <path d="M77 28 L94 36 L77 43 Z" fill="#FF9A62" />
        <circle cx="68" cy="30" r="3.2" fill="#2B3350" />
        <ellipse cx="71" cy="41" rx="5.5" ry="3.6" fill="#FFA58A" opacity=".6" />
        <path d="M43 83V93M58 83V93M38 93H47M53 93H62" stroke="#E8933A" strokeWidth="3" strokeLinecap="round" fill="none" />
      </svg>
    </div>
  );
}

/** Tiny canary that rides the end of the Lifestyle progress line. */
export function MiniCanary({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <path d="M26 56 L4 74 L10 50 Z" fill="#FFB43A" />
      <ellipse cx="50" cy="58" rx="30" ry="26" fill="#FFD54A" />
      <circle cx="62" cy="34" r="18" fill="#FFD54A" />
      <path d="M77 28 L94 36 L77 43 Z" fill="#FF9A62" />
      <circle cx="68" cy="30" r="3.4" fill="#2B3350" />
      <ellipse cx="71" cy="41" rx="5.5" ry="3.6" fill="#FFA58A" opacity=".7" />
    </svg>
  );
}
