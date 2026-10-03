"use client";

import { useMemo } from "react";
import { AlertTriangle, ArrowRight, Gauge, Info, Layers, Mail, Users, Wallet } from "lucide-react";
import { StatCard } from "@/components/charts/stat-card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BUDGET_MEASURE_MONTHS, budgetLadder, type BudgetInput, type BudgetPlan } from "@/lib/planner/budget";
import { rampCaps } from "@/lib/planner/engine";
import { launchDateFor } from "@/lib/planner/dates";
import { NATIVE_TICK_MINUTES, SENDS_PER_TICK } from "@/lib/gmail/ramp";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PlannerState } from "./planner-state";
import type { ReplyHistory } from "./planner";
import { Callout, Hint, NumField, Section, Segmented } from "./fields";
import { RampChart } from "./charts";
import { BudgetTimeline } from "./budget-timeline";
import { useDebounced } from "./use-debounced";

type Update = (patch: Partial<PlannerState>) => void;

const LIMIT_LABEL: Record<BudgetPlan["limitedBy"], string> = {
  budget: "Budget",
  new_leads_cap: "Lead cap",
  platform: "Sender",
  paused: "Paused",
};

export function BudgetTab({
  state,
  update,
  history,
}: {
  state: PlannerState;
  update: Update;
  history: ReplyHistory | null;
}) {
  return (
    <div className="space-y-4">
      <Segmented
        value={state.budgetView}
        onChange={(v) => update({ budgetView: v })}
        options={[
          { value: "monthly", label: "Per month" },
          { value: "timeline", label: "Over time" },
        ]}
        className="max-w-xs"
      />
      {state.budgetView === "timeline" ? (
        <BudgetTimeline state={state} update={update} history={history} />
      ) : (
        <MonthlyBudget state={state} update={update} />
      )}
    </div>
  );
}

// "Per month": what a monthly budget buys at steady state, plus the ladder.
function MonthlyBudget({ state, update }: { state: PlannerState; update: Update }) {
  const s = state;
  const weSource = s.contactsMode === "we_source";
  const gaps = s.waits.slice(1);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Section title="Monthly budget" icon={<Wallet size={14} />}>
          <div className="grid grid-cols-2 gap-3">
            <NumField label="We spend / month" prefix="$" value={s.budgetUsd} min={0} max={1_000_000} onChange={(v) => update({ budgetUsd: v ?? 0 })} />
            <NumField
              label="Campaigns"
              value={s.campaigns}
              min={1}
              max={100}
              integer
              onChange={(v) => update({ campaigns: v ?? 1 })}
              hint="Each has its own new-leads cap."
            />
          </div>
          <Segmented
            value={s.contactsMode}
            onChange={(v) => update({ contactsMode: v })}
            options={[
              { value: "we_source", label: "Budget buys contacts too" },
              { value: "client_supplies", label: "Client supplies them" },
            ]}
          />
          {weSource && (
            <NumField
              label="Our cost per contact"
              prefix="$"
              value={s.sourcingUsd}
              min={0}
              max={100}
              onChange={(v) => update({ sourcingUsd: v ?? 0 })}
            />
          )}
          <Hint>
            Uses the Campaign tab&apos;s sequence and sending rules: {s.waits.length} email{s.waits.length === 1 ? "" : "s"} per contact
            {gaps.length > 0 ? ` (${gaps.join(" and ")} days apart)` : ""},{" "}
            {s.strategy === "reach_first" ? "reach everyone first" : `finish first at ${s.newLeadsCap} new contacts/day per campaign`},
            up to {s.maxDailyCap}/day per inbox, {s.inboxesPerDomain} inbox{s.inboxesPerDomain === 1 ? "" : "es"} per domain, seats at{" "}
            {formatUsd(s.seatUsd, { cents: true })}/mo and domains at {formatUsd(s.domainUsd, { cents: true })}/yr.
          </Hint>
          <Button variant="outline" size="sm" onClick={() => update({ tab: "campaign" })}>
            Edit them on the Campaign tab
          </Button>
        </Section>
      </div>
      <BudgetResults state={state} update={update} />
    </div>
  );
}

