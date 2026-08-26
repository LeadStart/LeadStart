// Registrar automation — provider-agnostic contract (Phase 2).
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

/** The contract each registrar client implements. */
export interface RegistrarProvider {
  id: RegistrarId;
  checkAvailability(domain: string): Promise<DomainAvailability>;
  registerDomain(domain: string): Promise<RegisterResult>;
  upsertDnsRecords(domain: string, records: DnsRecordInput[]): Promise<void>;
  getDnsRecords(domain: string): Promise<DnsRecordInput[]>;
}

/** Per-registrar credentials, read from the organizations row (migration 00084). */
export interface RegistrarCredentials {
  porkbun?: { apiKey: string; secretApiKey: string } | null;
  spaceship?: { apiKey: string; apiSecret: string } | null;
}
