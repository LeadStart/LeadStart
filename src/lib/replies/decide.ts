// Two-layer classification merger: Layer 3 of the reply-routing classifier.
//
// Takes two independent signals and produces a single `final_class` that
// downstream routing (client notification, dossier, etc.) uses.
//
// Layer 1: keyword prefilter (deterministic regex, zero cost)
// Layer 2: Claude Haiku classifier (structured output, ~$0.0005/call)
//
// Pure function. No network. No side effects.

import type { ReplyClass, ReplyReferralContact } from "@/types/app";
import type { PrefilterResult } from "./keyword-prefilter";
import type { ClassifierOutput } from "@/lib/ai/classifier";

export interface DecideInput {
  prefilter: PrefilterResult;
  claude: ClassifierOutput | null;    // null when Claude was skipped or errored
}

export interface DecideOutput {
  final_class: ReplyClass;
  claude_confidence: number | null;
  claude_class: ReplyClass | null;
  reason: string;                     // human-readable merged reason
  referral_contact: ReplyReferralContact | null;
}

// Threshold below which we route to needs_review regardless of what
// Claude returned. 0.70 matches the plan's stated cutoff.
const LOW_CONFIDENCE_THRESHOLD = 0.7;

// A Claude-only "unsubscribe" that reaches Precedence 2 is uncorroborated: any
// opt-out the deterministic prefilter recognises becomes a Precedence-1 hard
// override, so the regex did NOT catch this one. Unsubscribe writes a PERMANENT,
// cross-campaign DNC that Claude can't take back, so we require a higher bar
// before auto-suppressing on the model alone. Between LOW_CONFIDENCE_THRESHOLD
// and this, the reply is held for a human to confirm (needs_review) instead of
// silently suppressing a possibly-good lead. The reply itself already halted the
// live sequence (poll-native-replies marks the enrollment 'replied'), so the
// only cost is cross-campaign suppression latency, not extra sends.
const MODEL_ONLY_SUPPRESS_THRESHOLD = 0.85;

// Classes the prefilter is allowed to hard-override Claude on. These are
// all deterministic text matches that don't need a model to arbitrate.
const PREFILTER_HARD_OVERRIDES = new Set<ReplyClass>([
  "unsubscribe",       // legal / compliance
  "ooo",               // auto-reply, unambiguous
]);

/**
 * Merge keyword prefilter + Claude classifier into a single final_class +
 * structured audit trail.
 *
 * Precedence (high → low):
 * 1. Prefilter HARD overrides: unsubscribe, ooo. Deterministic regexes that
 *    don't need Claude to arbitrate. Legal / compliance considerations on
 *    unsubscribe make this important.
 * 2. Claude classifier output, if present and confident (>= 0.70). The
 *    classifier sees the full taxonomy + persona context; it's the primary
 *    source of truth for nuanced hot/warm distinctions. EXCEPTION: a
 *    model-only `unsubscribe` (uncorroborated by the prefilter) needs
 *    >= 0.85 to auto-suppress; 0.70-0.85 is demoted to needs_review so a
 *    human confirms before the permanent, cross-campaign DNC.
 * 3. Low-confidence Claude → needs_review (admin triages, doesn't notify
 *    the client).
 * 4. Claude missing (API failed or skipped) AND prefilter has a suggested
 *    class → use the prefilter suggestion.
 * 5. Claude missing AND prefilter has no suggestion → needs_review.
 */
export function decideFinalClass(input: DecideInput): DecideOutput {
  const { prefilter, claude } = input;

  // --- Precedence 1: prefilter hard overrides ---
  if (
    prefilter.suggested_class &&
    PREFILTER_HARD_OVERRIDES.has(prefilter.suggested_class as ReplyClass)
  ) {
    return {
      final_class: prefilter.suggested_class as ReplyClass,
      claude_confidence: claude?.confidence ?? null,
      claude_class: (claude?.class as ReplyClass | undefined) ?? null,
      reason:
        prefilter.reason ||
        `Deterministic prefilter match: ${prefilter.suggested_class}`,
      referral_contact: null,
    };
  }

  // --- Precedence 2 & 3: Claude present ---
  if (claude) {
    const lowConfidence = claude.confidence < LOW_CONFIDENCE_THRESHOLD;

    // Promote to needs_review on low confidence (unless Claude chose
    // needs_review itself, in which case keep the class and keep the
    // reason Claude gave).
    if (lowConfidence && claude.class !== "needs_review") {
      return {
        final_class: "needs_review",
        claude_confidence: claude.confidence,
        claude_class: claude.class,
        reason: `Low Claude confidence (${claude.confidence.toFixed(2)}) on class=${claude.class}: ${claude.reason}`,
        referral_contact:
          claude.class === "referral_forward" ? claude.referral_contact : null,
      };
    }

    // Model-only opt-out guard: an uncorroborated Claude 'unsubscribe' below the
    // suppress bar goes to human confirmation rather than an immediate, permanent
    // DNC. (At or above the bar we trust it and let pipeline.ts suppress.)
    if (
      claude.class === "unsubscribe" &&
      claude.confidence < MODEL_ONLY_SUPPRESS_THRESHOLD
    ) {
      return {
        final_class: "needs_review",
        claude_confidence: claude.confidence,
        claude_class: claude.class,
        reason: `Model-only opt-out held for confirmation: Claude ${claude.confidence.toFixed(2)} < ${MODEL_ONLY_SUPPRESS_THRESHOLD} suppress bar and no deterministic opt-out match. ${claude.reason}`,
        referral_contact: null,
      };
    }

    return {
      final_class: claude.class,
      claude_confidence: claude.confidence,
      claude_class: claude.class,
      reason: claude.reason,
      referral_contact:
        claude.class === "referral_forward" ? claude.referral_contact : null,
    };
  }

  // --- Precedence 4 & 5: Claude missing ---
  if (prefilter.suggested_class) {
    return {
      final_class: prefilter.suggested_class as ReplyClass,
      claude_confidence: null,
      claude_class: null,
      reason:
        `Claude unavailable; prefilter suggested ${prefilter.suggested_class}. ` +
        (prefilter.reason || ""),
      referral_contact: null,
    };
  }

  return {
    final_class: "needs_review",
    claude_confidence: null,
    claude_class: null,
    reason: "Claude unavailable and prefilter found no strong signal.",
    referral_contact: null,
  };
}
