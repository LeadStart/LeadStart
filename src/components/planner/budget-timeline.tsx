"use client";

// Budget tab, "Over time" view: a budget (per month, or one total to spread)
// laid out month by month: what we spend, the contacts and emails it carries,
// and the replies it should bring, with running totals. Total mode can also
// compare spreading the same pot over 1, 2, 3, 6 or 12 months.

import { useMemo, useState } from "react";
import { AlertTriangle, CalendarRange, Info, MessageSquare, SlidersHorizontal, Users, Wallet } from "lucide-react";
import { StatCard } from "@/components/charts/stat-card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MAX_SEQUENCE_EMAILS } from "@/lib/planner/engine";
import { launchDateFor } from "@/lib/planner/dates";
import {
  MAX_TIMELINE_MONTHS,
  SPREAD_OPTIONS_MONTHS,
  spreadComparison,
  timelinePlan,
  type TimelineInput,
  type TimelinePlan,
} from "@/lib/planner/timeline";
import { NATIVE_TICK_MINUTES, SENDS_PER_TICK } from "@/lib/gmail/ramp";
import { formatInt, formatNumber, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { withEmailCount, type PlannerState } from "./planner-state";
import type { ReplyHistory } from "./planner";
import { Callout, Hint, NumField, Section, Segmented } from "./fields";
import { Legend, TimelineChart } from "./charts";
import { useDebounced } from "./use-debounced";

type Update = (patch: Partial<PlannerState>) => void;

export function BudgetTimeline({
  state,
  update,
  history,
}: {
  state: PlannerState;
  update: Update;
  history: ReplyHistory | null;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <TimelineInputs state={state} update={update} history={history} />
      <TimelineResults state={state} update={update} history={history} />
    </div>
  );
}

function TimelineInputs({ state: s, update, history }: { state: PlannerState; update: Update; history: ReplyHistory | null }) {
  const total = s.budgetMode === "total";
  const weSource = s.contactsMode === "we_source";
  const gaps = s.waits.slice(1);
  return (
    <div className="space-y-4">
      <Section title="Budget" icon={<Wallet size={14} />}>
        <Segmented
          value={s.budgetMode}
          onChange={(v) => update({ budgetMode: v })}
          options={[
            { value: "monthly", label: "Per month" },
            { value: "total", label: "One total to spread" },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          {total ? (
            <NumField
              label="Total budget"
              prefix="$"
              value={s.totalBudgetUsd}
              min={0}
              max={10_000_000}
              onChange={(v) => update({ totalBudgetUsd: v ?? 0 })}
            />
          ) : (
            <NumField
              label="We spend / month"
              prefix="$"
              value={s.budgetUsd}
              min={0}
              max={1_000_000}
              onChange={(v) => update({ budgetUsd: v ?? 0 })}
            />
          )}
          <NumField
            label={total ? "Spread over (months)" : "Months to show"}
            value={s.horizonMonths}
            min={1}
            max={MAX_TIMELINE_MONTHS}
            integer
            onChange={(v) => update({ horizonMonths: v ?? 1 })}
          />
        </div>
        <Hint>
          {total
            ? "The pot pays for everything: domains, inbox seats from purchase to the last month, and contacts."
            : "Monthly means recurring spend. The one-time setup (domains, paid a year up front, and the inboxes' warm-up weeks) shows on its own line."}
        </Hint>
      </Section>

      <Section title="Assumptions" icon={<SlidersHorizontal size={14} />}>
        <Segmented
          value={s.contactsMode}
          onChange={(v) => update({ contactsMode: v })}
          options={[
            { value: "we_source", label: "We source them" },
            { value: "client_supplies", label: "Client supplies them" },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
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
          <NumField
            label="Emails per contact"
            value={s.waits.length}
            min={1}
            max={MAX_SEQUENCE_EMAILS}
            integer
            onChange={(n) => update({ waits: withEmailCount(s.waits, n) })}
          />
          <NumField
            label="New leads / day"
            value={s.newLeadsCap}
            min={0}
            max={1000}
            integer
            onChange={(v) => update({ newLeadsCap: v ?? 0 })}
            hint={s.strategy === "reach_first" ? "Only 0 matters under reach-first." : "Per campaign."}
          />
          <NumField label="Campaigns" value={s.campaigns} min={1} max={100} integer onChange={(v) => update({ campaigns: v ?? 1 })} />
          <NumField
            label="Reply rate"
            suffix="%"
            value={s.replyRatePct ?? history?.replyRatePct ?? null}
            nullable
            placeholder="none"
            min={0}
            max={100}
            onChange={(v) => update({ replyRatePct: v })}
          />
          <NumField
            label="Positive share"
            suffix="%"
            value={s.positiveRatePct ?? history?.positiveRatePct ?? null}
            nullable
            placeholder="none"
            min={0}
            max={100}
            onChange={(v) => update({ positiveRatePct: v })}
          />
          <NumField
            label="Warm-up days"
            value={s.warmingDays}
            min={0}
            max={365}
            integer
            onChange={(v) => update({ warmingDays: v ?? 0 })}
          />
        </div>
        <Hint>
          Shared with the Campaign tab, so changing one changes both. Also in play from there:{" "}
          {s.strategy === "reach_first" ? "reach everyone first" : "finish the sequence first"}, gaps of{" "}
          {gaps.length > 0 ? `${gaps.join(" and ")} days` : "none"}, up to {s.maxDailyCap}/day per inbox, seats at{" "}
          {formatUsd(s.seatUsd, { cents: true })}/mo, domains at {formatUsd(s.domainUsd, { cents: true })}/yr.
          {history && s.replyRatePct == null ? " Reply rates are your history so far (a small sample)." : ""}
        </Hint>
        <Button variant="outline" size="sm" onClick={() => update({ tab: "campaign" })}>
          Edit the rest on the Campaign tab
        </Button>
      </Section>
    </div>
  );
}

function TimelineResults({ state, update, history }: { state: PlannerState; update: Update; history: ReplyHistory | null }) {
  const s = useDebounced(state, 300);
  const total = s.budgetMode === "total";
  const input: TimelineInput = useMemo(
    () => ({
      budgetMode: s.budgetMode,
      amountUsd: s.budgetMode === "total" ? s.totalBudgetUsd : s.budgetUsd,
      months: s.horizonMonths,
      warmingDays: s.warmingDays,
      replyRatePct: s.replyRatePct ?? history?.replyRatePct ?? null,
      positiveRatePct: s.positiveRatePct ?? history?.positiveRatePct ?? null,
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
    [s, history],
  );
  const plan = useMemo(() => timelinePlan(input), [input]);
  // The spread comparison re-runs the engine per option: on demand, keyed on
  // everything but the horizon (it covers every horizon itself).
  const spreadKey = JSON.stringify({ ...input, months: 0 });
  const [spread, setSpread] = useState<{ key: string; plans: TimelinePlan[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const hasReplies = plan.totalPositives != null;
  const N = plan.months;

  return (
    <div className="@container min-w-0 space-y-4">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatCard label={`Spent over ${N} month${N === 1 ? "" : "s"}`} value={formatUsd(plan.totalSpend)} icon={<Wallet size={16} className="text-primary" />} />
        <StatCard label="Contacts reached" value={formatInt(plan.totalContacts)} icon={<Users size={16} className="text-primary" />} />
        <StatCard
          label="Positive replies"
          value={hasReplies ? formatNumber(plan.totalPositives ?? 0, 1) : "-"}
          icon={<MessageSquare size={16} className="text-primary" />}
        />
        <StatCard
          label="Cost per positive"
          value={plan.costPerPositive != null ? formatUsd(plan.costPerPositive) : "-"}
          icon={<CalendarRange size={16} className="text-primary" />}
        />
      </div>

      <PlanCallout plan={plan} state={s} />

      {plan.inboxes > 0 && (
        <Section title="Month by month" icon={<CalendarRange size={14} />}>
          <Legend keys={["month", "toDate"]} />
          <TimelineChart rows={plan.rows} />
        </Section>
      )}

      {plan.inboxes > 0 && (
        <div className="min-w-0 space-y-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">We spend</TableHead>
                <TableHead className="text-right">Contacts</TableHead>
                <TableHead className="hidden text-right @xl:table-cell">Emails</TableHead>
                {hasReplies && <TableHead className="text-right">Positive</TableHead>}
                <TableHead className="hidden text-right @2xl:table-cell">Spent to date</TableHead>
                <TableHead className="hidden text-right @lg:table-cell">Contacts to date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.rows.map((r) => (
                <TableRow key={r.month}>
                  <TableCell className="whitespace-normal">
                    <p className="text-sm">{r.month === 0 ? "Before sending" : `Month ${r.month}`}</p>
                    {r.month === 0 && <p className="text-[11px] text-muted-foreground">Domains + {s.warmingDays} days of seats</p>}
                    {r.month === 1 && <p className="text-[11px] text-muted-foreground">Inboxes still warming up</p>}
                    {r.renewal && <p className="text-[11px] text-muted-foreground">Domains renew</p>}
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">{formatUsd(r.spend)}</TableCell>
                  <TableCell className="text-right align-top tabular-nums">{r.month === 0 ? "-" : formatInt(r.contacts)}</TableCell>
                  <TableCell className="hidden text-right align-top tabular-nums @xl:table-cell">
                    {r.month === 0 ? "-" : formatInt(r.emails)}
                  </TableCell>
                  {hasReplies && (
                    <TableCell className="text-right align-top tabular-nums">
                      {r.month === 0 ? "-" : formatNumber(r.positives ?? 0, 1)}
                    </TableCell>
                  )}
                  <TableCell className="hidden text-right align-top tabular-nums @2xl:table-cell">{formatUsd(r.spendToDate)}</TableCell>
                  <TableCell className="hidden text-right align-top tabular-nums @lg:table-cell">{r.month === 0 ? "-" : formatInt(r.contactsToDate)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatUsd(plan.totalSpend)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatInt(plan.totalContacts)}</TableCell>
                <TableCell className="hidden text-right font-semibold tabular-nums @xl:table-cell">{formatInt(plan.totalEmails)}</TableCell>
                {hasReplies && (
                  <TableCell className="text-right font-semibold tabular-nums">{formatNumber(plan.totalPositives ?? 0, 1)}</TableCell>
                )}
                <TableCell className="hidden @2xl:table-cell" />
                <TableCell className="hidden @lg:table-cell" />
              </TableRow>
            </TableBody>
          </Table>
          <Hint>
            Contacts count full sequences&apos; worth (emails ÷ {s.waits.length} per contact), replayed on the live sending rules.
            Contacts started in the last weeks still have follow-ups due after month {N}. Replies use the rates on the left.
          </Hint>
        </div>
      )}

      {total && (
        <Section title="Spread it over" icon={<CalendarRange size={14} />}>
          {spread && spread.key === spreadKey ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Months</TableHead>
                  <TableHead className="text-right">Domains</TableHead>
                  <TableHead className="text-right">Contacts</TableHead>
                  {hasReplies && <TableHead className="hidden text-right @md:table-cell">Positive</TableHead>}
                  <TableHead className="hidden text-right @xl:table-cell">Per contact</TableHead>
                  <TableHead className="text-right">Left over</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spread.plans.map((p) => (
                  <TableRow
                    key={p.months}
                    onClick={() => update({ horizonMonths: p.months })}
                    className={cn("cursor-pointer", p.months === s.horizonMonths && "bg-primary/5")}
                  >
                    <TableCell className="font-medium tabular-nums">{p.months}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatInt(p.domains)} <span className="text-[11px] text-muted-foreground">({formatInt(p.inboxes)})</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(p.totalContacts)}</TableCell>
                    {hasReplies && <TableCell className="hidden text-right tabular-nums @md:table-cell">{formatNumber(p.totalPositives ?? 0, 1)}</TableCell>}
                    <TableCell className="hidden text-right tabular-nums @xl:table-cell">
                      {p.costPerContact != null ? formatUsd(p.costPerContact, { cents: true }) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatUsd(p.leftover)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Button
              variant="outline"
              className="h-9"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setTimeout(() => {
                  setSpread({ key: spreadKey, plans: spreadComparison(input) });
                  setBusy(false);
                }, 20);
              }}
            >
              {busy ? "Working…" : `Compare ${SPREAD_OPTIONS_MONTHS.join(", ")} months`}
            </Button>
          )}
          <Hint>
            {spread && spread.key === spreadKey && spread.plans[0].limitedBy !== "budget"
              ? `Short spreads run into the ${spread.plans[0].limitedBy === "platform" ? "sender's ceiling" : "new-leads cap"}: the fleet can't grow to use the money, so they leave more of the ${formatUsd(input.amountUsd)} unspent. Longer ones put it to work.`
              : `The same ${formatUsd(input.amountUsd)} spread over each length: a short burst buys more inboxes, but they spend a bigger share of it warming up, and domains are paid a year at a time.`}{" "}
            Click a row to see it month by month.
          </Hint>
        </Section>
      )}
    </div>
  );
}

function PlanCallout({ plan, state: s }: { plan: TimelinePlan; state: PlannerState }) {
  const N = plan.months;
  const span = `${N} month${N === 1 ? "" : "s"}`;
  const amount = formatUsd(plan.mode === "total" ? plan.budgetTotal : plan.budgetTotal / N);
  if (plan.limitedBy === "paused") {
    return (
      <Callout tone="danger" icon={<AlertTriangle size={16} />}>
        <p>New leads per day is 0, which pauses every campaign. Set it above 0.</p>
      </Callout>
    );
  }
  if (plan.inboxes === 0) {
    return (
      <Callout tone="warn" icon={<AlertTriangle size={16} />}>
        <p>
          {plan.mode === "total" ? `${amount} over ${span}` : `${amount} a month`} doesn&apos;t cover one inbox and its domain
          {s.contactsMode === "we_source" ? " plus its contacts" : ""}.
        </p>
      </Callout>
    );
  }
  const fleet = `${formatInt(plan.inboxes)} inbox${plan.inboxes === 1 ? "" : "es"} on ${formatInt(plan.domains)} domain${plan.domains === 1 ? "" : "s"}`;
  const setup = plan.mode === "monthly" ? ` plus ${formatUsd(plan.setupCost)} one-time setup before the first email` : "";
  if (plan.limitedBy === "new_leads_cap") {
    return (
      <Callout tone="warn" icon={<Info size={16} />}>
        <p>
          <b>The new-leads cap is the limit, not money.</b> The budget could pay for {formatInt(plan.affordableInboxes)} inboxes,
          but {s.campaigns} campaign{s.campaigns === 1 ? "" : "s"} starting {s.newLeadsCap} new contacts a day only fill {fleet}
          {setup}. {formatUsd(plan.leftover)} of it goes unspent over {span}.
        </p>
        <p className="text-xs opacity-80">Raise the cap (campaign Setup), switch to &quot;Reach everyone first&quot;, or run more campaigns to use it.</p>
      </Callout>
    );
  }
  if (plan.limitedBy === "platform") {
    return (
      <Callout tone="warn" icon={<Info size={16} />}>
        <p>
          <b>The sender&apos;s ceiling is the limit.</b> It sends at most {SENDS_PER_TICK} emails every {NATIVE_TICK_MINUTES}{" "}
          minutes across all campaigns, so it stops at {fleet}. {formatUsd(plan.leftover)} goes unspent over {span}.
        </p>
      </Callout>
    );
  }
  return (
    <Callout tone="info" icon={<Info size={16} />}>
      <p>
        <b>Money is the limit.</b>{" "}
        {plan.mode === "total" ? `Spread over ${span}, ${amount} runs ${fleet}, setup included` : `${amount} a month runs ${fleet}${setup}`}.{" "}
        {plan.leftover >= 0.5 ? `${formatUsd(plan.leftover)} left over.` : ""}
      </p>
    </Callout>
  );
}
