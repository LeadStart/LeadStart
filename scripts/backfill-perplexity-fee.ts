#!/usr/bin/env node
/**
 * One-off: add Perplexity's per-request fee (0.5¢ a call) to the enrichment
 * runs recorded without it. Until 2026-10-12 callPerplexity costed a call by
 * its tokens only, so every run's cost_usd left the fee out of:
 *   - owner-name lookups (naming Layer 2 ran on Perplexity until 2026-10-11): one
 *     call per item whose naming notes end "Perplexity sonar completed";
 *   - website lookups (domain discovery): one call per answered lookup, rows of
 *     one firm in one claimed batch sharing a call. Counted by
 *     src/lib/enrichment/perplexity-calls.ts, the same rules the TuBe report uses.
 * Not counted: a call that errored or timed out (no sign Perplexity answered),
 * and a first attempt that failed and was retried (the notes keep only the
 * last attempt), so the deltas are a floor.
 *
 * DRY RUN by default: prints each run's calls and the fee it would add, writes
 * nothing.
 *   npx tsx scripts/backfill-perplexity-fee.ts
 *   npx tsx scripts/backfill-perplexity-fee.ts --apply     (owner-approved only)
 *
 * --apply needs migration 00138 (cost_breakdown) and, per run whose
 * cost_breakdown has no Perplexity share: cost_usd += the fee, and
 * cost_breakdown.perplexity = the fee (the run's earlier cost stays "not split";
 * the share also marks the fee as recorded, so the TuBe report stops adding it).
 * A run with a Perplexity share already holds the fee and is left alone, so a
 * second --apply changes nothing. Run it from the main checkout (it reads
 * .env.local there); prints no names or addresses.
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  PERPLEXITY_FEE_USD,
  countLookupCalls,
  countNamingCalls,
  lookupCallsInNote,
  perplexityFeeRecorded,
  type LookupItemRow,
} from "../src/lib/enrichment/perplexity-calls.ts";
import { discoveryLocation } from "../src/lib/enrichment/domain-discovery.ts";
import { addCosts, unsplitCost } from "../src/lib/enrichment/run-cost.ts";

const APPLY = process.argv.includes("--apply");

// .env.local from the working directory, else from the main checkout (a
// worktree has none). Values stay in this process.
function envFile(): string {
  if (existsSync(".env.local")) return ".env.local";
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  return join(dirname(common), ".env.local");
}
const env: Record<string, string> = {};
for (const line of readFileSync(envFile(), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
  if (m) env[m[1]] = m[3];
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type RunRow = { id: string; created_at: string; status: string; cost_usd: number | string; cost_breakdown?: unknown };
type ItemRow = LookupItemRow & { contact_id: string; naming_notes: string | null };

async function pages<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const fmt = (n: number) => n.toFixed(4);

async function main() {
  // Migration 00138 present? (Selecting a missing column errors.)
  const hasSplit = !(await admin.from("enrichment_runs").select("cost_breakdown").limit(1)).error;
  if (APPLY && !hasSplit) {
    console.error("--apply needs migration 00138 (enrichment_runs.cost_breakdown). Apply it first.");
    process.exit(1);
  }
  const runs = await pages<RunRow>((from, to) =>
    admin
      .from("enrichment_runs")
      .select(hasSplit ? "id, created_at, status, cost_usd, cost_breakdown" : "id, created_at, status, cost_usd")
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: Perplexity's fee is $${PERPLEXITY_FEE_USD} a call · ${runs.length} enrichment runs\n`);
  console.log("run       created           status    naming  lookups (rows)  fee $    cost_usd now → after");
  let totals = { naming: 0, lookups: 0, rows: 0, fee: 0, runs: 0 };
  for (const run of runs) {
    const items = await pages<ItemRow>((from, to) =>
      admin
        .from("enrichment_run_items")
        .select("id, created_at, contact_id, company_id, company_slug, company_name, domain_status, domain_notes, naming_notes")
        .eq("run_id", run.id)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    const naming = countNamingCalls(items);
    // Website lookups group firms by the contact's location, as the cron did.
    const lookupContacts = [...new Set(items.filter((i) => lookupCallsInNote(i.domain_notes) > 0).map((i) => i.contact_id))];
    const contacts = new Map<string, { location: string | null; enrichment_data: unknown }>();
    for (let i = 0; i < lookupContacts.length; i += 150) {
      const { data, error } = await admin
        .from("contacts")
        .select(
          "id, location, src_location:enrichment_data->source_row->>location, city:enrichment_data->>city, " +
            "state:enrichment_data->>state, profile_location:enrichment_data->enrichment->profile->>location",
        )
        .in("id", lookupContacts.slice(i, i + 150));
      if (error) throw new Error(error.message);
      for (const c of (data ?? []) as unknown as Record<string, string | null>[]) {
        contacts.set(c.id as string, {
          location: c.location,
          enrichment_data: {
            source_row: { location: c.src_location },
            city: c.city,
            state: c.state,
            enrichment: { profile: { location: c.profile_location } },
          },
        });
      }
    }
    const lookups = countLookupCalls(items, (i) => discoveryLocation(contacts.get(i.contact_id)));
    const calls = naming + lookups.calls;
    if (calls === 0) continue;

    const recorded = perplexityFeeRecorded(run);
    // A run still working may add calls after this count: leave it for a re-run.
    const active = run.status === "pending" || run.status === "running";
    const fee = recorded ? 0 : Math.round(calls * PERPLEXITY_FEE_USD * 1e6) / 1e6;
    const next = fee > 0 && !active ? addCosts(run, { perplexity: fee }) : null;
    const note = recorded
      ? unsplitCost(run) > 0
        ? "  fee recorded for part of it: started before 2026-10-12, check by hand"
        : "  fee already recorded"
      : active
        ? "  still running: re-run when it finishes"
        : "";
    console.log(
      `${run.id.slice(0, 8)}  ${run.created_at.slice(0, 16).replace("T", " ")}  ${run.status.padEnd(8)}  ${String(naming).padStart(6)}  ` +
        `${String(lookups.calls).padStart(7)} (${String(lookups.items).padStart(4)})  ${fmt(fee).padStart(7)}  ` +
        `${fmt(Number(run.cost_usd))} → ${next ? fmt(next.cost_usd) : "unchanged"}${note}`,
    );
    if (next) {
      totals = {
        naming: totals.naming + naming,
        lookups: totals.lookups + lookups.calls,
        rows: totals.rows + lookups.items,
        fee: totals.fee + fee,
        runs: totals.runs + 1,
      };
    }
    if (APPLY && next) {
      const { data, error } = await admin
        .from("enrichment_runs")
        .update(next)
        .eq("id", run.id)
        .eq("cost_usd", run.cost_usd) // only if its cost hasn't moved since it was read
        .select("id");
      if (error) throw new Error(`run ${run.id}: ${error.message}`);
      if (!data?.length) console.log(`          ${run.id.slice(0, 8)} not written: its cost changed since it was read; re-run`);
    }
  }
  console.log(
    `\n${totals.runs} runs without the fee: ${totals.naming} naming calls + ${totals.lookups} website-lookup calls ` +
      `(${totals.rows} rows) = ${totals.naming + totals.lookups} calls → $${totals.fee.toFixed(2)}`,
  );
  console.log(APPLY ? "Applied." : "Dry run: nothing written. Re-run with --apply on the owner's go.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
