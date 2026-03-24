import { createClient } from "@/lib/supabase/server";
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
import { Bell, Mail, MailOpen, AlertTriangle, CalendarCheck, CheckCircle } from "lucide-react";
import type { WebhookEvent } from "@/types/app";

const EVENT_STYLES: Record<string, { class: string; icon: React.ReactNode }> = {
  email_sent: { class: "bg-gray-100 text-gray-600 border border-gray-200", icon: <Mail size={11} className="mr-1" /> },
  email_replied: { class: "bg-blue-100 text-blue-700 border border-blue-200", icon: <MailOpen size={11} className="mr-1" /> },
  email_bounced: { class: "bg-red-100 text-red-700 border border-red-200", icon: <AlertTriangle size={11} className="mr-1" /> },
  meeting_booked: { class: "bg-emerald-100 text-emerald-700 border border-emerald-200", icon: <CalendarCheck size={11} className="mr-1" /> },
};

export default async function WebhooksPage() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("webhook_events")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(100);

  const events = (data || []) as WebhookEvent[];

  const eventCounts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Instantly.ai Webhooks</p>
          <h1 className="text-2xl font-bold mt-1">Event Log</h1>
          <p className="text-sm text-white/60 mt-1">
            {events.length} events received
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(eventCounts).map(([type, count]) => {
          const style = EVENT_STYLES[type];
          return (
            <Badge key={type} variant="secondary" className={style?.class || "bg-gray-100 text-gray-600 border border-gray-200"}>
              {style?.icon}
              {type.replace(/_/g, " ")}: {count}
            </Badge>
          );
        })}
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <Bell size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Recent Events</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No webhook events received yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Campaign ID</TableHead>
                  <TableHead>Processed</TableHead>
                  <TableHead>Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => {
                  const style = EVENT_STYLES[event.event_type];
                  return (
                    <TableRow key={event.id}>
                      <TableCell>
                        <Badge variant="secondary" className={style?.class || "bg-gray-100 text-gray-600 border border-gray-200"}>
                          {style?.icon}
                          {event.event_type.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{event.lead_email || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {event.campaign_instantly_id || "—"}
                      </TableCell>
                      <TableCell>
                        {event.processed ? (
                          <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200">
                            <CheckCircle size={11} className="mr-1" />
                            Yes
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-700 border border-amber-200">
                            Pending
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(event.received_at).toLocaleString()}
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
