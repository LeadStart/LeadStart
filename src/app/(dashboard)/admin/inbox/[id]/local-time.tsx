"use client";

import { useEffect, useState } from "react";

function format(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * Absolute timestamp rendered in the viewer's own timezone.
 *
 * Server render and the first client paint both use UTC (so hydration matches);
 * after mount we swap to the browser's local timezone so the owner reads a real
 * local time like "Jul 30, 2026, 10:00 AM EDT" instead of "23d ago".
 */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const [text, setText] = useState(() => format(iso, "UTC"));
  useEffect(() => {
    setText(format(iso));
  }, [iso]);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
