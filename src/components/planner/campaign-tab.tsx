"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarCheck,
  CalendarClock,
  Coins,
  HandCoins,
  Inbox,
  Info,
  MessageSquare,
  Rocket,
  Settings2,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { StatCard } from "@/components/charts/stat-card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  MAX_SEQUENCE_EMAILS,
  capSweep,
  simulateCampaign,
  solveDomains,
  whatIf,
  type CampaignSimInput,
  type CapSweepRow,
  type DomainSolve,
  type SimResult,
  type WhatIf,
} from "@/lib/planner/engine";
import {
  PLANNER_DEFAULT_SOURCING_USD,
  STRIPE_CARD_FEE_FIXED_USD,
  STRIPE_CARD_FEE_PCT,
  campaignEconomics,
  sequencedContacts,
  type LineItem,
} from "@/lib/planner/economics";
import { daysBetween, launchDateFor } from "@/lib/planner/dates";
import { MAX_INBOXES_PER_DOMAIN } from "@/lib/deliverability/provisioning";
import { ABSOLUTE_MAX_DAILY_CAP, NATIVE_TICK_MINUTES, RAMP_STAGES, SENDS_PER_TICK } from "@/lib/gmail/ramp";
import { formatCivilDate, formatInt, formatNumber, formatPct, formatUsd } from "@/lib/format";
import { withEmailCount, type PlannerState } from "./planner-state";
import type { ReplyHistory } from "./planner";
import { Callout, CheckField, DateField, Hint, NumField, Section, Segmented, SelectField } from "./fields";
import { Legend, SendsChart } from "./charts";
import { useDebounced } from "./use-debounced";

type Update = (patch: Partial<PlannerState>) => void;

const HOURS = Array.from({ length: 25 }, (_, h) => h);
const fmtHour = (h: number) => {
  const hr = h % 24;
  return `${hr % 12 === 0 ? 12 : hr % 12} ${hr < 12 || h === 24 ? "AM" : "PM"}`;
};

export function simInputFor(s: PlannerState): CampaignSimInput {
  return {
    contacts: sequencedContacts(s.contactsMode, s.listSize, s.sendablePct),
    waits: s.waits,
    domains: s.domains,
    inboxesPerDomain: s.inboxesPerDomain,
    maxDailyCap: s.maxDailyCap,
    strategy: s.strategy,
    newLeadsCap: s.newLeadsCap,
    weekdaysOnly: s.weekdaysOnly,
    startHour: s.startHour,
    endHour: s.endHour,
    domainDailyCap: s.domainDailyCap,
    otherSendsPerDay: s.otherSendsPerDay,
    startWarmed: s.startWarmed,
    launchDate: launchDateFor(s.startDate, s.warmingDays),
  };
}

export function CampaignTab({
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
      <CampaignInputs state={state} update={update} history={history} />
      <CampaignResults state={state} update={update} history={history} />
    </div>
  );
}

// ── Inputs ─────────────────────────────────────────────────────────────────

