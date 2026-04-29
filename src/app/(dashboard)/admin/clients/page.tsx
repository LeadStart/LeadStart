"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useSort } from "@/hooks/use-sort";
import { createClient } from "@/lib/supabase/client";
import { ADMIN_CLIENTS_KEY, fetchAdminClients } from "@/lib/admin-queries";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableHead } from "@/components/ui/sortable-head";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { AddClientForm } from "./add-client-form";
import { Users, ArrowRight, Archive, ArchiveRestore, Trash2 } from "lucide-react";
import type { ClientStatus } from "@/types/app";

export default function ClientsPage() {
  const [statusFilter, setStatusFilter] = useState<ClientStatus>("active");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data, loading, refetch } = useSupabaseQuery(
    ADMIN_CLIENTS_KEY,
    fetchAdminClients,
  );

  const { clients, campaigns, clientUsers } = data || { clients: [], campaigns: [], clientUsers: [] };

  const activeCount = clients.filter(c => (c.status ?? "active") === "active").length;
  const formerCount = clients.filter(c => c.status === "former").length;

  const rows = clients
    .filter(c => (c.status ?? "active") === statusFilter)
    .map(client => {
      const clientCampaigns = campaigns.filter(c => c.client_id === client.id);
      const activeCampaigns = clientCampaigns.filter(c => c.status === "active");
      const userCount = clientUsers.filter(cu => cu.client_id === client.id).length;
      return { ...client, totalCampaigns: clientCampaigns.length, activeCampaigns: activeCampaigns.length, userCount };
    });
  const { sorted, sortConfig, requestSort } = useSort(rows, "name", "asc");

  async function toggleStatus(clientId: string, current: ClientStatus) {
    const next: ClientStatus = current === "active" ? "former" : "active";
    setPendingId(clientId);
    const supabase = createClient();
    const { error } = await supabase
      .from("clients")
      .update({ status: next })
      .eq("id", clientId);
    setPendingId(null);
    if (error) {
      console.error("Failed to update client status:", error);
      alert(`Could not update client: ${error.message}`);
      return;
    }
    refetch();
  }

  async function deleteClient(clientId: string) {
    setDeleting(true);
    const supabase = createClient();
    await supabase.from("contacts").delete().eq("client_id", clientId);
    const { error } = await supabase.from("clients").delete().eq("id", clientId);
    setDeleting(false);
    setDeleteTarget(null);
    if (error) {
      console.error("Failed to delete client:", error);
      alert(`Could not delete client: ${error.message}`);
      return;
    }
    refetch();
  }

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Client Management</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Clients</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">{activeCount} active &middot; {formerCount} former &middot; {campaigns.filter(c => c.status === "active").length} active campaigns</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>
      <AddClientForm />
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]"><Users size={16} className="text-white" /></div>
          <h2 className="text-[15px] font-semibold text-[#0f172a]">
            {statusFilter === "active" ? "Active Clients" : "Former Clients"}
          </h2>
        </div>
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as ClientStatus)}>
          <TabsList>
            <TabsTrigger value="active">Active ({activeCount})</TabsTrigger>
            <TabsTrigger value="former">Former ({formerCount})</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {statusFilter === "active"
                ? "No active clients. Add one above or check the Former tab."
                : "No former clients yet."}
            </p>
          ) : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="name" sortConfig={sortConfig} onSort={requestSort}>Name</SortableHead><SortableHead sortKey="activeCampaigns" sortConfig={sortConfig} onSort={requestSort}>Campaigns</SortableHead><SortableHead sortKey="userCount" sortConfig={sortConfig} onSort={requestSort}>Portal Access</SortableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {sorted.map((row) => {
                  const rowStatus: ClientStatus = (row.status ?? "active") as ClientStatus;
                  return (
                    <TableRow key={row.id} className="group">
                      <TableCell><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0" style={{ background: '#2E37FE' }}>{row.name.charAt(0)}</div><Link href={`/admin/clients/${row.id}`} className="font-medium text-foreground hover:text-[#2E37FE] transition-colors">{row.name}</Link></div></TableCell>
                      <TableCell><span className="text-sm"><span className="font-medium">{row.activeCampaigns}</span><span className="text-muted-foreground"> active / {row.totalCampaigns} total</span></span></TableCell>
                      <TableCell><Badge variant="secondary" className={row.userCount > 0 ? "badge-green" : "badge-amber"}>{row.userCount > 0 ? `${row.userCount} user${row.userCount !== 1 ? "s" : ""}` : "Not invited"}</Badge></TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pendingId === row.id}
                            onClick={() => toggleStatus(row.id, rowStatus)}
                            className="h-8 px-2 text-xs text-muted-foreground hover:text-[#2E37FE]"
                          >
                            {rowStatus === "active" ? (
                              <><Archive size={13} /> Archive</>
                            ) : (
                              <><ArchiveRestore size={13} /> Restore</>
                            )}
                          </Button>
                          {rowStatus === "former" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs text-muted-foreground hover:text-red-600"
                              onClick={() => setDeleteTarget({ id: row.id, name: row.name })}
                            >
                              <Trash2 size={13} /> Delete
                            </Button>
                          )}
                          <Link href={`/admin/clients/${row.id}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-[#2E37FE] transition-colors">
                            View<ArrowRight size={13} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will also delete all contacts associated with this client from the database. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => { if (deleteTarget) deleteClient(deleteTarget.id); }}
            >
              {deleting ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
