// Porkbun registrar client (Phase 2). Base https://api.porkbun.com/api/json/v3.
// Every call is POST with {apikey, secretapikey} in the JSON body (Porkbun's
// convention: including "retrieve"). DNS + availability are well-established;
// registerDomain is implemented to the documented shape but is PENDING LIVE
// VERIFICATION with a real key (Porkbun registration-via-API params/contacts
// need confirming): it throws clearly if the endpoint rejects it.

import type {
  DnsRecordInput,
  DomainAvailability,
  RegisterResult,
  RegistrarProvider,
  UrlForward,
  UrlForwardInput,
} from "./types";
import { diffDnsRecords, type DnsCurrentRecord } from "./dns";
import { diffForwards } from "./forwarding";

const BASE = "https://api.porkbun.com/api/json/v3";

export class PorkbunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PorkbunError";
  }
}

interface PorkbunEnvelope {
  status?: string;
  message?: string;
  [k: string]: unknown;
}

// ── Record mapping (pure; exported for tests) ───────────────────────────────
// Porkbun uses a single "content" value field for every record type and a
// subdomain-only "name" (blank for the apex), which matches DnsRecordInput.

export function toPorkbunRecord(rec: DnsRecordInput): Record<string, string> {
  const out: Record<string, string> = {
    name: rec.name, // "" = apex
    type: rec.type,
    content: rec.content,
    ttl: String(rec.ttl ?? 3600),
  };
  if (rec.priority != null) out.prio = String(rec.priority);
  return out;
}

