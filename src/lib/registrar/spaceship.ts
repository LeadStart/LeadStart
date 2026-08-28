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
import { diffDnsRecords } from "./dns";

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

/**
 * Pull the first-year registration price out of an availability response. The
 * exact field is PENDING LIVE VERIFICATION — Spaceship returns a standard
 * price for non-premium domains that the original code never parsed (it only
 * read premiumPricing, so every normal .com came back null and got locked out
 * of "buy where cheaper"). We try the documented/likely fields in order and
 * fall back to the premium field last. Pure; exported for tests. Probe the
 * real shape with scripts/probe-spaceship.ts before the first live buy.
 */
export function extractRegistrationPrice(
  json: Record<string, unknown> | null,
): number | null {
  if (!json) return null;
  const asObj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  const candidates: unknown[] = [
    json["price"],
    asObj(json["price"])?.["registration"],
    json["registrationPrice"],
    asObj(asObj(json["pricing"])?.["registration"])?.["price"],
    asObj(json["pricing"])?.["registration"],
  ];
  const premium = json["premiumPricing"];
  if (Array.isArray(premium)) {
    const reg = premium.find(
      (p) => asObj(p)?.["operation"] === "register",
    );
    if (reg) candidates.push(asObj(reg)?.["price"]);
  }
  for (const c of candidates) {
    const n = c != null ? Number(c) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Provider ────────────────────────────────────────────────────────────────

export function createSpaceshipProvider(creds: { apiKey: string; apiSecret: string }): RegistrarProvider {
  const headers = {
    "X-Api-Key": creds.apiKey,
    "X-Api-Secret": creds.apiSecret,
    "Content-Type": "application/json",
  };

  async function req(method: string, path: string, body?: unknown): Promise<unknown> {
    const { json } = await reqDetailed(method, path, body);
    return json;
  }

  // Like req() but surfaces status + headers, needed for the register call's
  // 202 + spaceship-async-operationid handshake.
  async function reqDetailed(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
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
    const text = res.status === 204 ? "" : await res.text().catch(() => "");
    if (!res.ok) {
      throw new SpaceshipError(`Spaceship ${method} ${path} failed (HTTP ${res.status}). ${text.slice(0, 200)}`);
    }
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, headers: res.headers, json };
  }

  // PENDING LIVE VERIFICATION: the saved-contacts list path + id field.
  // Spaceship requires a pre-created contact id for registrant/admin/tech/
  // billing. We use the account's first saved contact for all four.
  async function firstContactId(): Promise<string | null> {
    const json = (await req("GET", `/contacts?take=50&skip=0`)) as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | null;
    const list = (
      Array.isArray(json)
        ? json
        : Array.isArray((json as Record<string, unknown>)?.["items"])
          ? ((json as Record<string, unknown>)["items"] as unknown[])
          : Array.isArray((json as Record<string, unknown>)?.["contacts"])
            ? ((json as Record<string, unknown>)["contacts"] as unknown[])
            : []
    ) as Record<string, unknown>[];
    const first = list[0];
    if (!first) return null;
    const id = first["contactId"] ?? first["id"] ?? first["contact"] ?? null;
    return id != null ? String(id) : null;
  }

  // PENDING LIVE VERIFICATION: async-operation status path + terminal shape.
  // Poll a registration operation until it settles or ~30s elapses (staying
  // inside the provision route's 60s budget alongside the availability sweep +
  // DNS write). A still-pending timeout is treated as accepted: the DNS-write
  // step retries against the domain until ownership is real, which doubles as
  // the confirmation probe.
  async function pollAsyncOperation(opId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const json = (await req(
        "GET",
        `/async-operations/${encodeURIComponent(opId)}`,
      )) as Record<string, unknown> | null;
      const status = String(
        json?.["status"] ?? json?.["state"] ?? "",
      ).toUpperCase();
      if (status === "FAILED" || status === "ERROR") {
        throw new SpaceshipError(
          `Spaceship registration operation ${opId} failed: ${JSON.stringify(json).slice(0, 200)}`,
        );
      }
      const pending =
        status === "" ||
        status === "PENDING" ||
        status === "IN_PROGRESS" ||
        status === "PROCESSING" ||
        status === "RUNNING";
      if (!pending) return; // SUCCESS / COMPLETED / DONE
      await sleep(5000);
    }
    // Timed out still pending — accept it; DNS/ownership retries confirm.
  }

  async function getRecords(domain: string): Promise<DnsRecordInput[]> {
    const json = (await req("GET", `/dns/records/${encodeURIComponent(domain)}?take=100&skip=0`)) as {
      items?: Parameters<typeof fromSpaceshipRecord>[0][];
    } | null;
    return (json?.items ?? []).map(fromSpaceshipRecord);
  }

  return {
    id: "spaceship",

    async checkAvailability(domain: string): Promise<DomainAvailability> {
      const json = (await req("GET", `/domains/${encodeURIComponent(domain)}/available`)) as
        | Record<string, unknown>
        | null;
      const available =
        json?.["result"] === "available" || json?.["available"] === true;
      return { domain, available, priceUsd: extractRegistrationPrice(json) };
    },

    async registerDomain(domain: string): Promise<RegisterResult> {
      // PENDING LIVE VERIFICATION (see file header). Registration needs a saved
      // contact id and returns 202 + a spaceship-async-operationid header we
      // poll to completion.
      const contactId = await firstContactId();
      if (!contactId) {
        throw new SpaceshipError(
          "No saved contact found on the Spaceship account. Create one under " +
            "Account, Contacts (the API requires a saved contact id to register a domain).",
        );
      }
      const { status, headers } = await reqDetailed(
        "POST",
        `/domains/${encodeURIComponent(domain)}`,
        {
          autoRenew: false,
          years: 1,
          contacts: {
            registrant: contactId,
            admin: contactId,
            tech: contactId,
            billing: contactId,
          },
        },
      );
      if (status === 202) {
        const opId = headers.get("spaceship-async-operationid");
        if (opId) await pollAsyncOperation(opId);
      }
      // Price isn't reliably returned by the register call; the provision route
      // falls back to the availability quote when this is 0.
      return { domain, registrar: "spaceship", priceUsd: 0 };
    },

    async upsertDnsRecords(domain: string, records: DnsRecordInput[]): Promise<void> {
      // True upsert via read-merge-write: Spaceship's PUT replaces the record
      // set, so we merge the desired records onto what's already there (diff
      // keeps unrelated TXT, replaces our slots, drops stray MX) and PUT the
      // full result. Correct whether the PUT replaces or merges.
      // PENDING LIVE VERIFICATION: replace-vs-merge semantics of force:true.
      const current = await getRecords(domain);
      const diff = diffDnsRecords(current, records);
      const finalSet: DnsRecordInput[] = [
        ...diff.keep,
        ...diff.edit.map((e) => e.desired),
        ...diff.create,
      ];
      await req("PUT", `/dns/records/${encodeURIComponent(domain)}`, {
        force: true,
        items: finalSet.map(toSpaceshipRecord),
      });
    },

    async getDnsRecords(domain: string): Promise<DnsRecordInput[]> {
      return getRecords(domain);
    },
  };
}
