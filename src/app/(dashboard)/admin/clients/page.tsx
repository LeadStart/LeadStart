"use client";

import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useSort } from "@/hooks/use-sort";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableHead } from "@/components/ui/sortable-head";
import { AddClientForm } from "./add-client-form";
import { Users, ArrowRight } from "lucide-react";
import type { Client, Campaign, ClientUser } from "@/types/app";

export default function ClientsPage() {
  const { data, loading } = useSupabaseQuery("admin-clients", async (supabase) => {
    const [clientsRes, campaignsRes, clientUsersRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("campaigns").select("*"),
      supabase.from("client_users").select("*"),
    ]);
    return {
      clients: (clientsRes.data || []) as Client[],
      campaigns: (campaignsRes.data || []) as Campaign[],
      clientUsers: (clientUsersRes.data || []) as ClientUser[],
    };
  });

  const { clients, campaigns, clientUsers } = data || { clients: [], campaigns: [], clientUsers: [] };

  const rows = clients.map(client => {
    const clientCampaigns = campaigns.filter(c => c.client_id === client.id);
    const activeCampaigns = clientCampaigns.filter(c => c.status === "active");
    const userCount = clientUsers.filter(cu => cu.client_id === client.id).length;
    return { ...client, totalCampaigns: clientCampaigns.length, activeCampaigns: activeCampaigns.length, userCount };
  });
  const { sorted, sortConfig, requestSort } = useSort(rows, "name", "asc");

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EBF5FE 0%, #D6ECFB 50%, #fff 100%)', border: '1px solid rgba(30,143,232,0.2)', borderTop: '1px solid rgba(30,143,232,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(30,143,232,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Client Management</p>
          <h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Clients</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">{clients.length} client{clients.length !== 1 ? "s" : ""} &middot; {campaigns.filter(c => c.status === "active").length} active campaigns</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(71,165,237,0.06)]" />
      </div>
      <AddClientForm />
      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10"><Users size={16} className="text-[#1E8FE8]" /></div>
        <h2 className="text-[15px] font-semibold text-[#0f172a]">All Clients</h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {clients.length === 0 ? <p className="text-sm text-muted-foreground">No clients yet. Add one above.</p> : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="name" sortConfig={sortConfig} onSort={requestSort}>Name</SortableHead><SortableHead sortKey="contact_email" sortConfig={sortConfig} onSort={requestSort}>Email</SortableHead><SortableHead sortKey="activeCampaigns" sortConfig={sortConfig} onSort={requestSort}>Campaigns</SortableHead><SortableHead sortKey="userCount" sortConfig={sortConfig} onSort={requestSort}>Portal Access</SortableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {sorted.map((row) => (
                    <TableRow key={row.id} className="group">
                      <TableCell><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: '#1E8FE8' }}>{row.name.charAt(0)}</div><Link href={`/admin/clients/${row.id}`} className="font-medium text-foreground hover:text-[#1E8FE8] transition-colors">{row.name}</Link></div></TableCell>
                      <TableCell className="text-muted-foreground">{row.contact_email || "—"}</TableCell>
                      <TableCell><span className="text-sm"><span className="font-medium">{row.activeCampaigns}</span><span className="text-muted-foreground"> active / {row.totalCampaigns} total</span></span></TableCell>
                      <TableCell><Badge variant="secondary" className={row.userCount > 0 ? "badge-green" : "badge-amber"}>{row.userCount > 0 ? `${row.userCount} user${row.userCount !== 1 ? "s" : ""}` : "Not invited"}</Badge></TableCell>
                      <TableCell><Link href={`/admin/clients/${row.id}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-[#1E8FE8] transition-colors">View<ArrowRight size={13} className="opacity-0 group-hover:opacity-100 transition-opacity" /></Link></TableCell>
                    </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
