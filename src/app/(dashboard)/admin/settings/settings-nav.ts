import {
  Building2,
  CheckSquare,
  Coins,
  CreditCard,
  Inbox,
  Key,
  Store,
  Tags,
  Workflow,
  type LucideIcon,
} from "lucide-react";

// Single source of truth for the Settings hub. /admin/settings renders these
// as grouped cards, and the settings layout reads the same list to title each
// sub-page (so a section's name is written once, not per route file).

export type SettingsEntry = {
  href: string;
  title: string;
  /** Plain-language "what this affects" line, shown under the card title. */
  description: string;
  icon: LucideIcon;
  /**
   * True when the destination lives outside /admin/settings. These are
   * cross-links surfaced on the hub for discoverability; they keep their own
   * page chrome and never drive the settings sub-page header.
   */
  external?: boolean;
};

export type SettingsGroup = {
  /** Grouped by what the section affects, not by which team built it. */
  label: string;
  entries: SettingsEntry[];
};

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Your business",
    entries: [
      {
        href: "/admin/settings/billing",
        title: "Billing",
        description: "Client plans, quotes, subscriptions and invoices.",
        icon: CreditCard,
      },
      {
        href: "/admin/settings/tokens",
        title: "Tokens",
        description:
          "Pricing, spend caps and the packs buyers purchase for self-serve contact sourcing.",
        icon: Coins,
      },
      {
        href: "/admin/settings/buyer-experience",
        title: "Buyer experience",
        description: "The copy and layout self-serve buyers see in their portal.",
        icon: Store,
      },
    ],
  },
  {
    label: "How you work",
    entries: [
      {
        href: "/admin/settings/workflows",
        title: "Workflows",
        description:
          "Your outbound pipeline map, and a live preview of what a new client is sent.",
        icon: Workflow,
      },
      {
        href: "/admin/settings/tags",
        title: "Tags",
        description: "Labels for grouping the mailboxes you send from.",
        icon: Tags,
      },
      {
        href: "/admin/settings/tasks",
        title: "Tasks",
        description: "The internal to-do list for you and your VAs.",
        icon: CheckSquare,
      },
    ],
  },
  {
    label: "People & access",
    entries: [
      {
        href: "/admin/settings/team",
        title: "Team",
        description: "Who can log in, and whether each person is an Admin or a VA.",
        icon: Building2,
      },
    ],
  },
  {
    label: "Connections",
    entries: [
      {
        href: "/admin/settings/api",
        title: "Integrations",
        description: "API keys for sending, enrichment, AI and payments.",
        icon: Key,
      },
      {
        href: "/admin/mailboxes",
        title: "Mailboxes",
        description: "The inboxes the app sends from, plus their domains and health.",
        icon: Inbox,
        external: true,
      },
    ],
  },
];

/** Every hub entry that is itself a /admin/settings/* route. */
const SETTINGS_ROUTES = SETTINGS_GROUPS.flatMap((group) =>
  group.entries.filter((entry) => !entry.external)
);

/**
 * The settings section a pathname belongs to, or undefined on the hub itself.
 * Longest href wins so a nested route still resolves to its section.
 */
export function settingsEntryForPath(pathname: string): SettingsEntry | undefined {
  return SETTINGS_ROUTES.filter(
    (entry) => pathname === entry.href || pathname.startsWith(entry.href + "/")
  ).sort((a, b) => b.href.length - a.href.length)[0];
}
