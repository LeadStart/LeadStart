// Warmforge.ai API types.
//
// Warmforge is Salesforge's mailbox-warming sister product. Mailboxes
// auto-sync from Salesforge (one connect step at the user level), so
// the only credential we need is the Warmforge API key — there's no
// per-mailbox connect flow on this surface.
//
// The published OpenAPI spec is sparse; the types below cover the
// fields the Inbox Health page reads. The first cascade test against a
// real Warmforge account will refute or confirm field names; tighten then.

export interface WarmforgeMailbox {
  email: string;

  // Primary deliverability metric (0-100). Warmforge's "heat score" is
  // their direct equivalent of Instantly's stat_warmup_score.
  heat_score?: number;
  heat_label?: string;

  // DNS verification statuses. String permissively typed because the
  // spec uses different vocabularies across endpoints
  // (e.g. "valid" / "invalid" / "missing" / "pending").
  dkim?: string;
  spf?: string;
  dmarc?: string;
  mx?: string;

  // Blacklist detection.
  blacklisted?: boolean;
  blacklists?: string[];

  // Daily warmup stats — usually a 7- or 30-day rolling window.
  warmup_enabled?: boolean;
  warmup_daily_target?: number;
  warmup_landed_inbox?: number;
  warmup_landed_spam?: number;
  warmup_received?: number;
  warmup_sent?: number;
}

export interface WarmforgeMailboxList {
  items?: WarmforgeMailbox[];
  page?: number;
  page_size?: number;
  total?: number;
}
