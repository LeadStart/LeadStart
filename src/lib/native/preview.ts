// Builder preview: one outgoing email rendered as a given contact would get it.
// Spintax resolves with a seed (so subject + body are one coherent render), then
// {{tokens}} fill. In SAMPLE mode sampleFallback fills unknown tokens so nothing
// reads as a raw {{placeholder}}; with a REAL contact's map unknown tokens stay
// literal and `unresolved` lists the ones that would send blank for this
// contact. Shared by StepCopyCheck and the email workspace. Preview only; never
// the send path.

import { renderSpintax } from "@/lib/spintax";
import { applyTokens, extractCampaignTokens, sampleFallback } from "./tokens";

export interface EmailPreview {
  subject: string;
  body: string;
  unresolved: { token: string; key: string }[];
}

export function renderEmailPreview(
  subject: string,
  body: string,
  tokens: Record<string, string>,
  opts: { sample: boolean; seed: string },
): EmailPreview {
  const subjSpun = subject.trim() ? renderSpintax(subject, opts.seed) : "";
  const bodySpun = renderSpintax(body, opts.seed);
  const fill = (t: string) => applyTokens(t, tokens, opts.sample ? sampleFallback : undefined);
  // Real-data mode only: tokens in THIS render with no value and no inline
  // {{token|default}}. Computed on the spintax-resolved text so an unchosen
  // branch's tokens aren't flagged. Sample mode fills everything.
  let unresolved: { token: string; key: string }[] = [];
  if (!opts.sample) {
    const info = extractCampaignTokens([subjSpun, bodySpun]);
    unresolved = [...info.standard, ...info.custom].filter(
      (t) => !t.hasFallback && !(tokens[t.key] ?? "").trim(),
    );
  }
  return {
    subject: subjSpun ? fill(subjSpun) : "",
    body: fill(bodySpun),
    unresolved,
  };
}
