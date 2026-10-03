"use client";

// Campaign Planner: plan a campaign's cost, runway, margin and replies before
// buying anything (Campaign tab), or see what a monthly budget buys (Budget
// tab). Everything runs in the browser on the live sending rules; the plan
// lives in the URL, so a plan is a link you can bookmark or send.

import { useEffect, useMemo, useState } from "react";
import { Check, Link2, Mail, RotateCcw, Wallet } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { UnderlineTab } from "@/components/ui/underline-tab";
import {
  parsePlannerState,
  plannerDefaults,
  serializePlannerState,
  type PlannerState,
  type PlannerTab,
  type RawParams,
} from "./planner-state";
import { CampaignTab } from "./campaign-tab";
import { BudgetTab } from "./budget-tab";

/** The org's reply history, used as the default reply rates (from campaign_snapshots). */
export interface ReplyHistory {
  /** Repliers ÷ contacts emailed, in %. */
  replyRatePct: number;
  /** Positive replies ÷ replies, in %. */
  positiveRatePct: number;
  contacted: number;
  replies: number;
  positives: number;
  campaigns: number;
}

export function Planner({
  initialParams,
  today,
  history,
}: {
  initialParams: RawParams;
  today: string;
  history: ReplyHistory | null;
}) {
  const defaults = useMemo(() => plannerDefaults(today), [today]);
  const [state, setState] = useState<PlannerState>(() => parsePlannerState(initialParams, defaults));
  const [copied, setCopied] = useState(false);
  const update = (patch: Partial<PlannerState>) => setState((prev) => ({ ...prev, ...patch }));

  // Mirror the plan into the URL. window.history.replaceState keeps the /app
  // basePath (a relative "?…" URL) and, unlike router.replace, doesn't send the
  // page back to the server on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      const qs = serializePlannerState(state, defaults);
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    }, 250);
    return () => clearTimeout(t);
  }, [state, defaults]);

  const copyLink = async () => {
    const qs = serializePlannerState(state, defaults);
    const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ""}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (permissions / insecure context): the address bar has the same link.
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Planner"
        actions={
          <>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setState({ ...defaults, tab: state.tab, budgetView: state.budgetView })}>
              <RotateCcw size={14} /> Reset
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={copyLink}>
              {copied ? <Check size={14} /> : <Link2 size={14} />}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </>
        }
      />
      <Tabs value={state.tab} onValueChange={(v) => update({ tab: v as PlannerTab })} className="gap-4">
        <TabsList variant="line" className="h-auto w-full justify-start gap-6 rounded-none border-b border-border p-0">
          <UnderlineTab value="campaign" icon={<Mail size={15} />} label="Campaign" />
          <UnderlineTab value="budget" icon={<Wallet size={15} />} label="Budget" />
        </TabsList>
        <TabsContent value="campaign">
          <CampaignTab state={state} update={update} history={history} />
        </TabsContent>
        <TabsContent value="budget">
          <BudgetTab state={state} update={update} history={history} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
