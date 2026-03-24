import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { calculateMetrics } from "@/lib/kpi/calculator";
import { Mail, ArrowRight } from "lucide-react";
import type { Campaign, Client, CampaignSnapshot } from "@/types/app";

export default async function AllCampaignsPage() {
  const supabase = await createClient();

  const [campaignsRes, clientsRes, snapshotsRes] = await Promise.all([
    supabase.from("campaigns").select("*").order("created_at", { ascending: false }),
    supabase.from("clients").select("*"),
    supabase
      .from("campaign_snapshots")
      .select("*")
      .gte("snapshot_date", new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0]),
  ]);

  const campaigns = (campaignsRes.data || []) as Campaign[];
  const clients = (clientsRes.data || []) as Client[];
  const snapshots = (snapshotsRes.data || []) as CampaignSnapshot[];

  const clientMap = new Map(clients.map((c) => [c.id, c]));

  const active = campaigns.filter((c) => c.status === "active").length;
  const paused = campaigns.filter((c) => c.status === "paused").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Campaign Management</p>
          <h1 className="text-2xl font-bold mt-1">All Campaigns</h1>
          <p className="text-sm text-white/60 mt-1">
            {active} active &middot; {paused} paused &middot; {campaigns.length} total
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardContent className="pt-6">
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No campaigns yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Sent (30d)</TableHead>
                  <TableHead className="text-right">Reply Rate</TableHead>
                  <TableHead className="text-right">Bounce Rate</TableHead>
                  <TableHead className="text-right">Meetings</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((campaign) => {
                  const client = clientMap.get(campaign.client_id);
                  const campaignSnapshots = snapshots.filter(
                    (s) => s.campaign_id === campaign.id
                  );
                  const metrics = calculateMetrics(campaignSnapshots);

                  return (
                    <TableRow key={campaign.id} className="group">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                            <Mail size={14} />
                          </div>
                          <Link
                            href={`/admin/clients/${campaign.client_id}/campaigns/${campaign.id}`}
                            className="font-medium text-foreground hover:text-indigo-600 transition-colors"
                          >
                            {campaign.name}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/admin/clients/${campaign.client_id}`}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {client?.name || "—"}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={
                            campaign.status === "active"
                              ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                              : campaign.status === "paused"
                              ? "bg-amber-100 text-amber-800 border border-amber-200"
                              : "bg-gray-100 text-gray-600 border border-gray-200"
                          }
                        >
                          {campaign.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium">{metrics.emails_sent.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <span className={metrics.reply_rate >= 5 ? "text-emerald-600 font-medium" : "text-amber-600"}>
                          {metrics.reply_rate}%
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={metrics.bounce_rate <= 2 ? "text-emerald-600" : "text-red-600 font-medium"}>
                          {metrics.bounce_rate}%
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-medium">{metrics.meetings_booked}</TableCell>
                      <TableCell>
                        <Link href={`/admin/clients/${campaign.client_id}/campaigns/${campaign.id}`}>
                          <ArrowRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
