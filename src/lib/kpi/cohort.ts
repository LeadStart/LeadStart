// Cohort attribution for the per-contact reply rate.
//
// A campaign's daily snapshots bucket replies by the day they ARRIVED, which
// can't answer "of the people we first emailed in this window, what share
// replied": the numerator and denominator would cover different populations
// (follow-up replies land weeks after a contact is first contacted). This
// helper re-buckets repliers by each contact's FIRST-touch day so the numerator
// lines up with new_leads_contacted (contacts whose first email went out that
// day). Deduping by email across the whole campaign also removes the cross-day
// double-count that summing per-day unique_replies produced.
//
// Returns a map of snapshot_date (YYYY-MM-DD) -> count of distinct contacts
// first-touched that day who have replied at least once.

type CohortSend = {
  sent_at: string | null;
  step_index: number;
  to_email: string | null;
};

type CohortReply = {
  lead_email: string | null;
};

export function computeCohortReplies(
  sends: CohortSend[],
  replies: CohortReply[],
): Map<string, number> {
  // First-touch day per contact = the day of their earliest step-0 send.
  // (step_index 0 is the first email of a sequence; one per enrollment. If a
  // contact was somehow re-enrolled we take the earliest so they attribute to
  // a single cohort day.)
  const firstTouchDay = new Map<string, string>();
  for (const s of sends) {
    if (s.step_index !== 0 || !s.sent_at || !s.to_email) continue;
    const email = s.to_email.trim().toLowerCase();
    if (!email) continue;
    const day = s.sent_at.slice(0, 10);
    const cur = firstTouchDay.get(email);
    if (!cur || day < cur) firstTouchDay.set(email, day);
  }

  // Distinct repliers (a contact who replied on several days counts once).
  const repliers = new Set<string>();
  for (const r of replies) {
    if (!r.lead_email) continue;
    const email = r.lead_email.trim().toLowerCase();
    if (email) repliers.add(email);
  }

  // Attribute each replier to their first-touch day. A replier with no
  // first-touch send on record is skipped: they aren't in new_leads_contacted
  // (the denominator) either, so counting them would be inconsistent.
  const byDay = new Map<string, number>();
  for (const email of repliers) {
    const day = firstTouchDay.get(email);
    if (!day) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return byDay;
}
