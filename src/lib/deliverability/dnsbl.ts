// Spamhaus DBL (Domain Blocklist) check for a sending domain.
//
// The DBL is the blocklist that actually matters for our native channel:
// we send through Google's IPs, so IP blocklists (ZEN/Barracuda/SpamCop)
// describe Google's reputation, not ours — but the DBL lists the *sending
// domain*, which is squarely our responsibility.
//
// Access is via Spamhaus's free Data Query Service (DQS). Since April 2026
// the legacy public mirrors (dbl.spamhaus.org) refuse queries from cloud /
// public-resolver IPs, so a per-account key is required — we query
// `<domain>.<key>.dbl.dqs.spamhaus.net` and read the A-record answer:
//   - 127.0.1.x   → listed (the return code says why)
//   - NXDOMAIN    → not listed (clean)
//   - 127.255.255.x / anything else → a DQS status/error code (blocked key,
//     typed query, over-volume) — treated as "unchecked", never "listed",
//     so a key problem can never masquerade as a blocklisting.
//
// No key configured → "unchecked" (the feature degrades to the other signals).
// Test domain: dbltest.com is Spamhaus's always-listed fixture.

import { resolve4 } from "node:dns/promises";

export type DblStatus = "listed" | "clean" | "unchecked";

export interface DblResult {
  status: DblStatus;
  detail: string;
}

export async function checkDbl(
  domain: string,
  dqsKey: string | null | undefined,
): Promise<DblResult> {
  const key = dqsKey?.trim();
  if (!key) {
    return { status: "unchecked", detail: "No Spamhaus DQS key configured." };
  }

  try {
    const answers = await resolve4(`${domain}.${key}.dbl.dqs.spamhaus.net`);
    const listing = answers.find((a) => a.startsWith("127.0.1."));
    if (listing) {
      return {
        status: "listed",
        detail: `Listed on the Spamhaus domain blocklist (code ${listing}).`,
      };
    }
    // A non-NXDOMAIN answer that isn't a 127.0.1.x listing is a DQS status
    // code (e.g. 127.255.255.252 = blocked key). Never count it as listed.
    return {
      status: "unchecked",
      detail: `Blocklist lookup returned a status code (${answers.join(", ")}), not a listing.`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      // NXDOMAIN / no A record → the domain is not on the DBL.
      return { status: "clean", detail: "Not listed on the Spamhaus domain blocklist." };
    }
    return { status: "unchecked", detail: "Blocklist lookup failed; will retry next run." };
  }
}
