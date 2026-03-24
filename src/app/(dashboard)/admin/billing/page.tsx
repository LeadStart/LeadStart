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
    active: "bg-emerald-100 text-emerald-800 border border-emerald-200",
    trialing: "bg-blue-100 text-blue-800 border border-blue-200",
    past_due: "bg-red-100 text-red-800 border border-red-200",
    canceled: "bg-gray-100 text-gray-600 border border-gray-200",
  };
  return (
    <Badge variant="secondary" className={styles[status] || ""}>
      {status.replace("_", " ")}
    </Badge>
  );
}

function InvoiceStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    paid: "bg-emerald-100 text-emerald-800 border border-emerald-200",
    open: "bg-amber-100 text-amber-800 border border-amber-200",
    past_due: "bg-red-100 text-red-800 border border-red-200",
    void: "bg-gray-100 text-gray-600 border border-gray-200",
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
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-white/70">Revenue & Billing</p>
            <h1 className="text-2xl font-bold mt-1">Billing & Subscriptions</h1>
          </div>
          <Badge variant="secondary" className="bg-white/15 text-white border-0">
            Stripe: Placeholder
          </Badge>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
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
          icon={<Users size={18} className="text-indigo-500" />}
          iconBg="bg-indigo-50"
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
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <CreditCard size={16} className="text-indigo-500" />
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
                <div
                  key={plan.id}
                  className="rounded-xl border border-border/50 p-5 space-y-3 transition-all hover:border-indigo-200 hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-lg">{plan.name}</h3>
                    <Badge variant="secondary" className="bg-indigo-100 text-indigo-700 border border-indigo-200">
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
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Client Subscriptions */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <Repeat size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Client Subscriptions</CardTitle>
        </CardHeader>
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
                      <div className="flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
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
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center gap-2 pb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
              {selectedBilling.clientName.charAt(0)}
            </div>
            <CardTitle className="text-base">
              Invoices — {selectedBilling.clientName}
            </CardTitle>
          </CardHeader>
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
      )}

      {/* Stripe Integration Status */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <CreditCard size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Stripe Integration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-dashed border-indigo-200 bg-indigo-50/30 p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              Stripe integration is in <strong>placeholder mode</strong>. When
              you&apos;re ready to go live, connect your Stripe account and billing
              data will sync automatically.
            </p>
            <div className="flex items-center justify-center gap-3 pt-1">
              <Button disabled style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
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
