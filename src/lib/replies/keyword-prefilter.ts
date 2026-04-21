// Keyword prefilter for inbound replies — Layer 1 of the three-layer
// classifier (plan: docs/plans/ai-reply-routing.md).
//
// Runs before Claude, fully deterministic, pure function. Scans the reply
// body for hard signals (wrong-person phrases, referral emails, unsubscribe
// language) so Claude's classifier has extra context + so we can catch the
// most costly Instantly misclassification — interested-tagged replies that
// are actually a polite forward to someone else.
//
// Output is merged with Instantly's native tag + Claude's structured class
// inside `decide.ts` (commit #4) to produce `final_class`.

export interface PrefilterResult {
  // Specific flags the prefilter matched. Stored on lead_replies.keyword_flags
  // and shown in the admin classification-trail.
  flags: string[];

  // Any email addresses found in the body that are NOT the sender's — likely
  // referral targets. Extracted for downstream routing (auto-follow-up, etc.).
  embedded_emails: string[];

  // Suggested class override. Null means "no strong signal, defer to Claude /
  // Instantly tag." Non-null is a hard override on top of Claude.
  suggested_class: PrefilterSuggestedClass | null;

  // Human-readable explanation for the admin classification trail.
  reason: string | null;
}

// Subset of ReplyClass that the prefilter can confidently assert on its own.
// We stay conservative: only classes where a deterministic text match is
// sufficient (no nuance). Everything else defers to Claude.
export type PrefilterSuggestedClass =
  | "wrong_person_no_referral"
  | "referral_forward"
  | "unsubscribe"
  | "ooo";

// Sender-address-aware email extraction. Email-regex matches are cheap and
// robust; we lowercase for the sender comparison but preserve original case
// in output (Gmail etc. are case-insensitive but some systems aren't).
//
// Extended to tolerate trailing punctuation common in inline sentences
// ("contact mike@acme.co, he handles...").
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Wrong-person phrases. Ordered from most→least specific.
const WRONG_PERSON_PATTERNS: RegExp[] = [
  /\bnot\s+the\s+right\s+(person|contact|one)\b/i,
  /\bwrong\s+(person|contact)\b/i,
  /\bi['']?m\s+not\s+the\s+best\s+(person|contact)\b/i,
  /\bi\s+do\s+not\s+handle\b/i,
  /\bthat['']?s\s+not\s+my\s+(area|department|role)\b/i,
  /\bbetter\s+(to\s+)?reach\s+out\s+to\b/i,
  /\byou\s+may\s+want\s+to\s+(contact|reach\s+out\s+to|speak\s+with)\b/i,
  /\bplease\s+contact\b/i,
  /\bshould\s+be\s+directed\s+to\b/i,
];

// Referral / forwarding phrases — implies a new contact is provided.
const REFERRAL_PATTERNS: RegExp[] = [
  /\bforward(ing)?\s+(this|you|to)\b/i,
  /\bconnect(ing)?\s+you\s+(with|to)\b/i,
  /\b(going\s+to\s+)?loop(ing)?\s+(you\s+)?in\b/i,   // "loop in" and "looping in"
  /\bcc['']?ing\s+in\b/i,
  /\bi['']?m\s+(going\s+to\s+)?(connect|introduce|forward|loop)\b/i,
  /\bpassing\s+(this|you)\s+(along|on)\b/i,
  /\bintroduc(e|ing)\s+you\s+to\b/i,
];

// Unsubscribe / remove-me phrases.
const UNSUBSCRIBE_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bremove\s+me\b/i,
  /\btake\s+me\s+off\b/i,
  /\bstop\s+(emailing|contacting)\b/i,
  /\bdo\s+not\s+(contact|email)\s+me\b/i,
  /\bopt\s+out\b/i,
];

