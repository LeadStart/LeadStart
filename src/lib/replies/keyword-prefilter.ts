// Keyword prefilter for inbound replies — Layer 1 of the two-layer
// classifier.
//
// Runs before Claude, fully deterministic, pure function. Scans the reply
// body for hard signals (wrong-person phrases, referral emails, unsubscribe
// language) so Claude's classifier has extra context.
//
// Output is merged with Claude's structured class inside `decide.ts` to
// produce `final_class`.

export interface PrefilterResult {
  // Specific flags the prefilter matched. Stored on lead_replies.keyword_flags
  // and shown in the admin classification-trail.
  flags: string[];

  // Any email addresses found in the body that are NOT the sender's — likely
  // referral targets. Extracted for downstream routing (auto-follow-up, etc.).
  embedded_emails: string[];

  // Suggested class override. Null means "no strong signal, defer to Claude."
  // Non-null is a hard override on top of Claude.
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

// Opt-out / unsubscribe language. This is the compliance-critical filter: a
// match here becomes a HARD override in decide.ts → final_class "unsubscribe"
// → pipeline.ts flips contacts.status to 'unsubscribed', a permanent,
// org-wide suppression across every channel (email, LinkedIn, native).
//
// Design goal: catch the real opt-outs — "stop", "no more", "remove me", and
// their variations — WITHOUT firing on an interested lead who happens to use
// the word "stop" ("stop by my office", "Stop, this is amazing!"). So bare
// "stop"/"no more" only count when they stand alone on their line (SMS-style
// opt-out) or are attached to a communication target; ambiguous mid-sentence
// "stop" is left for Claude to judge. Patterns are case-insensitive; the
// line-anchored ones use (^|\n)…(\r?\n|$) so a quoted thread below the reply
// doesn't defeat the match.
const UNSUBSCRIBE_PATTERNS: RegExp[] = [
  // --- Explicit opt-out vocabulary ---
  /\bunsubscri/i, // unsubscribe / unsubscription / "unsubscribe me"
  /\bremove\s+me\b/i,
  /\bremove\s+(me\s+)?from\s+(your\s+)?(list|mailing|email)/i,
  /\btake\s+me\s+off\b/i,
  /\bopt(?:ing)?\s*-?\s*out\b/i, // opt out / opt-out / opting out
  /\b(do\s+not|don'?t|please\s+do\s+not|please\s+don'?t)\s+(contact|email|e-?mail|message|text|reach\s+out)\b/i,

  // --- "stop" + a communication target: unambiguous opt-out ---
  /\bstop\s+(emailing|e-?mailing|mailing|messaging|texting|contacting|reaching|sending|soliciting|bothering|harassing|spamming|follow(ing)?\s*[-\s]?up)/i,
  /\bstop\s+(all\s+|sending\s+(me\s+)?|these\s+|the\s+|your\s+|any\s+(more\s+)?)?(e-?mail|message|text|contact|communication|correspondence|outreach|follow[\s-]?ups?)/i,

  // --- Bare "stop" that IS the reply (or its own line). Optional
  // please/just/kindly prefix; must be terminal, so "stop by my office" and
  // "Stop, this is amazing!" do NOT match. ---
  /(^|\n)[\s>*]*(please\s+|just\s+|kindly\s+)?stop[.!]*\s*(\r?\n|$)/i,

  // --- "no more" of us: with a communication noun, or standing alone ---
  /\bno\s+more\s+(e-?mail|message|text|contact|communication|correspondence|outreach|follow[\s-]?ups?|of\s+(these|this|them|those|your))/i,
  /(^|\n)[\s>*]*no\s+more[.!]*\s*(\r?\n|$)/i,
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
