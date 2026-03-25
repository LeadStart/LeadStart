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
import type { Client, Campaign } from "@/types/app";

export default function ClientsPage() {
  const { data, loading } = useSupabaseQuery("admin-clients", async (supabase) => {
    const [clientsRes, campaignsRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("campaigns").select("*"),
    ]);
    return {
      clients: (clientsRes.data || []) as Client[],
      campaigns: (campaignsRes.data || []) as Campaign[],
    };
  });

  const { clients, campaigns } = data || { clients: [], campaigns: [] };

  const rows = clients.map(client => {
    const clientCampaigns = campaigns.filter(c => c.client_id === client.id);
    const activeCampaigns = clientCampaigns.filter(c => c.status === "active");
    return { ...client, totalCampaigns: clientCampaigns.length, activeCampaigns: activeCampaigns.length };
  });
  const { sorted, sortConfig, requestSort } = useSort(rows, "name", "asc");

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Client Management</p>
          <h1 className="text-2xl font-bold mt-1">Clients</h1>
          <p className="text-sm text-white/60 mt-1">{clients.length} client{clients.length !== 1 ? "s" : ""} &middot; {campaigns.filter(c => c.status === "active").length} active campaigns</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>
      <AddClientForm />
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50"><Users size={16} className="text-indigo-500" /></div><CardTitle className="text-base">All Clients</CardTitle></CardHeader>
        <CardContent>
          {clients.length === 0 ? <p className="text-sm text-muted-foreground">No clients yet. Add one above.</p> : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="name" sortConfig={sortConfig} onSort={requestSort}>Name</SortableHead><SortableHead sortKey="contact_email" sortConfig={sortConfig} onSort={requestSort}>Email</SortableHead><SortableHead sortKey="activeCampaigns" sortConfig={sortConfig} onSort={requestSort}>Campaigns</SortableHead><SortableHead sortKey="user_id" sortConfig={sortConfig} onSort={requestSort}>Portal Access</SortableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {sorted.map((row) => (
                    <TableRow key={row.id} className="group">
                      <TableCell><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>{row.name.charAt(0)}</div><Link href={`/admin/clients/${row.id}`} className="font-medium text-foreground hover:text-indigo-600 transition-colors">{row.name}</Link></div></TableCell>
                      <TableCell className="text-muted-foreground">{row.contact_email || "—"}</TableCell>
                      <TableCell><span className="text-sm"><span className="font-medium">{row.activeCampaigns}</span><span className="text-muted-foreground"> active / {row.totalCampaigns} total</span></span></TableCell>
                      <TableCell><Badge variant="secondary" className={row.user_id ? "bg-emerald-100 text-emerald-800 border border-emerald-200" : "bg-amber-100 text-amber-800 border border-amber-200"}>{row.user_id ? "Linked" : "Not invited"}</Badge></TableCell>
                      <TableCell><Link href={`/admin/clients/${row.id}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-indigo-600 transition-colors">View<ArrowRight size={13} className="opacity-0 group-hover:opacity-100 transition-opacity" /></Link></TableCell>
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
