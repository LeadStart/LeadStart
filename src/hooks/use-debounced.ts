import { useEffect, useState } from "react";

/**
 * Returns a debounced copy of `value` that only updates after `ms` of quiet.
 * Mirrors the 300ms debounce convention used in the prospecting typeahead.
 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);

  return debounced;
}
