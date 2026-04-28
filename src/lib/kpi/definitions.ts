import type { KPIHealth } from "@/types/app";

// No open rate or click rate — tracking pixels hurt deliverability

export interface KPIDefinition {
  key: string;
  label: string;
  description: string;
  unit: "percent" | "count" | "trend";
  thresholds: {
    good: number;
    warning: number;
    // Values worse than warning are "bad"
  };
  higherIsBetter: boolean;
}

export const KPI_DEFINITIONS: KPIDefinition[] = [
  {
    key: "reply_rate",
    label: "Reply Rate",
    description: "Percentage of unique leads contacted who replied",
    unit: "percent",
    thresholds: { good: 10, warning: 5 },
    higherIsBetter: true,
  },
  {
    key: "positive_reply_rate",
    label: "Positive Reply Rate",
    description: "Percentage of replies that are positive/interested",
    unit: "percent",
    thresholds: { good: 40, warning: 20 },
    higherIsBetter: true,
  },
  {
    key: "bounce_rate",
    label: "Bounce Rate",
    description: "Percentage of emails that bounced",
    unit: "percent",
    thresholds: { good: 2, warning: 5 },
    higherIsBetter: false,
  },
  {
    key: "unsubscribe_rate",
    label: "Unsubscribe Rate",
    description: "Percentage of leads that unsubscribed",
    unit: "percent",
    thresholds: { good: 0.5, warning: 1 },
    higherIsBetter: false,
  },
  {
    key: "meetings_booked",
    label: "Meetings Booked",
    description: "Total meetings booked from campaigns",
    unit: "count",
    thresholds: { good: 1, warning: 0 },
    higherIsBetter: true,
  },
  {
    key: "positive_lead_rate",
    label: "Positive Lead Rate",
    description: "Percentage of client feedback marking leads as good",
    unit: "percent",
    thresholds: { good: 60, warning: 40 },
    higherIsBetter: true,
  },
  {
    key: "reply_to_meeting_rate",
    label: "Reply-to-Meeting Rate",
    description: "Percentage of replies that convert to meetings",
    unit: "percent",
    thresholds: { good: 20, warning: 10 },
    higherIsBetter: true,
  },
  {
    key: "emails_sent_per_day",
    label: "Emails Sent/Day",
    description: "Average emails sent per day",
    unit: "count",
    thresholds: { good: 50, warning: 25 },
    higherIsBetter: true,
  },
];

export function getKPIHealth(
  definition: KPIDefinition,
  value: number
): KPIHealth {
  if (definition.higherIsBetter) {
    if (value >= definition.thresholds.good) return "good";
    if (value >= definition.thresholds.warning) return "warning";
    return "bad";
  } else {
    if (value <= definition.thresholds.good) return "good";
    if (value <= definition.thresholds.warning) return "warning";
    return "bad";
  }
}

export function getHealthColor(health: KPIHealth): string {
  switch (health) {
    case "good":
      return "text-emerald-700";
    case "warning":
      return "text-amber-700";
    case "bad":
      return "text-red-700";
  }
}

export function getHealthBgColor(health: KPIHealth): string {
  switch (health) {
    case "good":
      return "badge-green";
    case "warning":
      return "badge-amber";
    case "bad":
      return "badge-red";
  }
}