export function fromPorkbunRecord(
  r: { name?: string; type?: string; content?: string; ttl?: string | number; prio?: string | number },
  domain: string,
): DnsRecordInput {
  // Retrieve returns the full host in "name"; reduce to the subdomain.
  const host = (r.name ?? "").toLowerCase();
  const name = host === domain.toLowerCase() ? "" : host.replace(new RegExp(`\\.?${escapeRegExp(domain)}$`, "i"), "");
  return {
    type: (r.type ?? "TXT") as DnsRecordInput["type"],
    name,
    content: r.content ?? "",
    ttl: r.ttl != null ? Number(r.ttl) : undefined,
    priority: r.prio != null && r.prio !== "" ? Number(r.prio) : undefined,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── URL-forward mapping (pure; exported for tests) ──────────────────────────
// Porkbun's addUrlForward takes a subdomain-only "subdomain" (blank = apex), a
// destination "location", a "type" of permanent/temporary (301/302), and
// yes/no "includePath" + "wildcard". getUrlForwarding returns the same plus an
// "id" used to delete a forward (there is no edit endpoint).

export function toPorkbunForward(f: UrlForwardInput): Record<string, string> {
  return {
    subdomain: f.subdomain, // "" = apex
    location: f.location,
    type: f.type, // permanent | temporary
    includePath: f.includePath ? "yes" : "no",
    wildcard: f.wildcard ? "yes" : "no",
  };
}

export function fromPorkbunForward(r: {
  id?: string | number;
  subdomain?: string;
  location?: string;
  type?: string;
  includePath?: string;
  wildcard?: string;
}): UrlForward {
  return {
    subdomain: r.subdomain ?? "",
    location: r.location ?? "",
    type: r.type === "temporary" ? "temporary" : "permanent",
    includePath: String(r.includePath ?? "").toLowerCase() === "yes",
    wildcard: String(r.wildcard ?? "").toLowerCase() === "yes",
    providerId: r.id != null ? String(r.id) : undefined,
  };
}

// ── Provider ────────────────────────────────────────────────────────────────

export function createPorkbunProvider(creds: { apiKey: string; secretApiKey: string }): RegistrarProvider {
  const auth = { apikey: creds.apiKey, secretapikey: creds.secretApiKey };

  async function post(path: string, body: Record<string, unknown> = {}): Promise<PorkbunEnvelope> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...auth, ...body }),
      });
    } catch (err) {
      throw new PorkbunError(`Network error calling Porkbun ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const json = (await res.json().catch(() => ({}))) as PorkbunEnvelope;
    if (!res.ok || json.status !== "SUCCESS") {
      throw new PorkbunError(json.message || `Porkbun ${path} failed (HTTP ${res.status}).`);
    }
    return json;
  }

  return {
    id: "porkbun",
    supportsUrlForwarding: true,

    async checkAvailability(domain: string): Promise<DomainAvailability> {
      const json = await post(`/domain/checkDomain/${encodeURIComponent(domain)}`);
      const r = (json.response ?? {}) as { avail?: string; price?: string | number };
      const price = r.price != null ? Number(r.price) : NaN;
      return { domain, available: r.avail === "yes", priceUsd: Number.isFinite(price) ? price : null };
    },

    async registerDomain(domain: string): Promise<RegisterResult> {
      // PENDING LIVE VERIFICATION (see file header). Porkbun uses the account's
      // default contacts; we send domain + 1 year.
      const json = await post(`/domain/register`, { domain, years: "1" });
      const price = (json.response as { price?: string | number } | undefined)?.price;
      const n = price != null ? Number(price) : NaN;
      return { domain, registrar: "porkbun", priceUsd: Number.isFinite(n) ? n : 0 };
    },

    async upsertDnsRecords(domain: string, records: DnsRecordInput[]): Promise<void> {
      // True upsert: read the live records (with Porkbun's ids), diff under the
      // TXT-slot / exclusive-group rules, then create/edit/delete only what
      // changed. Idempotent: re-running writes nothing when already in sync,
      // and it never duplicates or clobbers unrelated records.
      const current = await retrieveCurrent(domain);
      const diff = diffDnsRecords(current, records);
      for (const rec of diff.create) {
        await post(`/dns/create/${encodeURIComponent(domain)}`, toPorkbunRecord(rec));
      }
      for (const { current: cur, desired } of diff.edit) {
        if (!cur.providerId) {
          // No id to target (shouldn't happen via retrieveCurrent): create it.
          await post(`/dns/create/${encodeURIComponent(domain)}`, toPorkbunRecord(desired));
          continue;
        }
        await post(
          `/dns/edit/${encodeURIComponent(domain)}/${encodeURIComponent(cur.providerId)}`,
          toPorkbunRecord(desired),
        );
      }
      for (const cur of diff.del) {
        if (cur.providerId) {
          await post(`/dns/delete/${encodeURIComponent(domain)}/${encodeURIComponent(cur.providerId)}`);
        }
      }
    },

    async getDnsRecords(domain: string): Promise<DnsRecordInput[]> {
      return retrieveCurrent(domain);
    },

    async getUrlForwards(domain: string): Promise<UrlForward[]> {
      return retrieveForwards(domain);
    },

    async setUrlForwards(domain: string, forwards: UrlForwardInput[]): Promise<void> {
      // Idempotent upsert by subdomain slot. Porkbun has no edit endpoint, so a
      // changed forward is a delete + add; forwards on subdomains we don't manage
      // are left untouched (diffForwards enforces both rules).
      const current = await retrieveForwards(domain);
      const diff = diffForwards(current, forwards);
      for (const f of diff.del) {
        if (f.providerId) {
          await post(`/domain/deleteUrlForward/${encodeURIComponent(domain)}/${encodeURIComponent(f.providerId)}`);
        }
      }
      for (const f of diff.add) {
        await post(`/domain/addUrlForward/${encodeURIComponent(domain)}`, toPorkbunForward(f));
      }
    },
  };

  /** Retrieve the live URL forwards, keeping each forward's Porkbun id. */
  async function retrieveForwards(domain: string): Promise<UrlForward[]> {
    const json = await post(`/domain/getUrlForwarding/${encodeURIComponent(domain)}`);
    const forwards = (json.forwards ?? []) as Parameters<typeof fromPorkbunForward>[0][];
    return forwards.map(fromPorkbunForward);
  }

  /** Retrieve the live records, keeping each record's Porkbun id for edit/delete. */
  async function retrieveCurrent(domain: string): Promise<DnsCurrentRecord[]> {
    const json = await post(`/dns/retrieve/${encodeURIComponent(domain)}`);
    const records = (json.records ?? []) as (Parameters<
      typeof fromPorkbunRecord
    >[0] & { id?: string | number })[];
    return records.map((r) => ({
      ...fromPorkbunRecord(r, domain),
      providerId: r.id != null ? String(r.id) : undefined,
    }));
  }
}