function CampaignInputs({ state: s, update, history }: { state: PlannerState; update: Update; history: ReplyHistory | null }) {
  const emails = s.waits.length;
  const gaps = s.waits.slice(1);
  const uniformGap = gaps.length > 0 && gaps.every((g) => g === gaps[0]) ? gaps[0] : null;
  const inboxes = s.domains * s.inboxesPerDomain;
  const launch = launchDateFor(s.startDate, s.warmingDays);
  const weSource = s.contactsMode === "we_source";

  const setEmails = (n: number | null) => update({ waits: withEmailCount(s.waits, n) });
  const setGap = (i: number, v: number | null) => {
    const next = [...s.waits];
    next[i + 1] = Math.max(0, Math.min(365, Math.floor(v ?? 0)));
    update({ waits: next });
  };

  return (
    <div className="space-y-4">
      <Section title="Contacts & sequence" icon={<Users size={14} />}>
        <Segmented
          value={s.contactsMode}
          onChange={(v) => update({ contactsMode: v })}
          options={[
            { value: "we_source", label: "We source them" },
            { value: "client_supplies", label: "Client supplies them" },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Contacts" value={s.listSize} min={0} max={1_000_000} integer onChange={(v) => update({ listSize: v ?? 0 })} />
          {weSource ? (
            <NumField
              label="Our cost per contact"
              prefix="$"
              value={s.sourcingUsd}
              min={0}
              max={100}
              onChange={(v) => update({ sourcingUsd: v ?? 0 })}
            />
          ) : (
            <NumField
              label="Verify as sendable"
              suffix="%"
              value={s.sendablePct}
              min={0}
              max={100}
              onChange={(v) => update({ sendablePct: v ?? 100 })}
            />
          )}
        </div>
        <Hint>
          {weSource
            ? s.sourcingUsd === PLANNER_DEFAULT_SOURCING_USD
              ? `${formatUsd(PLANNER_DEFAULT_SOURCING_USD, { cents: true })} per sendable contact was measured once (Dallas Maps run, 12 businesses, about a third yielded a verified owner email). Swap in your own figure.`
              : "Our cost per contact that ends up sendable (verified)."
            : "Every address is checked before its first email; invalid ones drop out. Unknown until a verification run, so 100% is the optimistic case."}
        </Hint>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Emails per contact" value={emails} min={1} max={MAX_SEQUENCE_EMAILS} integer onChange={setEmails} />
          <NumField
            label="Days between emails"
            value={uniformGap}
            nullable
            placeholder="varies"
            min={0}
            max={365}
            integer
            onChange={(v) => v != null && update({ waits: [0, ...gaps.map(() => v)] })}
          />
        </div>
        {gaps.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {gaps.map((g, i) => (
              <label key={i} className="flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs text-muted-foreground">
                Email {i + 2}
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={g}
                  onChange={(e) => setGap(i, e.target.value === "" ? 0 : Number(e.target.value))}
                  className="w-12 rounded border border-input bg-background px-1 py-0.5 text-right text-xs tabular-nums text-foreground"
                />
                days later
              </label>
            ))}
          </div>
        )}
      </Section>

      <Section title="Sending setup" icon={<Inbox size={14} />}>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Domains" value={s.domains} min={1} max={200} integer onChange={(v) => update({ domains: v ?? 1 })} />
          <SelectField
            label="Inboxes per domain"
            value={s.inboxesPerDomain}
            options={Array.from({ length: MAX_INBOXES_PER_DOMAIN }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
            onChange={(v) => update({ inboxesPerDomain: v })}
          />
        </div>
        <Hint>
          {formatInt(inboxes)} inbox{inboxes === 1 ? "" : "es"}. Each starts at {RAMP_STAGES[0].cap} emails a day and climbs by one
          each day it sends its full allowance, up to {s.maxDailyCap}/day ({formatInt(inboxes * s.maxDailyCap)}/day in total once warmed).
        </Hint>
        <div className="grid grid-cols-2 gap-3">
          <DateField label="Buy inboxes on" value={s.startDate} onChange={(v) => update({ startDate: v })} />
          <NumField label="Warm-up days" value={s.warmingDays} min={0} max={365} integer onChange={(v) => update({ warmingDays: v ?? 0 })} />
        </div>
        <Hint>First email goes out {formatCivilDate(launch, { weekday: true })} (start + warm-up days, moved to a weekday).</Hint>
      </Section>

      <Section title="What it costs us" icon={<Coins size={14} />}>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Inbox seat / month" prefix="$" value={s.seatUsd} min={0} max={1000} onChange={(v) => update({ seatUsd: v ?? 0 })} />
          <NumField label="Domain / year" prefix="$" value={s.domainUsd} min={0} max={1000} onChange={(v) => update({ domainUsd: v ?? 0 })} />
        </div>
        <SelectField
          label="Domains are"
          value={s.domainBasis}
          options={[
            { value: "dedicated", label: "Bought for this campaign (full year)" },
            { value: "shared", label: "Reused (charge this campaign its share)" },
          ]}
          onChange={(v) => update({ domainBasis: v })}
        />
        <NumField
          label="Other monthly costs"
          prefix="$"
          value={s.otherMonthlyUsd}
          min={0}
          onChange={(v) => update({ otherMonthlyUsd: v ?? 0 })}
          hint="Anything else this campaign carries, e.g. a share of tool plans."
        />
      </Section>

      <Section title="What the client pays" icon={<HandCoins size={14} />}>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Monthly retainer" prefix="$" value={s.retainerUsd} min={0} onChange={(v) => update({ retainerUsd: v ?? 0 })} />
          <NumField label="Setup fee" prefix="$" value={s.setupUsd} min={0} onChange={(v) => update({ setupUsd: v ?? 0 })} />
          <NumField
            label="Sourcing / contact"
            prefix="$"
            value={s.sourcingPriceUsd}
            min={0}
            max={1000}
            onChange={(v) => update({ sourcingPriceUsd: v ?? 0 })}
          />
          <NumField
            label="Monthly charges"
            value={s.chargesOverride}
            nullable
            placeholder="auto"
            min={0}
            max={120}
            integer
            onChange={(v) => update({ chargesOverride: v })}
          />
          <NumField label="Card fee" suffix="%" value={s.feePct} min={0} max={100} onChange={(v) => update({ feePct: v ?? 0 })} />
          <NumField label="Fee per charge" prefix="$" value={s.feeFixedUsd} min={0} max={100} onChange={(v) => update({ feeFixedUsd: v ?? 0 })} />
        </div>
        <Hint>
          Monthly charges: blank counts them for you (first on launch day, then monthly while emails are sending). Fees default
          to Stripe&apos;s standard card rate, {STRIPE_CARD_FEE_PCT}% + {formatUsd(STRIPE_CARD_FEE_FIXED_USD, { cents: true })}{" "}
          (stripe.com/pricing, checked Oct 2026).
        </Hint>
      </Section>

      <Section title="Replies" icon={<MessageSquare size={14} />}>
        <div className="grid grid-cols-2 gap-3">
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
        </div>
        <Hint>
          {history
            ? `Defaults are your history: ${formatPct(history.replyRatePct, 2)} of ${formatInt(history.contacted)} contacts emailed replied, and ${formatPct(history.positiveRatePct, 0)} of ${formatInt(history.replies)} replies were positive (${history.campaigns} campaign${history.campaigns === 1 ? "" : "s"}). A small sample, and every list differs.`
            : "No reply history yet. Enter rates to project replies."}
        </Hint>
      </Section>

      <details className="group rounded-xl border bg-card p-4">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold">
          <Settings2 size={14} /> Sending rules
          <span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">
            {s.strategy === "reach_first" ? "Reach everyone first" : `Finish first, ${s.newLeadsCap} new/day`}
          </span>
        </summary>
        <div className="mt-3 space-y-3">
          <SelectField
            label="Strategy"
            value={s.strategy}
            options={[
              { value: "finish_first", label: "Finish the sequence first" },
              { value: "reach_first", label: "Reach everyone first" },
            ]}
            onChange={(v) => update({ strategy: v })}
            hint={
              s.strategy === "reach_first"
                ? "First emails get priority and use full inbox capacity; follow-ups fill in behind."
                : "Follow-ups get priority; new contacts start at the new-leads cap below."
            }
          />
          <div className="grid grid-cols-2 gap-3">
            <NumField
              label="New leads / day"
              value={s.newLeadsCap}
              min={0}
              max={1000}
              integer
              onChange={(v) => update({ newLeadsCap: v ?? 0 })}
              hint={s.strategy === "reach_first" ? "Only 0 matters here (pauses)." : "Per campaign. 0 pauses."}
            />
            <NumField
              label="Max per inbox / day"
              value={s.maxDailyCap}
              min={1}
              max={ABSOLUTE_MAX_DAILY_CAP}
              integer
              onChange={(v) => update({ maxDailyCap: v ?? ABSOLUTE_MAX_DAILY_CAP })}
              hint={`Hard ceiling ${ABSOLUTE_MAX_DAILY_CAP}.`}
            />
            <SelectField
              label="Window starts"
              value={s.startHour}
              options={HOURS.slice(0, 24).map((h) => ({ value: h, label: fmtHour(h) }))}
              onChange={(v) => update({ startHour: v, endHour: Math.max(s.endHour, v + 1) })}
            />
            <SelectField
              label="Window ends"
              value={s.endHour}
              options={HOURS.slice(1).filter((h) => h > s.startHour).map((h) => ({ value: h, label: fmtHour(h) }))}
              onChange={(v) => update({ endHour: v })}
            />
          </div>
          <CheckField label="Weekdays only" checked={s.weekdaysOnly} onChange={(v) => update({ weekdaysOnly: v })} />
          <div className="grid grid-cols-2 gap-3">
            <NumField
              label="Domain cap / day"
              value={s.domainDailyCap}
              nullable
              placeholder="none"
              min={1}
              max={1000}
              integer
              onChange={(v) => update({ domainDailyCap: v })}
            />
            <NumField
              label="Reply window"
              suffix="days"
              value={s.drainDays}
              min={0}
              max={365}
              integer
              onChange={(v) => update({ drainDays: v ?? 0 })}
              hint="Inboxes stay paid after the last email."
            />
          </div>
          <NumField
            label="Other campaigns' emails / day"
            value={s.otherSendsPerDay}
            min={0}
            max={100_000}
            integer
            onChange={(v) => update({ otherSendsPerDay: v ?? 0 })}
            hint={`They share the sender's budget of ${SENDS_PER_TICK} emails every ${NATIVE_TICK_MINUTES} minutes.`}
          />
          <CheckField
            label="Inboxes are already warmed"
            checked={s.startWarmed}
            onChange={(v) => update({ startWarmed: v })}
            hint="Reusing inboxes from an earlier campaign. Leave off for new ones, or ones back from a rest."
          />
        </div>
      </details>
    </div>
  );
}

// ── Results ────────────────────────────────────────────────────────────────

function CampaignResults({ state, update, history }: { state: PlannerState; update: Update; history: ReplyHistory | null }) {
  const s = useDebounced(state, 200);
  const input = useMemo(() => simInputFor(s), [s]);
  const inputKey = JSON.stringify(input);
  const sim = useMemo(() => simulateCampaign(input), [input]);
  const advice = useMemo(() => whatIf(input, sim), [input, sim]);
  const replyRate = s.replyRatePct ?? history?.replyRatePct ?? null;
  const positiveRate = s.positiveRatePct ?? history?.positiveRatePct ?? null;
  const econ = useMemo(
    () =>
      campaignEconomics(
        sim,
        {
          startDate: s.startDate,
          contactsMode: s.contactsMode,
          listSize: s.listSize,
          sendablePct: s.sendablePct,
          sourcingUsdPerContact: s.sourcingUsd,
          seatUsdPerMonth: s.seatUsd,
          domainUsdPerYear: s.domainUsd,
          domainBasis: s.domainBasis,
          drainDays: s.drainDays,
          otherMonthlyUsd: s.otherMonthlyUsd,
        },
        {
          monthlyRetainerUsd: s.retainerUsd,
          setupFeeUsd: s.setupUsd,
          sourcingPriceUsdPerContact: s.sourcingPriceUsd,
          monthlyChargesOverride: s.chargesOverride,
          paymentFeePct: s.feePct,
          paymentFeeFixedUsd: s.feeFixedUsd,
        },
        { replyRatePct: replyRate, positiveRatePct: positiveRate },
      ),
    [sim, s, replyRate, positiveRate],
  );

  const [sweep, setSweep] = useState<{ key: string; rows: CapSweepRow[] } | null>(null);
  const [solve, setSolve] = useState<{ key: string; result: DomainSolve } | null>(null);
  // The solver and the cap comparison re-run the engine many times: paint a
  // "Working" state first, then compute on the next task.
  const [busy, setBusy] = useState<"solve" | "sweep" | null>(null);
  const runLater = (which: "solve" | "sweep", fn: () => void) => {
    setBusy(which);
    setTimeout(() => {
      fn();
      setBusy(null);
    }, 20);
  };
  const finishTarget = state.finishBy ?? sim.lastSendDate ?? s.startDate;
  const projected = sim.status === "projected";
  const hasPrice = econ.totalRevenue > 0;
  const weeks = sim.lastSendDate ? Math.max(1, Math.round((sim.days.length || 1) / 7)) : null;

  return (
    <div className="@container min-w-0 space-y-4">
      {!projected && (
        <Callout tone={sim.status === "paused" ? "warn" : "danger"} icon={<AlertTriangle size={16} />}>
          <p>{sim.reason}</p>
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatCard label="First email" value={formatCivilDate(sim.launchDate, { year: false })} icon={<Rocket size={16} className="text-primary" />} />
        <StatCard
          label={weeks ? `Last email (${weeks} wk)` : "Last email"}
          value={sim.lastSendDate ? formatCivilDate(sim.lastSendDate, { year: false }) : "-"}
          icon={<CalendarCheck size={16} className="text-primary" />}
        />
        <StatCard label="Our total cost" value={formatUsd(econ.totalCost)} icon={<Wallet size={16} className="text-primary" />} />
        <StatCard
          label={hasPrice && econ.marginPct != null ? `Margin (${formatPct(econ.marginPct, 0)})` : "Margin"}
          value={hasPrice ? formatUsd(econ.margin) : "Add a price"}
          tone={!hasPrice ? "default" : econ.margin < 0 ? "danger" : "success"}
          icon={<TrendingUp size={16} className={!hasPrice ? "text-primary" : econ.margin < 0 ? "text-red-600" : "text-emerald-600"} />}
        />
      </div>

      {projected && advice && (
        <Callout tone={advice.limit === "new_leads_cap" ? "warn" : "info"} icon={<Info size={16} />}>
          <p>{adviceText(advice, sim, s.newLeadsCap)}</p>
          <p className="text-xs opacity-80">
            {formatInt(sim.totalSends)} emails over {formatInt(sim.sendDays)} sending days · busiest day {formatInt(sim.peakDailySends)} ·
            inboxes {formatPct(sim.capacityUsedPct, 0)} used · {sim.rampDoneDate ? `fully warmed ${formatCivilDate(sim.rampDoneDate, { year: false })}` : "never fully warmed (not enough volume)"} ·
            every contact emailed by {formatCivilDate(sim.firstTouchesDoneDate, { year: false })}
          </p>
        </Callout>
      )}

      {projected && sim.days.length > 0 && (
        <Section title="Emails per sending day" icon={<CalendarClock size={14} />}>
          <Legend keys={["first", "follow", "capacity"]} />
          <SendsChart days={sim.days} />
        </Section>
      )}

      {projected && (
        <Section title="What would finish sooner" icon={<TrendingUp size={14} />}>
          <div className="grid gap-4 @2xl:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Finish by a date: the fewest domains</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[10rem] flex-1">
                  <DateField label="Last email by" value={finishTarget} onChange={(v) => update({ finishBy: v })} />
                </div>
                <Button
                  variant="outline"
                  className="h-9"
                  disabled={busy != null}
                  onClick={() =>
                    runLater("solve", () => setSolve({ key: inputKey + finishTarget, result: solveDomains(input, finishTarget) }))
                  }
                >
                  {busy === "solve" ? "Working…" : "Find domains"}
                </Button>
              </div>
              {solve && solve.key === inputKey + finishTarget && (
                solve.result.domains != null ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span>
                      <b>{solve.result.domains}</b> domain{solve.result.domains === 1 ? "" : "s"} ({solve.result.domains * s.inboxesPerDomain} inboxes):
                      last email {formatCivilDate(solve.result.result?.lastSendDate, { weekday: true, year: false })}.
                    </span>
                    {solve.result.domains !== s.domains && (
                      <Button size="sm" variant="outline" onClick={() => update({ domains: solve.result.domains ?? s.domains })}>
                        Use {solve.result.domains}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Hint className="text-sm text-amber-700">{solve.result.reason}</Hint>
                )
              )}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Same inboxes, different new-leads cap</p>
              {sweep && sweep.key === inputKey ? (
                <Table>
                  <TableBody>
                    {sweep.rows.map((r) => (
                      <TableRow key={r.label}>
                        <TableCell className="py-1.5 text-xs">{r.label}</TableCell>
                        <TableCell className="py-1.5 text-right text-xs tabular-nums">
                          {r.status === "projected" ? formatCivilDate(r.lastSendDate, { year: false }) : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Button
                  variant="outline"
                  className="h-9"
                  disabled={busy != null}
                  onClick={() => runLater("sweep", () => setSweep({ key: inputKey, rows: capSweep(input) }))}
                >
                  {busy === "sweep" ? "Working…" : "Compare caps"}
                </Button>
              )}
            </div>
          </div>
        </Section>
      )}

      {projected && (
        <div className="grid gap-4 @3xl:grid-cols-2">
          <LineItems title="What it costs us" items={econ.costs} total={econ.totalCost} />
          <LineItems title="What the client pays" items={econ.revenue} total={econ.totalRevenue} />
        </div>
      )}

      {projected && (
        <Section title="Bottom line" icon={<HandCoins size={14} />}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm @xl:grid-cols-3">
            <Metric label="Margin" value={hasPrice ? `${formatUsd(econ.margin)}${econ.marginPct != null ? ` (${formatPct(econ.marginPct, 1)})` : ""}` : "-"} />
            <Metric label="Margin per monthly charge" value={hasPrice && econ.marginPerMonth != null ? formatUsd(econ.marginPerMonth) : "-"} />
            <Metric
              label="Breakeven retainer"
              value={
                econ.breakevenMonthly == null
                  ? "-"
                  : econ.breakevenMonthly === 0 && s.setupUsd + s.listSize * s.sourcingPriceUsd > 0
                    ? "$0 (signing fees cover it)"
                    : `${formatUsd(econ.breakevenMonthly)}/mo`
              }
            />
            <Metric label="Our cost per contact" value={econ.costPerContact != null ? formatUsd(econ.costPerContact, { cents: true }) : "-"} />
            <Metric label="Our cost per email" value={econ.costPerEmail != null ? formatUsd(econ.costPerEmail, { precise: true }) : "-"} />
            <Metric label="Inboxes paid for" value={`${formatNumber(econ.seatMonths, 1)} months`} />
          </dl>
          {econ.outcomes && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t pt-3 text-sm @xl:grid-cols-4">
              <Metric label="Replies" value={formatNumber(econ.outcomes.replies, 0)} />
              <Metric label="Positive replies" value={econ.outcomes.positives != null ? formatNumber(econ.outcomes.positives, 1) : "-"} />
              <Metric label="Our cost per positive" value={econ.outcomes.costPerPositive != null ? formatUsd(econ.outcomes.costPerPositive) : "-"} />
              <Metric label="Client pays per positive" value={hasPrice && econ.outcomes.pricePerPositive != null ? formatUsd(econ.outcomes.pricePerPositive) : "-"} />
            </div>
          )}
          <Hint>
            Assumes every contact gets every email, so emails and timing are the upper bound (replies and bounces end some
            sequences early). Follows the live sending rules: the warm-up ramp, {s.maxDailyCap}/day per inbox, the send window,
            the new-leads cap and the sender&apos;s {NATIVE_TICK_MINUTES}-minute rhythm. Not modeled: verification holds and
            daylight-saving shifts.
          </Hint>
        </Section>
      )}
    </div>
  );
}

// Plain-language advice from whatIf(): what actually moves the last email.
function adviceText(a: WhatIf, sim: SimResult, cap: number): string {
  const day = (d: string | null) => formatCivilDate(d, { weekday: true, year: false });
  const now = day(sim.lastSendDate);
  const md = `${a.moreDomains.domains} domains`;
  if (a.limit === "both" && a.higherCap) {
    return (
      `Both limits bind: inboxes and the new-leads cap. On ${md} the last email goes out ${day(a.moreDomains.lastSendDate)}; ` +
      `at ${a.higherCap.newLeadsCap} new contacts a day, ${day(a.higherCap.lastSendDate)} (now ${now}). Raise both to go faster still.`
    );
  }
  if (a.limit === "new_leads_cap" && a.higherCap) {
    return (
      `The new-leads cap (${cap}/day) is the limit, not inboxes: ${md} would still finish ${day(a.moreDomains.lastSendDate)}. ` +
      `At ${a.higherCap.newLeadsCap} a day the last email goes out ${day(a.higherCap.lastSendDate)}. Raise it in the campaign's Setup.`
    );
  }
  if (a.limit === "capacity") {
    return (
      `Inbox capacity is the limit. On ${md} the last email goes out ${day(a.moreDomains.lastSendDate)} instead of ${now}` +
      `${a.higherCap ? "; raising the new-leads cap alone wouldn't move it" : ""}.`
    );
  }
  const tail = sim.firstTouchesDoneDate && sim.lastSendDate ? daysBetween(sim.firstTouchesDoneDate, sim.lastSendDate) : 0;
  return (
    `Neither more domains nor a higher cap moves the finish. Every contact is emailed by ${day(sim.firstTouchesDoneDate)}; ` +
    `the last ${tail} days are the gaps between emails, so only a shorter sequence finishes sooner.`
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function LineItems({ title, items, total }: { title: string; items: LineItem[]; total: number }) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-sm font-semibold">{title}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={it.key}>
              <TableCell className="whitespace-normal py-2">
                <p className="text-sm">{it.label}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">{it.formula}</p>
              </TableCell>
              <TableCell className="py-2 text-right align-top tabular-nums">{formatUsd(it.amount, { cents: true })}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="py-2 font-semibold">Total</TableCell>
            <TableCell className="py-2 text-right font-semibold tabular-nums">{formatUsd(total, { cents: true })}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
