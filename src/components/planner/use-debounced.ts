"use client";

import { useEffect, useState } from "react";

/** `value`, but only after it has held still for `ms` (keeps typing smooth while the engine runs). */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
