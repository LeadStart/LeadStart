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

// Classes the prefilter can assert on its own. This is Layer 1 of the
// two-layer classifier (Claude Haiku is Layer 2, see pipeline.ts; decide.ts
// merges both, and the prefilter stays the sole authority on the compliance
// overrides). It covers the full set of common outcomes. Anything neither
// layer can match confidently falls
// through to needs_review, so the owner triages rather than the client being
// alerted on a guess.
export type PrefilterSuggestedClass =
  | "wrong_person_no_referral"
  | "referral_forward"
  | "unsubscribe"
  | "ooo"
  | "not_interested"
  | "meeting_booked"
  | "true_interest"
  | "qualifying_question";

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
// → pipeline.ts calls suppressUnsubscribe (src/lib/replies/suppression.ts):
// a per-client dnc_entries row for native email (the sender checks it every
// tick), plus the legacy org-wide contacts.status='unsubscribed' flip for the
// non-native channels.
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

  // --- Idioms + strong variants the canonical vocabulary above misses. Kept
  // tight (mostly "my <contact-noun>") so a genuinely interested reply can't
  // trip them: unsubscribe is a HARD override that permanently suppresses. ---
  /\blose\s+my\s+(e-?mail|address|number|info|contact)\b/i,
  /\bdelete\s+my\s+(e-?mail|address|account|info|information|data|details|number|contact|record)\b/i,
  /\berase\s+my\s+(e-?mail|address|info|information|data|details|record|contact|number)\b/i,
  /\btake\s+my\s+(name|e-?mail|number|details|info|contact)\s+off\b/i,
  /\b(report(ed|ing)?|mark(ed|ing)?|flag(ged|ging)?)\s+(this|you|it|these|them|your\s+e-?mails?)?\s*(as\s+)?spam\b/i,
  /\bthis\s+is\s+(clearly\s+|just\s+|pure\s+|literally\s+)?spam\b/i,
];

// Out-of-office auto-reply markers. OOO replies tend to mention specific
// dates + "I'll respond when I return" phrasing.
const OOO_PATTERNS: RegExp[] = [
  /\bout\s+of\s+(the\s+)?office\b/i,
  /\bon\s+(vacation|holiday|leave|pto)\b/i,
  /\bauto[\s-]?(reply|response|responder)\b/i,
  /\bautomat(ic|ed)\s+(reply|response|message|e-?mail|notification)\b/i, // "Automatic reply:"
  /\bthis\s+is\s+an\s+automat(ic|ed)\b/i,
  /\bwill\s+(be\s+)?back\s+on\b/i,
  /\blimited\s+(access\s+to\s+)?email\b/i,
  /\breturn(ing)?\s+(to\s+the\s+office\s+)?on\b/i,
  /\bcurrently\s+(out|away|travel(l)?ing|on\s+leave|unavailable|on\s+pto)\b/i,
  /\baway\s+from\s+(my\s+)?(desk|office|e-?mail)\b/i,
];

