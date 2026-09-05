// Registrar automation: provider-agnostic contract (Phase 2).
//
// Both Porkbun and Spaceship expose full buy + DNS APIs; this interface is what
// the app codes against so a caller can buy a domain and write its DNS without
// caring which registrar fulfilled it (owner decision 2026-08-26: build both,
// buy where cheaper). The concrete clients (porkbun.ts / spaceship.ts) implement
// RegistrarProvider; the pure helpers (spend.ts / names.ts / dns.ts) have no I/O.

export type RegistrarId = "porkbun" | "spaceship";

export type DnsRecordType = "A" | "AAAA" | "MX" | "TXT" | "CNAME";

export interface DnsRecordInput {
  type: DnsRecordType;
  /** Subdomain, or "" for the apex/root. */
  name: string;
  /** The record value (IP, hostname, TXT string, …). */
  content: string;
  /** Seconds; providers apply their own default when omitted. */
  ttl?: number;
  /** MX/SRV priority. */
  priority?: number;
}

export interface DomainAvailability {
  domain: string;
  available: boolean;
  /** First-year registration price in USD, when the provider returns it. */
  priceUsd: number | null;
}

export interface RegisterResult {
  domain: string;
  registrar: RegistrarId;
  priceUsd: number;
}

// ── URL forwarding (redirects) ──────────────────────────────────────────────
// A sending domain's bare hostname usually 301-redirects to the client's real
// site (a dead parked page on a lookalike domain hurts legitimacy). Porkbun
// exposes this over its API; Spaceship does NOT (dashboard-only), so its client
// throws ManualForwardingRequiredError and callers gate on supportsUrlForwarding.

/** permanent = 301, temporary = 302. We default to permanent. */
export type UrlForwardType = "permanent" | "temporary";

/** A desired forward: provider-agnostic; the client maps it to its own shape. */
export interface UrlForwardInput {
  /** Subdomain to forward, or "" for the apex/root. */
  subdomain: string;
  /** Absolute destination URL (scheme included, e.g. https://acme.com). */
  location: string;
  type: UrlForwardType;
  /** Append the incoming path to the destination (yes) or always land on it (no). */
  includePath: boolean;
  /** Also forward every subdomain under `subdomain`. */
  wildcard: boolean;
}

/** A forward read back from a registrar, carrying its provider-side id. */
export interface UrlForward extends UrlForwardInput {
  /** The registrar's own forward id, used to delete/replace it. */
  providerId?: string;
}

/** The contract each registrar client implements. */
export interface RegistrarProvider {
  id: RegistrarId;
  /** True when this registrar can set URL forwarding via its API (Porkbun yes,
   *  Spaceship no). Callers check this before touching the forward methods. */
  readonly supportsUrlForwarding: boolean;
  checkAvailability(domain: string): Promise<DomainAvailability>;
  registerDomain(domain: string): Promise<RegisterResult>;
  upsertDnsRecords(domain: string, records: DnsRecordInput[]): Promise<void>;
  getDnsRecords(domain: string): Promise<DnsRecordInput[]>;
  /** Read the domain's current URL forwards. Throws ManualForwardingRequiredError
   *  on registrars without API forwarding. */
  getUrlForwards(domain: string): Promise<UrlForward[]>;
  /** Idempotently make the domain's forwards match `forwards` (create/replace the
   *  managed subdomains, leave others alone). Throws ManualForwardingRequiredError
   *  on registrars without API forwarding. */
  setUrlForwards(domain: string, forwards: UrlForwardInput[]): Promise<void>;
}

/** Per-registrar credentials, read from the organizations row (migration 00084). */
export interface RegistrarCredentials {
  porkbun?: { apiKey: string; secretApiKey: string } | null;
  spaceship?: { apiKey: string; apiSecret: string } | null;
}
