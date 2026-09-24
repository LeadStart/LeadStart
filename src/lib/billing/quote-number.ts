import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Allocate the next quote number for an organization (Q-YYYY-NNNN).
 * In real Supabase this should use `quote_number_counters` via an RPC for
 * atomicity under concurrency; for now we scan existing rows, which is fine
 * for our volume and single-threaded test-mode flows. Shared by the create and
 * reissue routes so the two never drift.
 */
export async function nextQuoteNumber(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `Q-${year}-`;
  const { data } = await supabase
    .from("quotes")
    .select("quote_number")
    .eq("organization_id", organizationId);
  const rows = (data as Array<{ quote_number: string }> | null) ?? [];
  const nums = rows
    .map((r) => r.quote_number)
    .filter((n) => n && n.startsWith(prefix))
    .map((n) => parseInt(n.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}
