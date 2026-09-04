"use client";

// Shared conversation pane for the admin + client inboxes. Shows the full
// email back-and-forth for a reply: the copy WE sent (pulled live from Gmail —
// native_sends stores no body) above what the lead replied back with. The
// stored reply row is always rendered immediately as the anchor so there's
// never a blank pane; the live thread replaces it once it loads, and on any
// failure (legacy channel, delegation off, transient) we quietly keep showing
// the reply we already have.

import { useEffect, useState } from "react";
import { Mail, Loader2, CornerUpLeft } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { formatBody, timeSince } from "@/lib/replies/ui";
import type { ThreadMessage } from "@/app/api/replies/[id]/thread/route";

type ThreadState = "loading" | "ready" | "unavailable" | "error";

interface ThreadData {
  state: ThreadState;
  messages: ThreadMessage[];
  reason?: string;
}

export function useReplyThread(replyId: string): ThreadData {
  const [data, setData] = useState<ThreadData>({ state: "loading", messages: [] });
  useEffect(() => {
    let cancelled = false;
    setData({ state: "loading", messages: [] });
    fetch(appUrl(`/api/replies/${replyId}/thread`))
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.threadAvailable && Array.isArray(j.messages) && j.messages.length > 0) {
          setData({ state: "ready", messages: j.messages as ThreadMessage[] });
        } else {
          setData({ state: "unavailable", messages: [], reason: j.reason });
        }
      })
      .catch(() => {
        if (!cancelled) setData({ state: "error", messages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [replyId]);
  return data;
}

// Minimal reply shape the pane needs — both LeadReply and the admin's narrowed
// row satisfy it.
export interface ConversationReply {
  id: string;
  lead_name: string | null;
  lead_email: string;
  subject: string | null;
  body_text: string | null;
  received_at: string;
}

function Bubble({
  direction,
  who,
  when,
  subject,
  bodyHtml,
}: {
  direction: "outbound" | "inbound";
  who: string;
  when: string | null;
  subject: string | null;
  bodyHtml: string;
}) {
  const outbound = direction === "outbound";
  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-xl border px-4 py-3 text-sm leading-relaxed ${
          outbound
            ? "bg-muted/70 border-border/60"
            : "bg-card border-border/60 border-l-[3px] border-l-[#2E37FE]"
        }`}
      >
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
          {outbound && <CornerUpLeft size={11} />}
          <span>{who}</span>
          {when && <span className="font-normal">· {timeSince(when)}</span>}
        </div>
        {subject && (
          <p className="mb-1 text-[13px] font-semibold text-foreground">{subject}</p>
        )}
        <div
          className="whitespace-pre-wrap break-words text-foreground/90"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      </div>
    </div>
  );
}

export function Conversation({ reply }: { reply: ConversationReply }) {
  const thread = useReplyThread(reply.id);
  const leadName = reply.lead_name || reply.lead_email;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-[#fbfcfe] px-4 py-4 sm:px-5">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        {thread.state === "ready" ? (
          thread.messages.map((m) => (
            <Bubble
              key={m.id}
              direction={m.direction}
              who={m.direction === "outbound" ? "You (sent)" : leadName}
              when={m.at}
              subject={m.subject}
              bodyHtml={formatBody(m.bodyText)}
            />
          ))
        ) : (
          // Loading / unavailable / error → show the stored reply we already
          // have so the pane is never blank.
          <>
            {thread.state === "loading" && (
              <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" /> Loading the full thread…
              </div>
            )}
            <Bubble
              direction="inbound"
              who={leadName}
              when={reply.received_at}
              subject={reply.subject}
              bodyHtml={formatBody(reply.body_text)}
            />
            {(thread.state === "unavailable" || thread.state === "error") && (
              <p className="flex items-center justify-center gap-1.5 py-1 text-center text-[11px] text-muted-foreground/70">
                <Mail size={11} />
                {thread.reason === "unsupported_channel"
                  ? "Showing the reply only — this channel has no linked email thread."
                  : "Showing the reply only — the full sent thread isn't available right now."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