// Out-of-office auto-reply markers. OOO replies tend to mention specific
// dates + "I'll respond when I return" phrasing.
const OOO_PATTERNS: RegExp[] = [
  /\bout\s+of\s+(the\s+)?office\b/i,
  /\bon\s+(vacation|holiday|leave|pto)\b/i,
  /\bauto[\s-]?(reply|response|responder)\b/i,
  /\bwill\s+(be\s+)?back\s+on\b/i,
  /\blimited\s+(access\s+to\s+)?email\b/i,
  /\breturn(ing)?\s+(to\s+the\s+office\s+)?on\b/i,
];

function matchAny(text: string, patterns: RegExp[]): RegExp | null {
  for (const p of patterns) if (p.test(text)) return p;
  return null;
}

// Extract emails from the body that aren't the sender's own address. These
// are the referral candidates. Always lowercased on compare, but we return
// the first-seen case.
function extractEmbeddedEmails(body: string, senderEmail: string | null): string[] {
  const matches = body.match(EMAIL_REGEX) || [];
  const senderLower = (senderEmail || "").toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const lower = m.toLowerCase();
    // Strip trailing punctuation like "mike@x.com," from the raw capture
    const cleaned = m.replace(/[.,;:)\]}'"]+$/, "");
    if (lower === senderLower) continue;
    if (seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    out.push(cleaned);
  }
  return out;
}

/**
 * Run the keyword prefilter against a reply body. Pure function.
 *
 * @param body - plain-text body of the reply
 * @param senderEmail - the `from_address_email` of the reply, used to
 *   exclude the prospect's own address from embedded-email extraction
 * @returns flags, embedded emails, and a (conservative) suggested class
 */
export function runKeywordPrefilter(
  body: string | null | undefined,
  senderEmail: string | null | undefined
): PrefilterResult {
  const text = (body || "").trim();
  if (!text) {
    return { flags: [], embedded_emails: [], suggested_class: null, reason: null };
  }

  const flags: string[] = [];
  const embedded = extractEmbeddedEmails(text, senderEmail ?? null);

  const wrongPersonHit = matchAny(text, WRONG_PERSON_PATTERNS);
  const referralHit = matchAny(text, REFERRAL_PATTERNS);
  const unsubscribeHit = matchAny(text, UNSUBSCRIBE_PATTERNS);
  const oooHit = matchAny(text, OOO_PATTERNS);

  if (wrongPersonHit) flags.push("wrong_person_phrase");
  if (referralHit) flags.push("referral_phrase");
  if (embedded.length > 0) flags.push("referral_email_present");
  if (unsubscribeHit) flags.push("unsubscribe_phrase");
  if (oooHit) flags.push("ooo_phrase");

  // Priority order for suggested_class, from most confident to least.
  // Each is deliberately conservative — Claude still gets to confirm or
  // override in the decide.ts merger.
  let suggested_class: PrefilterSuggestedClass | null = null;
  let reason: string | null = null;

  if (unsubscribeHit && !referralHit) {
    suggested_class = "unsubscribe";
    reason = `Unsubscribe phrase matched: ${unsubscribeHit.source}`;
  } else if (oooHit && !wrongPersonHit && !referralHit) {
    suggested_class = "ooo";
    reason = `Out-of-office phrase matched: ${oooHit.source}`;
  } else if ((wrongPersonHit || referralHit) && embedded.length > 0) {
    // Wrong-person + email-in-body = almost certainly a referral forward.
    // This is the case where Instantly tags it `lead_interested` but it's
    // actually a hand-off — one of the biggest classification wins.
    suggested_class = "referral_forward";
    reason = `Handoff phrase + embedded email address${embedded.length > 1 ? "es" : ""}`;
  } else if (wrongPersonHit && embedded.length === 0) {
    suggested_class = "wrong_person_no_referral";
    reason = `Wrong-person phrase matched, no forwarding address provided`;
  }

  return {
    flags,
    embedded_emails: embedded,
    suggested_class,
    reason,
  };
}
