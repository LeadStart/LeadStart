// Spamhaus DBL (Domain Blocklist) check for a sending domain.
//
// The DBL is the blocklist that actually matters for our native channel:
// we send through Google's IPs, so IP blocklists (ZEN/Barracuda/SpamCop)
// describe Google's reputation, not ours — but the DBL lists the *sending
// domain*, which is squarely our responsibility.
//
// Access is via Spamhaus's free Data Query Service (DQS). The legacy public
// mirrors (dbl.spamhaus.org) refuse queries from cloud/public-resolver IPs, so
// a per-account key is required. DQS queries are ordinary DNS (they work
// through any resolver, no allow-listing) — we query
// `<domain>.<key>.dbl.dq.spamhaus.net` and read the A-record answer:
//   - 127.0.1.2-99 / 127.0.1.102-199 → listed (bad reputation / abused-legit)
//   - 127.0.1.255                     → "invalid query" error code, NOT a listing
//   - NXDOMAIN                        → not listed (clean)
//   - anything else (127.255.255.x …) → a DQS status code — treated as
//     "unchecked", never "listed", so a key/quota problem can't look like a hit.
//
// IMPORTANT: the zone is dq.spamhaus.net — NOT "dqs", NOT ".org". Getting the
// zone wrong makes every query NXDOMAIN (reads as a false "clean").
//
// No key configured → "unchecked" (the feature degrades to the other signals).
// Test domain: dbltest.com is Spamhaus's always-listed fixture (→ 127.0.1.2).

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
    const answers = await resolve4(`${domain}.${key}.dbl.dq.spamhaus.net`);
    // Listed codes are 127.0.1.2-99 (bad reputation) and 127.0.1.102-199
    // (abused-legit). 127.0.1.255 is the "invalid query" error code — same /24
    // but NOT a listing — so exclude it.
    const listing = answers.find((a) => a.startsWith("127.0.1.") && a !== "127.0.1.255");
    if (listing) {
      return {
        status: "listed",
        detail: `Listed on the Spamhaus domain blocklist (code ${listing}).`,
      };
    }
    // Any other answer (127.0.1.255 invalid-query, or a 127.255.255.x status
    // code) isn't a listing — don't let a key/quota problem look like a hit.
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