// Clear rejections (NOT opt-outs — the person is declining but not demanding
// removal). Kept precise so soft/ambiguous replies ("maybe later") fall
// through to needs_review instead of being wrongly killed. Checked BEFORE the
// positive patterns so "not interested" never reads as "interested".
const NOT_INTERESTED_PATTERNS: RegExp[] = [
  /\bnot\s+interested\b/i,
  /\bno\s+interest\b/i,
  /\bno[,\s]+(thanks?|thank\s+you)\b/i,
  /\bnot\s+(a\s+)?(good\s+)?fit\b/i,
  /\bnot\s+for\s+(me|us)\b/i,
  /\bnot\s+looking\s+(for|to|at)\b/i,
  /\bnot\s+something\s+(i'?m|we'?re|i\s+am|we\s+are)\s+(interested|looking)\b/i,
  /\bwe(?:'re| are)\s+(all\s+set|good|not\s+interested|happy\s+with\s+our|already)\b/i,
  /\balready\s+(have|got|use|using|working\s+with|have\s+a|partnered)\b/i,
  /\b(wouldn'?t|would\s+not|won'?t|will\s+not|not)\s+(be\s+)?interested\b/i,
  /\b(don'?t|do\s+not)\s+think\s+(this|it|that|we|i|you)\b/i,
  /\b(i'?ll|we'?ll)\s+pass\b(?!\s+(this|it|that|along|by|to|on)\b)/i,
  /(^|\n)[\s>*]*pass[\s.!]*(\r?\n|$)/i, // bare "pass" (the sequence invites "reply pass")
];

// Strong scheduling signals → a meeting is (near) booked.
const MEETING_PATTERNS: RegExp[] = [
  /\b(calendly|cal\.com|savvycal|chilipiper|meetings?\.hubspot|hubspot\.com\/meetings|zcal\.co|acuityscheduling|calendar\.app\.google)\b/i,
  /\b(booked|scheduled|grabbed|picked|found|reserved)\s+(a\s+|some\s+)?(time|slot|call|meeting|spot)\b/i,
  /\b(sent|sending|shared)\s+(you\s+)?(a\s+|an\s+)?(calendar\s+)?invite\b/i,
  /\b(added|put)\s+(it\s+|you\s+)?(on|to)\s+(the\s+|your\s+|my\s+)?calendar\b/i,
  /\bon\s+your\s+(calendar|calendly|schedule)\b/i,
  /\bcalendar\s+invite\b/i,
  /\bbook\s+(a\s+)?time\s+(here|below|via|through)\b/i,
];

// Positive intent → true_interest. Precise phrases; a negation is caught first
// by NOT_INTERESTED_PATTERNS above (ordering in runKeywordPrefilter).
const INTEREST_PATTERNS: RegExp[] = [
  /\b(i'?m|we'?re|i\s+am|we\s+are|i'?d\s+be|we'?d\s+be)\s+(very\s+|quite\s+|definitely\s+)?interested\b/i,
  /\b(sounds?|looks?|seems?)\s+(good|great|interesting|promising|worth)\b/i,
  /\btell\s+me\s+more\b/i,
  /\b(learn|hear|know)\s+more\b/i,
  /\bmore\s+(info|information|details)\b/i,
  /\bsend\s+(me\s+)?(more\s+|the\s+|over\s+)?(info|information|details|it\s+over)\b/i,
  /\blet'?s\s+(talk|chat|connect|discuss|set\s+up|schedule|find\s+a\s+time|hop\s+on|do\s+it|jump\s+on)\b/i,
  /\bhappy\s+to\s+(chat|talk|connect|learn|discuss|hop\s+on|jump\s+on)\b/i,
  /\bopen\s+to\s+(it|chatting|talking|learning|a\s+(call|chat|conversation|quick\s+chat))\b/i,
  /\bworth\s+a\s+(chat|call|conversation|quick\s+(chat|call)|look|discussion)\b/i,
  /\b(call|reach|contact)\s+me\b/i,
  /\bgive\s+me\s+a\s+(call|ring|shout)\b/i,
  /\b(schedule|set\s+up|book|grab)\s+(a\s+|some\s+)?(call|time|meeting|chat|conversation|demo|coffee|15|30)\b/i,
  /\bwhat\s+(times?|days?)\s+(work|are\s+you|do\s+you\s+have)\b/i,
  /\b(your|some)\s+availability\b/i,
  /\bwhen\s+(are|can|would)\s+(you|we)\b/i,
  /\bcurious\s+(to|about|how)\b/i,
  /\bkeen\s+to\b/i,
  /\bhow\s+much\s+(is|does|would|for)\b/i,
  /\bwhat'?s\s+(the\s+)?(cost|price|pricing|investment|catch)\b/i,
  /\bhow\s+does\s+(it|this)\s+work\b/i,
  /(^|\n)[\s>*]*(yes|yep|yeah|sure|interested|i'?m\s+in|sounds\s+good|let'?s\s+(talk|chat))[\s.!]*(\r?\n|$)/i,
];

// Any other genuine question → qualifying_question (still a hot class).
const QUESTION_PATTERNS: RegExp[] = [
  /\bhow\s+(does|do|would|can|many|long|exactly)\b/i,
  /\bwhat\s+(is|are|do|does|would|kind|type|exactly|about)\b/i,
  /\b(can|could|would)\s+you\s+(tell|explain|send|share|elaborate|provide|clarify)\b/i,
  /\bdo\s+you\s+(have|offer|work|support|handle|do)\b/i,
  /\?\s*$/, // the reply ends on a question
];

// Hostile / identity "questions" that are NOT buying signals. The bare "ends on
// a question mark" rule above would otherwise fire qualifying_question (a HOT
// class → rings the client's phone) on an annoyed "who is this?". When one of
// these hits and there's no genuine interest phrase, we withhold the hot
// question class and fall through to needs_review so a human (and Claude, when
// on) judges it, instead of a false hot alarm on a non-prospect.
const HOSTILE_QUESTION_PATTERNS: RegExp[] = [
  /\bwho\s+(is|are|the\s+(hell|heck|f\S*)\s+is|r)\s+(this|you|u|ya)\b/i,
  /\bwho['’]?s\s+this\b/i,
  /\bdo\s+i\s+know\s+you\b/i,
  /\bhave\s+we\s+(met|spoken|talked|connected)\b/i,
  /\b(how|where)\s+did\s+you\s+(get|find)\s+my\b/i,
  /\bhow\s+do\s+you\s+have\s+my\b/i,
  /\bdid\s+i\s+(ever\s+)?sign\s*[\s-]?up\b/i,
  /\bwhy\s+(are|r)\s+you\s+(e-?mailing|contacting|messaging|texting|reaching|spamming)\b/i,
  /\bis\s+this\s+(spam|a\s+scam|legit|real|automated|a\s+bot)\b/i,
];

// Cut the quoted thread off the bottom of a reply before we classify it. The
// quoted original carries OUR outbound copy (e.g. "schedule a complimentary
// conversation") and both parties' addresses, which would otherwise poison
// the keyword match. We classify only the fresh text above the first quote
// boundary; if the whole message is a quote, fall back to the full text.
function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const boundary: RegExp[] = [
    /^\s*On\b.+\bwrote:\s*$/i, // "On Mon, Jul 6, X <..> wrote:"
    /^\s*-{2,}\s*Original Message\s*-{2,}/i,
    /^\s*_{10,}\s*$/, // Outlook divider
    /^\s*From:\s.*@/i, // forwarded/quoted header block
    /^\s*>{1,}/, // quoted line
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (boundary.some((re) => re.test(lines[i]))) {
      cut = i;
      break;
    }
  }
  const top = lines.slice(0, cut).join("\n").trim();
  return top.length > 0 ? top : text.trim();
}

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
  // Classify only the fresh reply text, not the quoted thread beneath it.
  const text = stripQuotedReply(body || "");
  if (!text) {
    return { flags: [], embedded_emails: [], suggested_class: null, reason: null };
  }

  const flags: string[] = [];
  const embedded = extractEmbeddedEmails(text, senderEmail ?? null);

  const wrongPersonHit = matchAny(text, WRONG_PERSON_PATTERNS);
  const referralHit = matchAny(text, REFERRAL_PATTERNS);
  const unsubscribeHit = matchAny(text, UNSUBSCRIBE_PATTERNS);
  const oooHit = matchAny(text, OOO_PATTERNS);
  const notInterestedHit = matchAny(text, NOT_INTERESTED_PATTERNS);
  const meetingHit = matchAny(text, MEETING_PATTERNS);
  const interestHit = matchAny(text, INTEREST_PATTERNS);
  const questionHit = matchAny(text, QUESTION_PATTERNS);
  const hostileQuestionHit = matchAny(text, HOSTILE_QUESTION_PATTERNS);

  // A NEGATED "stop" ("don't stop reaching out", "never stop emailing me",
  // "please don't stop") is the opposite of an opt-out. Because unsubscribe is a
  // permanent, cross-campaign HARD override (decide.ts) that Claude can't undo,
  // a false positive here silences a genuinely interested lead. So if the only
  // opt-out signal is a stop-phrase AND it's negated (no hard opt-out word like
  // "unsubscribe"/"remove me"/"delete my" present), we void the match.
  let unsubscribeActive = !!unsubscribeHit;
  if (unsubscribeActive) {
    const negatedStop =
      /\b(do\s?n['']?t|do\s+not|never|please\s+do\s?n['']?t|wo\s?n['']?t|would\s+not)\s+stop\b/i.test(
        text,
      );
    const hardOptOutWord =
      /\b(unsubscri|remove\s+me|opt(?:ing)?\s*-?\s*out|take\s+(me|my)\b|delete\s+my|lose\s+my|erase\s+my|as\s+spam|is\s+spam)\b/i.test(
        text,
      );
    if (negatedStop && !hardOptOutWord) unsubscribeActive = false;
  }

  if (wrongPersonHit) flags.push("wrong_person_phrase");
  if (referralHit) flags.push("referral_phrase");
  if (embedded.length > 0) flags.push("referral_email_present");
  if (unsubscribeActive) flags.push("unsubscribe_phrase");
  if (oooHit) flags.push("ooo_phrase");
  if (notInterestedHit) flags.push("not_interested_phrase");
  if (meetingHit) flags.push("meeting_phrase");
  if (interestHit) flags.push("interest_phrase");
  if (questionHit) flags.push("question_phrase");
  if (hostileQuestionHit) flags.push("hostile_question");

  // Priority order, most-certain → least; first match wins. Anything that
  // doesn't clearly match stays null → needs_review in decide.ts, so a human
  // triages rather than the client being alerted (or a lead killed) on a guess.
  let suggested_class: PrefilterSuggestedClass | null = null;
  let reason: string | null = null;

  if (unsubscribeActive && !referralHit) {
    suggested_class = "unsubscribe";
    reason = "Opt-out phrase matched";
  } else if (oooHit && !wrongPersonHit && !referralHit && !interestHit && !meetingHit) {
    // Only OOO when there's no competing positive signal — "out until Monday,
    // let's connect then" is a warm lead, not a dead auto-reply.
    suggested_class = "ooo";
    reason = "Out-of-office phrase matched";
  } else if ((wrongPersonHit || referralHit) && embedded.length > 0) {
    suggested_class = "referral_forward";
    reason = `Handoff phrase + embedded email address${embedded.length > 1 ? "es" : ""}`;
  } else if (wrongPersonHit && embedded.length === 0) {
    suggested_class = "wrong_person_no_referral";
    reason = "Wrong-person phrase, no forwarding address";
  } else if (notInterestedHit) {
    suggested_class = "not_interested";
    reason = "Not-interested phrase matched";
  } else if (meetingHit) {
    suggested_class = "meeting_booked";
    reason = "Meeting / scheduling signal matched";
  } else if (interestHit) {
    suggested_class = "true_interest";
    reason = "Positive-intent phrase matched";
  } else if (questionHit && !hostileQuestionHit) {
    // A genuine question is a hot signal; a hostile/identity "question"
    // ("who is this?", "how did you get my email?") is not, so it falls
    // through to needs_review instead of ringing the client's phone.
    suggested_class = "qualifying_question";
    reason = "Question detected";
  }

  return {
    flags,
    embedded_emails: embedded,
    suggested_class,
    reason,
  };
}
