"use client";

// EmailWorkspace: the body of the email step's compose MODAL, as a three-pane
// workspace. Left: the variant rail (A, B, C… with split, word count and a
// check dot) plus the A/B test settings. Middle: one editor for the selected
// variant, its body filling the height. Right: an inbox preview rendered for a
// real contact (switchable) with the copy check under it. Every variant gets the
// same editor, Insert chips, unmapped-variable warning and copy check. Variant A
// is the node's own subject/body; B, C… are node.variants. Controlled: every
// edit goes out through onPatch. The parent keys it by node id, so the selected
// variant resets when another email opens.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, CornerDownRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  emailVariant,
  emailVariants,
  activeVariants,
  type EmailAbConfig,
  type EmailNode,
} from "@/lib/flow/graph";
import { extractCampaignTokens, normalizeVarKey, SAMPLE_TOKENS } from "@/lib/native/tokens";
import { renderEmailPreview } from "@/lib/native/preview";
import { findSpamMatches } from "@/lib/deliverability/copy";
import { hasSpintax } from "@/lib/spintax";
import { StepCopyCheck } from "@/components/campaigns/step-copy-check";
import { appUrl } from "@/lib/api-url";
import styles from "./flow.module.css";

// One previewable contact from /api/admin/campaign-preview-context.
interface PreviewContact {
  label: string;
  tokens: Record<string, string>;
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function EmailWorkspace({
  node,
  isFirst,
  firstEmailSubject,
  insertChips,
  customChips,
  clientId,
  campaignId,
  abAutoPauseDefault,
  onPatch,
}: {
  node: EmailNode;
  isFirst: boolean;
  firstEmailSubject: string;
  insertChips: string[];
  /** The campaign's custom {{variables}}: tokens outside these have no contact column. */
  customChips: string[];
  clientId?: string;
  campaignId?: string;
  /** Campaign-level A/B auto-pause default, shown as the "inherit" state. */
  abAutoPauseDefault: boolean;
  onPatch: (p: Partial<EmailNode>) => void;
}) {
  const extras = node.variants ?? [];
  const all = emailVariants(node); // A (the node itself), then B, C…
  const multi = extras.length > 0;
  const share = `${Math.floor(100 / activeVariants(node).length)}%`;

  const [activeId, setActiveId] = useState(node.id);
  const active = all.find((v) => v.id === activeId) ?? all[0];
  const isA = active.id === node.id;
  // A follow-up with no subject of its own threads as "Re:" on the first email.
  const threaded = !isFirst && !active.subject.trim();

  function update(id: string, p: { subject?: string; body?: string }) {
    if (id === node.id) onPatch(p);
    else onPatch({ variants: extras.map((v) => (v.id === id ? { ...v, ...p } : v)) });
  }

  // A new variant starts as a copy: of A by default (on a follow-up its subject
  // starts blank, so it threads), or of the selected variant via Duplicate.
  const focusSubject = useRef(false);
  function addVariant(from?: { subject: string; body: string }) {
    const v = from ? emailVariant(from.subject, from.body) : emailVariant(isFirst ? node.subject : "", node.body);
    onPatch({ variants: [...extras, v] });
    setActiveId(v.id);
    focusSubject.current = true;
  }
  function removeVariant(id: string) {
    const i = all.findIndex((v) => v.id === id);
    onPatch({ variants: extras.filter((v) => v.id !== id) });
    setActiveId(all[Math.max(0, i - 1)].id);
  }

  // Per-node auto-winner override: undefined = inherit the campaign default,
  // true/false = force on/off for THIS A/B step.
  const autoPause = node.ab_config?.autoPause;
  const autoPauseValue = autoPause === undefined ? "inherit" : autoPause ? "on" : "off";
  function setAutoPause(v: string) {
    const next: EmailAbConfig = { ...(node.ab_config ?? {}) };
    if (v === "inherit") delete next.autoPause;
    else next.autoPause = v === "on";
    onPatch({ ab_config: Object.keys(next).length > 0 ? next : undefined });
  }

  // ---- Insert chips: drop {{token}} at the caret of the last-touched field ----
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<"subject" | "body">("body");

  // The editor is keyed by variant, so focus the fresh subject after it mounts.
  useEffect(() => {
    if (!focusSubject.current) return;
    focusSubject.current = false;
    subjectRef.current?.focus();
  }, [activeId]);

  function insertToken(token: string) {
    let field: "subject" | "body" = lastFocused.current;
    let el: HTMLInputElement | HTMLTextAreaElement | null =
      field === "subject" ? subjectRef.current : bodyRef.current;
    if (!el) {
      field = "body";
      el = bodyRef.current;
    }
    if (!el) return;
    const cur = el.value;
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    update(active.id, { [field]: cur.slice(0, start) + token + cur.slice(end) });
    const caret = start + token.length;
    const target = el;
    // Restore focus + caret after the controlled re-render commits.
    setTimeout(() => {
      target.focus();
      target.setSelectionRange(caret, caret);
    }, 0);
  }

  // ---- checks ----------------------------------------------------------------
  // Copy tokens with no mapped contact column: under the columns-drive-variables
  // model they never register a variable and send blank.
  const mapped = useMemo(
    () => new Set(customChips.map((c) => normalizeVarKey(c.replace(/[{}]/g, "")))),
    [customChips],
  );
  const unmappedIn = (subject: string, body: string) =>
    extractCampaignTokens([subject, body]).custom.filter((t) => !mapped.has(t.key));
  // The rail's amber dot: an empty body, a missing first-touch subject, a token
  // with no contact column, or a spam phrase. The full copy check is on the right.
  const needsLook = (v: { subject: string; body: string }) =>
    !v.body.trim() ||
    (isFirst && !v.subject.trim()) ||
    unmappedIn(v.subject, v.body).length > 0 ||
    findSpamMatches(v.subject, "subject").length > 0 ||
    findSpamMatches(v.body, "body").length > 0;
  const unmapped = unmappedIn(active.subject, active.body);

  // ---- inbox preview: real contacts from the campaign, else sample data ------
  const [contacts, setContacts] = useState<PreviewContact[]>([]);
  const [ctxLoading, setCtxLoading] = useState(Boolean(campaignId || clientId));
  const [contactIdx, setContactIdx] = useState(0);
  const [nonce, setNonce] = useState(0); // re-roll seed for spintax

  useEffect(() => {
    if (!campaignId && !clientId) return;
    let cancelled = false;
    (async () => {
      try {
        const qs = campaignId
          ? `campaignId=${encodeURIComponent(campaignId)}`
          : `clientId=${encodeURIComponent(clientId!)}`;
        const res = await fetch(appUrl(`/api/admin/campaign-preview-context?${qs}`));
        if (!res.ok) return;
        const data = (await res.json()) as {
          contactLabel: string | null;
          tokens: Record<string, string> | null;
          contacts?: PreviewContact[];
        };
        if (cancelled) return;
        setContacts(
          data.contacts ??
            (data.tokens ? [{ label: data.contactLabel ?? "your contact", tokens: data.tokens }] : []),
        );
      } catch {
        /* sample data below */
      } finally {
        if (!cancelled) setCtxLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, clientId]);

  const contact = contacts[contactIdx] ?? null;
  const sample = contact === null;
  const tokens = contact?.tokens ?? SAMPLE_TOKENS;
  const previewSubject = threaded ? `Re: ${firstEmailSubject}` : active.subject;
  const preview = useMemo(
    () => renderEmailPreview(previewSubject, active.body, tokens, { sample, seed: `preview:${active.id}:${nonce}` }),
    [previewSubject, active.body, active.id, tokens, sample, nonce],
  );
  const spun = hasSpintax(active.subject) || hasSpintax(active.body);
  const sender = tokens.yourname || "";
  const senderInitial = (sender.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();

  const subjectPreview = (v: { subject: string }) =>
    v.subject.trim() || (isFirst ? "(add a subject)" : `Re: ${firstEmailSubject || "the first email"}`);
  const words = wordCount(active.body);

  return (
    <div className={styles.ws}>
      {/* ---- left: variants + test settings ---- */}
      <aside className={styles.wsRail}>
        <div className={styles.wsRailH}>Variants</div>
        <div className={styles.wsList}>
          {all.map((v) => {
            const on = v.id === active.id;
            const ghost = !isFirst && !v.subject.trim();
            return (
              <button
                key={v.id}
                type="button"
                className={`${styles.wsItem} ${on ? styles.wsItemOn : ""}`}
                onClick={() => setActiveId(v.id)}
              >
                <span className={`${styles.abK} ${on ? styles.abKOn : ""}`}>{v.label}</span>
                <span className={styles.wsItemTxt}>
                  <span className={`${styles.wsItemSub} ${ghost ? styles.wsItemSubGhost : ""}`}>{subjectPreview(v)}</span>
                  <span className={styles.wsItemMeta}>
                    <i className={`${styles.wsDot} ${needsLook(v) ? styles.wsDotWarn : ""}`} />
                    {v.paused ? "Paused · " : multi ? `${share} · ` : ""}
                    {wordCount(v.body)} words
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <button type="button" className={styles.wsAdd} onClick={() => addVariant()}>
          <Plus size={13} /> {multi ? "Add variant" : "Start A/B test"}
        </button>
        {multi && (
          <div className={styles.wsSec}>
            <div className={styles.wsRailH}>Test settings</div>
            <div className={styles.wsSplit}>
              {all.map((v) => (
                <span
                  key={v.id}
                  className={`${v.id === active.id ? styles.wsSplitOn : ""} ${v.paused ? styles.wsSplitPaused : ""}`}
                >
                  {v.label}
                </span>
              ))}
            </div>
            <p className={styles.hint}>
              Leads split evenly across every variant; we measure reply &amp; positive-reply rate per
              variant. {isFirst ? "Each variant needs its own subject." : "A blank subject threads as “Re:”."}
            </p>
            <label className={styles.label}>Auto-winner</label>
            <select className={styles.select} value={autoPauseValue} onChange={(e) => setAutoPause(e.target.value)}>
              <option value="inherit">Use campaign default ({abAutoPauseDefault ? "on" : "off"})</option>
              <option value="on">Auto-pause losers on</option>
              <option value="off">Off: decide manually</option>
            </select>
            <p className={styles.hint}>
              When on, once this test has the volume it pauses the losing variants (95% significance +
              a ≥1&nbsp;pt lead on positive-reply rate) so new leads route to the winner. Sticky: a
              lead already in a variant’s thread stays there.
            </p>
          </div>
        )}
      </aside>

      {/* ---- middle: the selected variant's editor ---- */}
      <main className={styles.wsEd} key={active.id}>
        <div className={styles.wsEdHead}>
          <span className={`${styles.abK} ${styles.abKOn}`}>{active.label}</span>
          <b>Variant {active.label}</b>
          <span className={styles.wsMuted}>
            {!multi ? "The only version" : active.paused ? "Paused" : `${isA ? "Control · " : ""}${share} of leads`}
          </span>
          <span style={{ flex: 1 }} />
          {multi && (
            <button
              type="button"
              className={styles.wsBtn}
              onClick={() => addVariant({ subject: active.subject, body: active.body })}
            >
              <Copy size={13} /> Duplicate
            </button>
          )}
          {!isA && (
            <button type="button" className={`${styles.wsBtn} ${styles.wsBtnDanger}`} onClick={() => removeVariant(active.id)}>
              <Trash2 size={13} /> Remove
            </button>
          )}
        </div>
        {active.paused && (
          <p className={styles.wsNote}>
            The auto-winner paused this variant: new leads go to the others. Leads already on it keep getting it.
          </p>
        )}
        <div className={styles.subjWrap}>
          <input
            ref={subjectRef}
            className={`${styles.input} ${styles.wsSubj} ${!isFirst ? styles.ghostable : ""}`}
            aria-label={isFirst ? "Subject line" : "Subject (optional)"}
            value={active.subject}
            placeholder={
              isFirst
                ? isA
                  ? "Quick question, {{first_name}}"
                  : "Subject for this variant"
                : `Re: ${firstEmailSubject || "the first email’s subject"}`
            }
            onFocus={() => (lastFocused.current = "subject")}
            onChange={(e) => update(active.id, { subject: e.target.value })}
          />
          {!isFirst && (
            <span className={`${styles.threadTag} ${threaded ? styles.threadSame : styles.threadNew}`}>
              <CornerDownRight size={13} /> {threaded ? "same thread" : "new thread"}
            </span>
          )}
        </div>
        {!isFirst && (
          <p className={styles.threadHelp}>
            {threaded ? (
              <>
                Leave blank to stay on the <b>first email’s thread</b>: the recipient sees it as a reply,
                no new subject line.
              </>
            ) : (
              <>
                Custom subject: this email starts a <b>new thread</b>. Clear it to fall back to the first
                email’s thread.
              </>
            )}
          </p>
        )}
        <div className={styles.varRow}>
          <span className={styles.varLbl}>Insert:</span>
          {insertChips.map((v) => (
            <button
              key={v}
              type="button"
              className={styles.varChip}
              // preventDefault keeps the field's focus + caret, so the token
              // lands at the cursor instead of appending after a blur.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertToken(v)}
              title={`Insert ${v} at the cursor`}
            >
              {v}
            </button>
          ))}
        </div>
        <textarea
          ref={bodyRef}
          className={`${styles.textarea} ${styles.wsBody}`}
          aria-label="Body"
          value={active.body}
          placeholder="Plain text. Placeholders: {{first_name}} {{company}} {{title}} {{intro_line}}"
          onFocus={() => (lastFocused.current = "body")}
          onChange={(e) => update(active.id, { body: e.target.value })}
        />
        <div className={styles.wsEdFoot}>
          <span>{words} words</span>
          <span>about {Math.max(1, Math.round(words / 4))} sec to read</span>
          <span>{threaded ? "Subject: threads as Re:" : `Subject: ${active.subject.length} characters`}</span>
        </div>
      </main>

      {/* ---- right: inbox preview + copy check ---- */}
      <aside className={styles.wsPv}>
        <div className={styles.wsPvHead}>
          <b>Inbox preview</b>
          <span style={{ flex: 1 }} />
          {contacts.length > 1 && (
            <select
              className={`${styles.select} ${styles.wsSelectSm}`}
              value={contactIdx}
              onChange={(e) => setContactIdx(Number(e.target.value))}
              aria-label="Preview as contact"
            >
              {contacts.map((c, i) => (
                <option key={i} value={i}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className={styles.wsMail}>
          {ctxLoading ? (
            <div className={styles.wsLoading}>
              <Loader2 size={13} className="animate-spin" /> Loading preview…
            </div>
          ) : (
            <>
              <div className={styles.wsMailTop}>
                <span className={styles.wsAv}>{senderInitial}</span>
                <div className={styles.wsMailWho}>
                  <b>{sender || "Sender"}</b>
                  <span className={styles.wsMuted}>
                    to {contact ? contact.label : "a sample contact (no contacts loaded yet)"}
                  </span>
                </div>
                {spun && (
                  <button type="button" className={styles.wsBtn} onClick={() => setNonce((n) => n + 1)} title="Show another spintax version">
                    <RefreshCw size={12} /> Regenerate
                  </button>
                )}
              </div>
              <div className={styles.wsMailSubj}>{preview.subject || "(no subject)"}</div>
              <div className={styles.wsMailBody}>
                {preview.body.trim() ? preview.body : <span className={styles.wsMuted}>Empty, write the body to preview it.</span>}
              </div>
              {preview.unresolved.length > 0 && (
                <p className={styles.wsBlank}>
                  Blank for this contact: <b>{preview.unresolved.map((t) => `{{${t.token}}}`).join(", ")}</b>: map
                  a column with a value, or add a default like <code>{`{{${preview.unresolved[0].token}|…}}`}</code>.
                </p>
              )}
            </>
          )}
        </div>
        <div className={styles.wsRailH}>Copy check · Variant {active.label}</div>
        {unmapped.length > 0 ? (
          <p className={styles.wsUnmapped}>
            Not mapped to a contact column: <b>{unmapped.map((t) => `{{${t.token}}}`).join(", ")}</b>: map a
            column when you import contacts, or these send blank.
          </p>
        ) : (
          <p className={styles.wsOk}>
            <Check size={13} /> Every variable maps to a contact column
          </p>
        )}
        <StepCopyCheck
          key={active.id}
          subject={isFirst ? active.subject : ""}
          body={active.body}
          clientId={clientId}
          campaignId={campaignId}
          isFirstStep={isFirst}
          hidePreview
          onApplySpintax={(nv) =>
            update(active.id, {
              ...(isFirst && nv.subject !== null ? { subject: nv.subject } : {}),
              body: nv.body,
            })
          }
        />
      </aside>
    </div>
  );
}
