// fetchAllRows: read EVERY row a PostgREST select would return, in pages,
// bypassing the server's default ~1000-row response cap.
//
// supabase-js / PostgREST cap an un-ranged select at ~1000 rows (the response
// carries `Content-Range: 0-999/<total>`). Any "select all rows for this
// campaign / org" that can exceed 1000 rows silently truncates, which then
// corrupts anything computed from the row set (counts, per-step buckets,
// enrollment maps). This centralizes the `.range(from, from + 999)` paging loop
// already inlined in the cron routes (sync-analytics, run-native-sequences).
//
// `build` MUST return a FRESH query builder each call (filters + order applied,
// but NOT .range / .limit). Errors are logged and stop paging, returning the
// rows gathered so far, matching the pages' degrade-gracefully posture (they use
// `data ?? []` and never surface a fetch error to the user).

type RangedResult<T> = { data: T[] | null; error: { message?: string } | null };
type Rangeable<T> = {
  range: (from: number, to: number) => PromiseLike<RangedResult<T>>;
};

export async function fetchAllRows<T>(
  build: () => Rangeable<T>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) {
      console.error("[fetchAllRows] page fetch failed:", error.message ?? error);
      break;
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