function BudgetResults({ state, update }: { state: PlannerState; update: Update }) {
  const s = useDebounced(state, 300);
  const input: BudgetInput = useMemo(
    () => ({
      monthlyBudgetUsd: s.budgetUsd,
      waits: s.waits,
      campaigns: s.campaigns,
      strategy: s.strategy,
      newLeadsCap: s.newLeadsCap,
      weekdaysOnly: s.weekdaysOnly,
      startHour: s.startHour,
      endHour: s.endHour,
      maxDailyCap: s.maxDailyCap,
      inboxesPerDomain: s.inboxesPerDomain,
      weSource: s.contactsMode === "we_source",
      sourcingUsdPerContact: s.sourcingUsd,
      seatUsdPerMonth: s.seatUsd,
      domainUsdPerYear: s.domainUsd,
      otherSendsPerDay: s.otherSendsPerDay,
      launchDate: launchDateFor(s.startDate, s.warmingDays),
    }),
    [s],
  );
  const ladder = useMemo(() => budgetLadder(input), [input]);
  const plan = ladder.find((r) => r.budget === s.budgetUsd) ?? ladder[0];
  const caps = useMemo(() => rampCaps(20, s.maxDailyCap), [s.maxDailyCap]);
  if (!plan) return null;

  return (
    <div className="@container min-w-0 space-y-4">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatCard
          label={`Domains (${formatInt(plan.inboxes)} inboxes)`}
          value={formatInt(plan.domains)}
          icon={<Layers size={16} className="text-primary" />}
        />
        <StatCard label="Contacts / month" value={formatInt(plan.contactsPerMonth)} icon={<Users size={16} className="text-primary" />} />
        <StatCard label="Emails / sending day" value={formatInt(plan.emailsPerDay)} icon={<Mail size={16} className="text-primary" />} />
        <StatCard label="We spend / month" value={formatUsd(plan.monthlyCost)} icon={<Wallet size={16} className="text-primary" />} />
      </div>

      <LimitCallout plan={plan} state={s} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={plan.domains === 0}
          onClick={() => update({ domains: Math.max(1, plan.domains), tab: "campaign" })}
        >
          Plan a campaign on {formatInt(plan.domains)} domain{plan.domains === 1 ? "" : "s"} <ArrowRight size={14} />
        </Button>
      </div>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-semibold">Month 1 vs steady</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead className="text-right">Month 1</TableHead>
                <TableHead className="text-right">Month {BUDGET_MEASURE_MONTHS} on</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Contacts</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(plan.contactsMonth1)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(plan.contactsPerMonth)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Emails</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(plan.emailsMonth1)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(plan.emailsPerMonth)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Inboxes in use</TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums">{formatInt(plan.utilizationPct)}%</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Hint>
            Month 1 is the inboxes warming up. Measured by replaying the sender on an endless list: the ramp, the new-leads cap, Monday pile-ups and the sender&apos;s
            per-{NATIVE_TICK_MINUTES}-minute budget included. Contacts count full sequences (emails ÷ emails per contact).
          </Hint>
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-semibold">Where the money goes (per month)</p>
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>
                  <p className="text-sm">Inbox seats</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatInt(plan.inboxes)} × {formatUsd(s.seatUsd, { cents: true })}
                  </p>
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">{formatUsd(plan.seatsCost, { cents: true })}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>
                  <p className="text-sm">Domains</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatInt(plan.domains)} × {formatUsd(s.domainUsd, { cents: true })}/yr ÷ 12 (paid up front: {formatUsd(plan.domainsUpFront)})
                  </p>
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">{formatUsd(plan.domainsCost, { cents: true })}</TableCell>
              </TableRow>
              {s.contactsMode === "we_source" && (
                <TableRow>
                  <TableCell>
                    <p className="text-sm">Contacts</p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatInt(plan.contactsPerMonth)} × {formatUsd(s.sourcingUsd, { precise: true })}
                    </p>
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">{formatUsd(plan.sourcingCost, { cents: true })}</TableCell>
                </TableRow>
              )}
              <TableRow>
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatUsd(plan.monthlyCost, { cents: true })}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">Left over</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatUsd(plan.leftover, { cents: true })}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      <Section title="One inbox warming up" icon={<Gauge size={14} />}>
        <RampChart caps={caps} />
        <Hint>
          Daily cap on its first 20 sending days when it sends its full allowance. Weekends don&apos;t count, and a day it sends
          less doesn&apos;t move it up, so an under-used inbox warms slower.
        </Hint>
      </Section>

      <div className="min-w-0 space-y-2">
        <p className="text-sm font-semibold">What each budget buys</p>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Per month</TableHead>
                <TableHead className="text-right">Domains</TableHead>
                <TableHead className="hidden text-right @2xl:table-cell">Inboxes</TableHead>
                <TableHead className="text-right">Contacts</TableHead>
                <TableHead className="hidden text-right @2xl:table-cell">Emails/day</TableHead>
                <TableHead className="hidden text-right @md:table-cell">We spend</TableHead>
                <TableHead className="hidden text-right @xl:table-cell">Per contact</TableHead>
                <TableHead>Limit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ladder.map((r) => (
                <TableRow
                  key={r.budget}
                  onClick={() => update({ budgetUsd: r.budget })}
                  className={cn("cursor-pointer", r.budget === s.budgetUsd && "bg-primary/5")}
                >
                  <TableCell className="font-medium tabular-nums">{formatUsd(r.budget)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.domains)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums @2xl:table-cell">{formatInt(r.inboxes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.contactsPerMonth)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums @2xl:table-cell">{formatInt(r.emailsPerDay)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums @md:table-cell">{formatUsd(r.monthlyCost)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums @xl:table-cell">
                    {r.costPerContact != null ? formatUsd(r.costPerContact, { cents: true }) : "-"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{LIMIT_LABEL[r.limitedBy]}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Hint>Steady-state month. Click a row to look at that budget.</Hint>
      </div>
    </div>
  );
}

function LimitCallout({ plan, state: s }: { plan: BudgetPlan; state: PlannerState }) {
  if (plan.limitedBy === "paused") {
    return (
      <Callout tone="danger" icon={<AlertTriangle size={16} />}>
        <p>New leads per day is 0, which pauses every campaign. Set it above 0 on the Campaign tab.</p>
      </Callout>
    );
  }
  if (plan.inboxes === 0) {
    return (
      <Callout tone="warn" icon={<AlertTriangle size={16} />}>
        <p>This budget doesn&apos;t cover one inbox and its domain{s.contactsMode === "we_source" ? " plus its contacts" : ""}.</p>
      </Callout>
    );
  }
  if (plan.limitedBy === "new_leads_cap") {
    return (
      <Callout tone="warn" icon={<Info size={16} />}>
        <p>
          <b>The new-leads cap is the limit, not money.</b> {formatUsd(plan.budget)} a month could pay for{" "}
          {formatInt(plan.affordableInboxes)} inboxes, but {s.campaigns} campaign{s.campaigns === 1 ? "" : "s"} starting{" "}
          {s.newLeadsCap} new contacts a day only fill{s.campaigns === 1 ? "s" : ""} {formatInt(plan.inboxes)}. Buying more leaves
          capacity unused, so {formatUsd(plan.leftover)} a month stays unspent.
        </p>
        {plan.suggestedCap != null && (
          <p className="text-xs opacity-80">
            To put the full budget to work, raise the cap to about {formatInt(plan.suggestedCap)} a day per campaign (campaign
            Setup), switch to &quot;Reach everyone first&quot;, or run more campaigns.
          </p>
        )}
      </Callout>
    );
  }
  if (plan.limitedBy === "platform") {
    return (
      <Callout tone="warn" icon={<Info size={16} />}>
        <p>
          <b>The sender&apos;s ceiling is the limit.</b> It sends at most {SENDS_PER_TICK} emails every {NATIVE_TICK_MINUTES}{" "}
          minutes across all campaigns, about {formatInt(plan.platformCeilingPerDay)} a day in this window
          {s.otherSendsPerDay > 0 ? " after other campaigns" : ""}. Inboxes past {formatInt(plan.inboxes)} would sit idle.
        </p>
      </Callout>
    );
  }
  return (
    <Callout tone="info" icon={<Info size={16} />}>
      <p>
        <b>Money is the limit.</b> {formatUsd(plan.budget)} a month runs {formatInt(plan.inboxes)} inboxes on{" "}
        {formatInt(plan.domains)} domain{plan.domains === 1 ? "" : "s"}, about {formatInt(plan.contactsPerMonth)} contacts a month
        once warmed ({formatInt(plan.contactsMonth1)} in month 1).
      </p>
    </Callout>
  );
}
