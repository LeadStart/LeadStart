// Spaceship registrar client (Phase 2). Base https://spaceship.dev/api/v1.
// Auth via X-Api-Key + X-Api-Secret headers. Availability + DNS are
// well-established; registerDomain is to the documented shape but PENDING LIVE
// VERIFICATION (registration needs pre-created contact IDs and returns 202 +
// async op) — it throws clearly if the API rejects it.

import type {
  DnsRecordInput,
  DnsRecordType,
  DomainAvailability,
  RegisterResult,
  RegistrarProvider,
} from "./types";

const BASE = "https://spaceship.dev/api/v1";

export class SpaceshipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceshipError";
  }
}

// ── Record mapping (pure; exported for tests) ───────────────────────────────
// Spaceship uses a per-type value field (A/AAAA→address, CNAME→cname,
// MX→exchange+preference, TXT→value) and "@" for the apex name.

export function toSpaceshipRecord(rec: DnsRecordInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: rec.type,
    name: rec.name === "" ? "@" : rec.name,
    ttl: rec.ttl ?? 3600,
  };
  switch (rec.type) {
    case "A":
    case "AAAA":
      base.address = rec.content;
      break;
    case "CNAME":
      base.cname = rec.content;
      break;
    case "MX":
      base.exchange = rec.content;
      base.preference = rec.priority ?? 10;
      break;
    case "TXT":
      base.value = rec.content;
      break;
  }
  return base;
}

export function fromSpaceshipRecord(item: {
  type?: string;
  name?: string;
  ttl?: number;
  address?: string;
  cname?: string;
  exchange?: string;
  preference?: number;
  value?: string;
}): DnsRecordInput {
  const type = (item.type ?? "TXT") as DnsRecordType;
  const content =
    type === "A" || type === "AAAA"
      ? item.address ?? ""
      : type === "CNAME"
        ? item.cname ?? ""
        : type === "MX"
          ? item.exchange ?? ""
          : item.value ?? "";
  return {
    type,
    name: item.name === "@" ? "" : item.name ?? "",
    content,
    ttl: item.ttl,
    priority: type === "MX" ? item.preference : undefined,
  };
}

// ── Provider ────────────────────────────────────────────────────────────────

export function createSpaceshipProvider(creds: { apiKey: string; apiSecret: string }): RegistrarProvider {
  const headers = {
    "X-Api-Key": creds.apiKey,
    "X-Api-Secret": creds.apiSecret,
    "Content-Type": "application/json",
  };

  async function req(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new SpaceshipError(`Network error calling Spaceship ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SpaceshipError(`Spaceship ${method} ${path} failed (HTTP ${res.status}). ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  return {
    id: "spaceship",

    async checkAvailability(domain: string): Promise<DomainAvailability> {
      const json = (await req("GET", `/domains/${encodeURIComponent(domain)}/available`)) as {
        result?: string;
        premiumPricing?: { operation?: string; price?: number }[];
      } | null;
      const available = json?.result === "available";
      const reg = (json?.premiumPricing ?? []).find((p) => p.operation === "register");
      const price = reg?.price != null ? Number(reg.price) : NaN;
      return { domain, available, priceUsd: Number.isFinite(price) ? price : null };
    },

    async registerDomain(domain: string): Promise<RegisterResult> {
      // PENDING LIVE VERIFICATION (see file header): registration needs contact
      // IDs and returns 202 + spaceship-async-operationid. Sent minimally here.
      await req("POST", `/domains/${encodeURIComponent(domain)}`, { autoRenew: false, years: 1 });
      return { domain, registrar: "spaceship", priceUsd: 0 };
    },

    async upsertDnsRecords(domain: string, records: DnsRecordInput[]): Promise<void> {
      await req("PUT", `/dns/records/${encodeURIComponent(domain)}`, {
        force: true,
        items: records.map(toSpaceshipRecord),
      });
    },

    async getDnsRecords(domain: string): Promise<DnsRecordInput[]> {
      const json = (await req("GET", `/dns/records/${encodeURIComponent(domain)}?take=100&skip=0`)) as {
        items?: Parameters<typeof fromSpaceshipRecord>[0][];
      } | null;
      return (json?.items ?? []).map(fromSpaceshipRecord);
    },
  };
}
