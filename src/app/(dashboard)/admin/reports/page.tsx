import { createClient } from "@/lib/supabase/server";
import { ReportsClient } from "./reports-client";
import type { Client, KPIReport } from "@/types/app";

export default async function ReportsPage() {
  const supabase = await createClient();
  const [clientsRes, reportsRes] = await Promise.all([
    supabase.from("clients").select("*").order("name"),
    supabase
      .from("kpi_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  return (
    <ReportsClient
      initialClients={(clientsRes.data ?? []) as Client[]}
      initialReports={(reportsRes.data ?? []) as KPIReport[]}
    />
  );
}
