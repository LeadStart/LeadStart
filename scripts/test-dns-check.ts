#!/usr/bin/env node
/**
 * Unit tests for the DNS lookups in src/lib/deliverability/check.ts
 * (checkDomainAuth, checkMx) with INJECTED resolvers, so every failure mode
 * is exercised without the network.
 *
 * The rule under test: NXDOMAIN / NODATA is an answer ("no such record" →
 * fail); a timeout / SERVFAIL / refusal is not ("unknown" → never scored). A
 * failed lookup is retried once through the next resolver. Before 2026-09-25 a
 * resolver hiccup read as "no SPF, no DMARC, no MX" and could drive an inbox
 * to a false "critical".
 *
 * Usage:
 *   npx tsx scripts/test-dns-check.ts
 */

import { checkDomainAuth, checkMx, type DnsLookups } from "../src/lib/deliverability/check.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const dnsErr = (code: string) => Object.assign(new Error(code), { code });
const TXT: Record<string, string[][]> = {
  "ex.com": [["v=spf1 include:_spf.google.com ~all"]],
  "google._domainkey.ex.com": [["v=DKIM1; k=rsa; p=MIIB", "IjANBg"]],
  "_dmarc.ex.com": [["v=DMARC1; p=none; rua=mailto:r@ex.com"]],
};
// A resolver that answers from TXT (ENOTFOUND for unknown names) unless told to fail.
function resolver(opts: { failWith?: string; calls?: string[] } = {}): DnsLookups {
  return {
    txt: async (name) => {
      opts.calls?.push(`txt:${name}`);
      if (opts.failWith) throw dnsErr(opts.failWith);
      const rec = TXT[name];
      if (!rec) throw dnsErr("ENOTFOUND");
      return rec;
    },
    mx: async (name) => {
      opts.calls?.push(`mx:${name}`);
      if (opts.failWith) throw dnsErr(opts.failWith);
      if (name === "nomx.com") throw dnsErr("ENODATA");
      return [{ exchange: "smtp.google.com", priority: 1 }];
    },
  };
}

async function main() {
  console.log("\n■ both resolvers time out → every record 'unknown', never 'fail'");
  {
    const auth = await checkDomainAuth("ex.com", [resolver({ failWith: "ETIMEOUT" }), resolver({ failWith: "ETIMEOUT" })]);
    const mx = await checkMx("ex.com", [resolver({ failWith: "ESERVFAIL" }), resolver({ failWith: "ETIMEOUT" })]);
    assert(auth.spf.status === "unknown" && auth.dkim.status === "unknown" && auth.dmarc.status === "unknown", "SPF / DKIM / DMARC unknown");
    assert(mx.status === "unknown", `MX unknown (got ${mx.status})`);
    assert(auth.spf.detail.includes("ETIMEOUT"), `detail names the failure (got: ${auth.spf.detail})`);
  }

  console.log("\n■ primary times out, fallback answers → real verdicts (the retry works)");
  {
    const auth = await checkDomainAuth("ex.com", [resolver({ failWith: "ETIMEOUT" }), resolver()]);
    const mx = await checkMx("ex.com", [resolver({ failWith: "ECONNREFUSED" }), resolver()]);
    assert(auth.spf.status === "pass", `SPF pass (got ${auth.spf.status})`);
    assert(auth.dkim.status === "pass", `DKIM pass, chunked record joined (got ${auth.dkim.status})`);
    assert(auth.dmarc.status === "warn", `DMARC p=none → warn (got ${auth.dmarc.status})`);
    assert(mx.status === "pass", `MX pass (got ${mx.status})`);
  }

  console.log("\n■ NXDOMAIN / NODATA is an answer → 'fail', and the fallback is not consulted");
  {
    const primaryCalls: string[] = [];
    const fallbackCalls: string[] = [];
    const auth = await checkDomainAuth("bare.com", [resolver({ calls: primaryCalls }), resolver({ calls: fallbackCalls })]);
    assert(auth.spf.status === "fail" && auth.dmarc.status === "fail", "no SPF / no DMARC → fail");
    assert(auth.dkim.status === "warn", `no DKIM record → warn (got ${auth.dkim.status})`);
    assert(fallbackCalls.length === 0, `authoritative absence isn't retried (fallback calls: ${fallbackCalls.length})`);
    const mx = await checkMx("nomx.com", [resolver(), resolver()]);
    assert(mx.status === "fail", `ENODATA for MX → fail (got ${mx.status})`);
  }

  console.log("\n■ mixed: one lookup fails, the others answer → only that record is unknown");
  {
    const flaky: DnsLookups = {
      txt: async (name) => {
        if (name === "ex.com") throw dnsErr("ESERVFAIL");
        return resolver().txt(name);
      },
      mx: resolver().mx,
    };
    const auth = await checkDomainAuth("ex.com", [flaky, flaky]);
    assert(auth.spf.status === "unknown", `SPF unknown (got ${auth.spf.status})`);
    assert(auth.dkim.status === "pass" && auth.dmarc.status === "warn", "DKIM / DMARC still graded");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
