import { extractProfileId } from "../domain";
import { trimRaw, type PhaseProvider, type PhaseResult, type ProviderItem } from "./types";

// Phase 5 — LinkedIn posting recency. Same vendor + same profile URLs as the
// profiles phase; returns each person's recent posts, from which we derive
// last_posted_at and a recent-post count. No cookies.
export const ACTIVITY_ACTOR_ID = "harvestapi~linkedin-profile-posts";

// How many recent posts to sample per profile. Small: we only need "when did
// they last post" + a rough cadence, and inactive people return 0 (cheap).
const MAX_POSTS = 5;
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type Rec = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function postTimestampMs(p: Rec): number | null {
  const posted = p.postedAt as Rec | undefined;
  if (posted) {
    if (typeof posted.timestamp === "number") return posted.timestamp;
    const d = str(posted.date);
    if (d) {
      const t = Date.parse(d);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

function postAuthorId(p: Rec): string | null {
  const author = p.author as Rec | undefined;
  if (!author) return null;
  return (
    extractProfileId(str(author.linkedinUrl) ?? undefined) ??
    str(author.publicIdentifier)
  );
}

export const activityProvider: PhaseProvider = {
  id: "harvestapi-activity",
  actorId: ACTIVITY_ACTOR_ID,

  buildInput(items: ProviderItem[]): unknown {
    const targetUrls = items
      .map((it) => it.linkedin_url)
      .filter((u): u is string => Boolean(u));
    return { targetUrls, maxPosts: MAX_POSTS, includeReposts: true, includeQuotePosts: true };
  },

  parseItems(datasetItems: unknown[], items: ProviderItem[]): Map<string, PhaseResult> {
    // Group posts by author URN id (fallback: public identifier).
    const postsByAuthor = new Map<string, Rec[]>();
    for (const raw of datasetItems as Rec[]) {
      if (!raw || typeof raw !== "object") continue;
      const author = postAuthorId(raw);
      if (!author) continue;
      const arr = postsByAuthor.get(author) ?? [];
      arr.push(raw);
      postsByAuthor.set(author, arr);
    }

    const now = Date.now();
    const out = new Map<string, PhaseResult>();
    for (const it of items) {
      const key = it.profile_id ?? extractProfileId(it.linkedin_url);
      const posts = key ? postsByAuthor.get(key) : undefined;
      if (!posts || posts.length === 0) {
        out.set(it.id, {
          status: "not_found",
          extra: { activity_note: "no recent posts found" },
        });
        continue;
      }

      const stamps = posts
        .map(postTimestampMs)
        .filter((t): t is number => t !== null)
        .sort((a, b) => b - a);
      const lastMs = stamps[0] ?? null;
      const recentCount = stamps.filter((t) => now - t <= RECENT_WINDOW_MS).length;

      out.set(it.id, {
        status: "found",
        extra: {
          last_posted_at: lastMs ? new Date(lastMs).toISOString() : null,
          recent_post_count: posts.length,
          recent_30d_count: recentCount,
        },
        raw: trimRaw(posts.slice(0, 3)),
      });
    }
    return out;
  },
};
