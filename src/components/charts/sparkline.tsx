"use client";

/**
 * Tiny inline-SVG sparkline for dense table cells (e.g. the Overview
 * portfolio "Trend" column). Flat contract: a single 1.6px polyline, no
 * fill, no gradient. Stroke is emerald when the series ends at or above
 * where it started, red when it ends lower: a quick up/down read.
 */
export function Sparkline({
  values,
  width = 64,
  height = 22,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (!values || values.length < 2) {
    return (
      <span className="text-xs text-muted-foreground" aria-hidden>
       ,
      </span>
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pad = 2;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - pad - ((v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // All-zero series (a dormant account) reads as neutral, not "down".
  const allZero = max === 0;
  const rising = values[values.length - 1] >= values[0];
  const stroke = allZero ? "#cbd5e1" : rising ? "#059669" : "#dc2626";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label="Send-volume trend, last 30 days"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
