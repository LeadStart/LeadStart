type BounceLoaderProps = {
  caption?: string;
  sub?: string;
  className?: string;
};

export function BounceLoader({
  caption = "Loading",
  sub,
  className,
}: BounceLoaderProps) {
  return (
    <div
      className={
        "flex min-h-[300px] w-full flex-col items-center justify-center" +
        (className ? ` ${className}` : "")
      }
    >
      <svg
        width="220"
        height="130"
        viewBox="0 0 220 130"
        aria-hidden="true"
        role="presentation"
      >
        {[40, 110, 180].map((x, i) => (
          <g key={i}>
            <ellipse
              className="ls7-shadow"
              cx={x}
              cy={105}
              rx={18}
              ry={3}
              fill="#0f1030"
              style={{ animationDelay: `${i * 0.16}s` }}
            />
            <g
              className="ls7-envelope"
              style={{
                transformOrigin: `${x}px 80px`,
                animationDelay: `${i * 0.16}s`,
              }}
            >
              <g transform={`translate(${x} 80)`}>
                <rect
                  x={-20}
                  y={-14}
                  width={40}
                  height={28}
                  rx={3}
                  fill="#ffffff"
                  stroke="#2e37fe"
                  strokeWidth={2}
                />
                <path
                  d="M -20 -14 L 0 2 L 20 -14"
                  fill="none"
                  stroke="#2e37fe"
                  strokeWidth={2}
                />
                <path
                  d="M -20 14 L -5 0 M 20 14 L 5 0"
                  stroke="#2e37fe"
                  strokeWidth={1.5}
                  opacity={0.4}
                  fill="none"
                />
              </g>
            </g>
          </g>
        ))}
      </svg>
      <div className="mt-4 text-[13px] font-semibold tracking-tight text-[#0f1030]">
        {caption}
      </div>
      {sub ? (
        <div className="mt-1 text-[11px] tracking-wider text-[#8a8db0]">
          {sub}
        </div>
      ) : null}
    </div>
  );
}
