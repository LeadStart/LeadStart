#!/usr/bin/env node
/**
 * Unit tests for the cold-email MIME builder after the plain-text-only switch.
 * Covers the quoted-printable encoder (round-trip fidelity, RFC 2045 line
 * limits, soft breaks) and asserts buildRawEmail emits a single text/plain
 * part with no HTML alternative.
 *
 * No network, no DB. Run: npx tsx scripts/test-mime-quoted-printable.ts
 */
import { toQuotedPrintable, buildRawEmail } from "../src/lib/gmail/mime.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function eq<T>(got: T, want: T, msg: string) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}
function ok(cond: boolean, msg: string) {
  eq(cond, true, msg);
}

/**
 * Reference quoted-printable DECODER, written independently of the encoder so
 * a round-trip test proves real fidelity rather than two copies of one bug.
 * Decodes to bytes first so multi-byte UTF-8 reassembles correctly.
 */
function decodeQP(s: string): string {
  const noSoft = s.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoft.length; i++) {
    const ch = noSoft[i];
    if (ch === "=" && /^[0-9A-F]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(noSoft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(ch, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const roundTrip = (s: string) => decodeQP(toQuotedPrintable(s)).replace(/\r\n/g, "\n");
const longestLine = (s: string) =>
  Math.max(...s.split("\r\n").map((l) => l.length));

console.log("toQuotedPrintable: basics");
eq(toQuotedPrintable("Hi Jane"), "Hi Jane", "short ASCII line passes through untouched");
eq(toQuotedPrintable("a=b"), "a=3Db", "literal = encodes to =3D");
eq(toQuotedPrintable("café"), "caf=C3=A9", "non-ASCII encodes as UTF-8 bytes");
eq(toQuotedPrintable("\u{1F44B}"), "=F0=9F=91=8B", "emoji surrogate pair encodes as 4 UTF-8 bytes");
eq(toQuotedPrintable("trailing "), "trailing=20", "trailing space is encoded, not left to be stripped");
eq(toQuotedPrintable("trailing\t"), "trailing=09", "trailing tab is encoded");
eq(toQuotedPrintable("From here on"), "=46rom here on", "leading 'From ' has its F encoded");
eq(toQuotedPrintable("Not From here"), "Not From here", "'From' mid-line is left alone");

console.log("\ntoQuotedPrintable: paragraph structure");
eq(toQuotedPrintable("a\n\nb"), "a\r\n\r\nb", "blank line survives as a paragraph break");
eq(toQuotedPrintable("a\r\nb"), "a\r\nb", "CRLF input normalises to a single hard break");
eq(toQuotedPrintable(""), "", "empty body stays empty");

console.log("\ntoQuotedPrintable: soft breaks and line limits");
// The whole point of the change: one long logical line must NOT gain a hard
// newline. It may only be split with soft breaks, which decode away.
const long =
  "Hi Jane, I noticed your firm ranks well on Google but is completely invisible " +
  "inside AI answers, which is where a growing share of high-intent legal searches " +
  "now start. We fix exactly that for established firms and I would love to show you " +
  "what your current AI visibility looks like.";
const encodedLong = toQuotedPrintable(long);
ok(encodedLong.includes("=\r\n"), "a long line is split with soft breaks");
ok(longestLine(encodedLong) <= 76, `every physical line is <= 76 chars (longest ${longestLine(encodedLong)})`);
eq(roundTrip(long), long, "long line round-trips byte-for-byte through decode");
eq(
  decodeQP(encodedLong).includes("\n"),
  false,
  "decoded long line contains NO newline, so Gmail reflows it to the viewport",
);

console.log("\ntoQuotedPrintable: round-trip fidelity");
const realBody = [
  "Hi Jane,",
  "",
  "I ran a quick check on how Dawson & Reed shows up inside AI assistants and the answer was: not at all. That is a growing slice of the searches your future clients actually run, and it is not something classic SEO reporting surfaces.",
  "",
  "Worth a look? I can send the actual output, no call needed.",
  "",
  "Daniel",
].join("\n");
eq(roundTrip(realBody), realBody, "realistic multi-paragraph body round-trips exactly");
ok(longestLine(toQuotedPrintable(realBody)) <= 76, "realistic body respects the 76-char limit");

const gnarly = "Subéjçt with = signs, éàü, emoji \u{1F680}, and   runs   of   spaces";
eq(roundTrip(gnarly), gnarly, "accents, equals signs, emoji and space runs all round-trip");
ok(longestLine(toQuotedPrintable(gnarly)) <= 76, "gnarly body respects the 76-char limit");

// A single word longer than the wrap width must still be split safely.
const runOn = "x".repeat(500);
eq(roundTrip(runOn), runOn, "a 500-char unbroken word round-trips");
ok(longestLine(toQuotedPrintable(runOn)) <= 76, "a 500-char unbroken word respects the 76-char limit");

const accentRun = "é".repeat(300);
eq(roundTrip(accentRun), accentRun, "300 accented chars round-trip");
ok(longestLine(toQuotedPrintable(accentRun)) <= 76, "300 accented chars respect the 76-char limit");
// Every "=" on the wire must either open a complete =XX escape or be the
// soft-break marker at end of line. A split escape would corrupt the byte.
const escapesIntact = (encoded: string) =>
  encoded.split("\r\n").every((physical) => {
    const payload = physical.endsWith("=") ? physical.slice(0, -1) : physical;
    return !/=(?![0-9A-F]{2})/.test(payload);
  });
ok(escapesIntact(toQuotedPrintable(accentRun)), "a soft break never splits an =XX escape sequence");
ok(escapesIntact(toQuotedPrintable(gnarly)), "escapes stay intact in a mixed accent/emoji body");

console.log("\nbuildRawEmail: single-part plain text");
const raw = buildRawEmail({
  fromEmail: "dan@tubeforseo.com",
  fromName: "Daniel",
  to: "jane@dawsonreed.com",
  subject: "Quick question about Dawson & Reed",
  bodyText: realBody,
  messageId: "<abc@tubeforseo.com>",
});
const decodedRaw = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

ok(decodedRaw.includes('Content-Type: text/plain; charset="UTF-8"'), "declares a text/plain content type");
ok(decodedRaw.includes("Content-Transfer-Encoding: quoted-printable"), "declares quoted-printable encoding");
eq(decodedRaw.includes("text/html"), false, "carries NO text/html part");
eq(decodedRaw.includes("multipart/alternative"), false, "is NOT multipart/alternative");
eq(decodedRaw.includes("boundary="), false, "has no MIME boundary at all");
eq(decodedRaw.includes("format=flowed"), false, "no longer advertises format=flowed");
eq(decodedRaw.includes("font-family"), false, "no font stack leaks into a cold email");

const [rawHeaders, ...rawBodyParts] = decodedRaw.split("\r\n\r\n");
const rawBody = rawBodyParts.join("\r\n\r\n");
eq(decodeQP(rawBody).replace(/\r\n/g, "\n"), realBody, "the body decodes back to exactly what the caller passed");
ok(rawHeaders.includes("From: Daniel <dan@tubeforseo.com>"), "From header still formats the display name");
ok(rawHeaders.includes("To: jane@dawsonreed.com"), "To header survives");
ok(longestLine(rawBody) <= 76, "encoded body respects the 76-char limit end to end");

// Threading headers are still conditional.
const noThread = Buffer.from(
  buildRawEmail({
    fromEmail: "d@x.com",
    to: "j@y.com",
    subject: "s",
    bodyText: "b",
    messageId: "<1@x.com>",
  }).replace(/-/g, "+").replace(/_/g, "/"),
  "base64",
).toString("utf8");
eq(noThread.includes("In-Reply-To:"), false, "no In-Reply-To on a first touch");

const threaded = Buffer.from(
  buildRawEmail({
    fromEmail: "d@x.com",
    to: "j@y.com",
    subject: "s",
    bodyText: "b",
    messageId: "<2@x.com>",
    inReplyTo: "<1@x.com>",
    references: "<1@x.com>",
  }).replace(/-/g, "+").replace(/_/g, "/"),
  "base64",
).toString("utf8");
ok(threaded.includes("In-Reply-To: <1@x.com>"), "follow-up still threads with In-Reply-To");
ok(threaded.includes("References: <1@x.com>"), "follow-up still carries References");

console.log(`\nmime quoted-printable: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
