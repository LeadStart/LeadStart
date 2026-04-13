"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MOCK_BILLING,
  BILLING_PLANS,
  type BillingClient,
} from "@/lib/mock-data";
import { CreditCard, DollarSign, Users, TrendingUp, CheckCircle, Link as LinkIcon, Repeat } from "lucide-react";
import { StatCard } from "@/components/charts/stat-card";

function StatusBadge({ status }: { status: BillingClient["status"] }) {
  const styles: Record<string, string> = {
    active: "badge-green",
    trialing: "badge-blue",
    past_due: "badge-red",
    canceled: "badge-slate",
  };
  return (
    <Badge variant="secondary" className={styles[status] || ""}>
      {status.replace("_", " ")}
    </Badge>
  );
}

function InvoiceStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    paid: "badge-green",
    open: "badge-amber",
    past_due: "badge-red",
    void: "badge-slate",
  };
  return (
    <Badge variant="secondary" className={styles[status] || ""}>
      {status.replace("_", " ")}
    </Badge>
  );
}

export default function BillingPage() {
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const billing = MOCK_BILLING;

  const totalMRR = billing
    .filter((b) => b.status === "active" || b.status === "trialing")
    .reduce((sum, b) => sum + b.monthlyRate, 0);
  const activeSubscriptions = billing.filter((b) => b.status === "active").length;
  const trialCount = billing.filter((b) => b.status === "trialing").length;
  const totalCollected = billing.flatMap((b) => b.invoices).filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amount, 0);

  const selectedBilling = selectedClient
    ? billing.find((b) => b.clientId === selectedClient)
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EBF5FE 0%, #D6ECFB 50%, #fff 100%)', border: '1px solid rgba(30,143,232,0.2)', borderTop: '1px solid rgba(30,143,232,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(30,143,232,0.1)' }}>
        <div className="relative z-10 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748b]">Revenue & Billing</p>
            <h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Billing & Subscriptions</h1>
          </div>
          <Badge variant="secondary" className="bg-white/15 text-[#0f172a] border-0">
            Stripe: Placeholder
          </Badge>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(71,165,237,0.06)]" />
      </div>

      {/* Revenue Overview */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Monthly Revenue"
          value={`$${totalMRR.toLocaleString()}`}
          icon={<DollarSign size={18} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
          valueColor="text-emerald-600"
        />
        <StatCard
          label="Active Subs"
          value={activeSubscriptions}
          icon={<Users size={18} className="text-[#1E8FE8]" />}
          iconBg="bg-[#1E8FE8]/10"
        />
        <StatCard
          label="In Trial"
          value={trialCount}
          icon={<TrendingUp size={18} className="text-blue-500" />}
          iconBg="bg-blue-50"
          valueColor="text-blue-600"
        />
        <StatCard
          label="Total Collected"
          value={`$${totalCollected.toLocaleString()}`}
          icon={<CreditCard size={18} className="text-amber-500" />}
          iconBg="bg-amber-50"
        />
      </div>

      {/* Pricing Plans */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10">
            <CreditCard size={16} className="text-[#1E8FE8]" />
          </div>
          <CardTitle className="text-base">Plans</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {BILLING_PLANS.map((plan) => {
              const subscriberCount = billing.filter(
                (b) => b.plan === plan.id
              ).length;
              return (
                <Card
                  key={plan.id}
                  className="transition-all hover:border-[#1E8FE8]/30 hover:shadow-md"
                >
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-lg">{plan.name}</h3>
                    <Badge variant="secondary" className="bg-[#1E8FE8]/20 text-[#47A5ED] border border-[#1E8FE8]/20">
                      {subscriberCount} client{subscriberCount !== 1 ? "s" : ""}
                    </Badge>
                  </div>
                  <p className="text-3xl font-bold">
                    ${plan.price}
                    <span className="text-sm font-normal text-muted-foreground">/mo</span>
                  </p>
                  <ul className="space-y-1.5">
                    {plan.features.map((f) => (
                      <li key={f} className="text-sm text-muted-foreground flex items-center gap-2">
                        <CheckCircle size={13} className="text-emerald-500 shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                </CardContent>
                </Card>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Client Subscriptions */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10">
          <Repeat size={16} className="text-[#1E8FE8]" />
        </div>
        <h2 className="text-[15px] font-semibold text-[#0f172a]">Client Subscriptions</h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Monthly Rate</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Renews</TableHead>
                <TableHead>Stripe ID</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {billing.map((b) => (
                <TableRow key={b.clientId} className="group">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-bold text-[#0f172a] shrink-0" style={{ background: '#1E8FE8' }}>
                        {b.clientName.charAt(0)}
                      </div>
                      <span className="font-medium">{b.clientName}</span>
                    </div>
                  </TableCell>
                  <TableCell className="capitalize">{b.plan}</TableCell>
                  <TableCell className="text-right font-medium">${b.monthlyRate}</TableCell>
                  <TableCell>
                    <StatusBadge status={b.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(b.currentPeriodEnd).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">
                    {b.stripeCustomerId || "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() =>
                        setSelectedClient(
                          selectedClient === b.clientId ? null : b.clientId
                        )
                      }
                    >
                      {selectedClient === b.clientId ? "Hide" : "Invoices"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Invoice Detail */}
      {selectedBilling && (
        <>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: '#1E8FE8' }}>
            {selectedBilling.clientName.charAt(0)}
          </div>
          <h2 className="text-[15px] font-semibold text-[#0f172a]">
            Invoices — {selectedBilling.clientName}
          </h2>
        </div>
        <Card className="border-border/50 shadow-sm">
          <CardContent>
            {selectedBilling.invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No invoices yet (client is in trial).
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedBilling.invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono text-sm">
                        {inv.id}
                      </TableCell>
                      <TableCell>
                        {new Date(inv.date).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right font-medium">${inv.amount}</TableCell>
                      <TableCell>
                        <InvoiceStatusBadge status={inv.status} />
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" disabled className="text-xs text-muted-foreground">
                          <LinkIcon size={12} className="mr-1" />
                          View in Stripe
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        </>
      )}

      {/* Stripe Integration Status */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10">
            <CreditCard size={16} className="text-[#1E8FE8]" />
          </div>
          <CardTitle className="text-base">Stripe Integration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-dashed border-[#1E8FE8]/20 bg-[#1E8FE8]/5 p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              Stripe integration is in <strong>placeholder mode</strong>. When
              you&apos;re ready to go live, connect your Stripe account and billing
              data will sync automatically.
            </p>
            <div className="flex items-center justify-center gap-3 pt-1">
              <Button disabled style={{ background: '#1E8FE8' }}>
                Connect Stripe Account
              </Button>
              <Button variant="outline" disabled>
                Configure Webhooks
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
            <div className="rounded-xl border border-border/50 p-4 space-y-1">
              <p className="font-semibold">Auto-invoicing</p>
              <p className="text-muted-foreground text-xs">
                Clients are billed automatically on renewal date
              </p>
            </div>
            <div className="rounded-xl border border-border/50 p-4 space-y-1">
              <p className="font-semibold">Payment Links</p>
              <p className="text-muted-foreground text-xs">
                Send branded checkout links to new clients
              </p>
            </div>
            <div className="rounded-xl border border-border/50 p-4 space-y-1">
              <p className="font-semibold">Dunning</p>
              <p className="text-muted-foreground text-xs">
                Automatic retry for failed payments
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
