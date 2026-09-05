"use client";

// FlowEditor: the visual branching sequence editor. Renders a FlowGraph as a
// centered spine on a dotted canvas: compact "envelope" tiles for content nodes
// (email/linkedin/internal), wait chips, and every condition forked into yes/no
// arms (nested sequences). Clicking a content tile opens a centered compose
// MODAL (instant, viewport-centered, contained) to edit it: the tiles stay a
// uniform summary. Controlled: the parent owns the graph and passes value +
// onChange. Email/wait are the executed path today; linkedin/internal/condition
// are authored + persisted but don't run yet.

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Mail,
  Clock,
  Plus,
  Trash2,
  GitBranch,
  Bell,
  ChevronDown,
  X,
  CornerDownRight,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { extractCampaignTokens, normalizeVarKey } from "@/lib/native/tokens";
import {
  type FlowGraph,
  type FlowNode,
  type FlowConditionTrigger,
  type EmailNode,
  type EmailVariant,
  type EmailAbConfig,
  type LinkedInNode,
  type InternalNode,
  emailNode,
  emailVariant,
  waitNode,
  linkedinNode,
  internalNode,
  conditionNode,
  flattenPrimaryPath,
} from "@/lib/flow/graph";
import { updateNode, removeNode, insertAfter, appendToBranch } from "@/lib/flow/edit";
import { isUntrackedTrigger } from "@/lib/flow/runtime";
import { StepCopyCheck } from "@/components/campaigns/step-copy-check";
import { appUrl } from "@/lib/api-url";
import styles from "./flow.module.css";

// lucide v1 dropped brand icons; inline the LinkedIn glyph (matches the mockup).
function LinkedInGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4 0 4.75 2.5 4.75 5.8V21H21v-5.9c0-1.4-.03-3.2-2-3.2-2 0-2.3 1.5-2.3 3.1V21H13z" />
    </svg>
  );
}

const TRIGGER_LABELS: Record<FlowConditionTrigger, string> = {
  replied: "they reply (any)",
  reply_interested: "they reply, interested",
  reply_objection: "they reply, objection",
  reply_not_interested: "they reply, not interested",
  reply_ooo: "they reply, out of office",
  bounced: "it bounces",
  // Retired: shown only if a stored graph still uses one (never offered anew).
  opened: "they open a message (retired)",
  clicked: "they click a link (retired)",
  manual: "a VA marks it (retired)",
};

// The triggers the builder OFFERS. We route on inbound signals only: replies
// (+ classifier sentiment) and bounces. opened/clicked need open/link tracking we
// deliberately never add (deliverability); manual has no automation: all retired.
const OFFERED_TRIGGERS: FlowConditionTrigger[] = [
  "replied",
  "reply_interested",
  "reply_objection",
  "reply_not_interested",
  "reply_ooo",
  "bounced",
];

type ElementKind = "email" | "wait" | "linkedin" | "internal" | "condition";

const PICKER: {
  group: string;
  items: { kind: ElementKind; label: string; hint: string; badge?: "Manual" | "Auto" }[];
}[] = [
  {
    group: "Outreach",
    items: [
      { kind: "email", label: "Email", hint: "Sends from the mailbox pool" },
      { kind: "linkedin", label: "LinkedIn touch", hint: "Manual task for the VA", badge: "Manual" },
    ],
  },
  {
    group: "Timing & logic",
    items: [
      { kind: "wait", label: "Wait", hint: "Delay before the next element" },
      { kind: "condition", label: "Condition", hint: "Split the path on reply / opened" },
    ],
  },
  {
    group: "Internal",
    items: [{ kind: "internal", label: "Notify a teammate", hint: "Slack / email a team member", badge: "Auto" }],
  },
];

function iconFor(kind: ElementKind) {
  switch (kind) {
    case "email":
      return <Mail size={16} />;
    case "linkedin":
      return <LinkedInGlyph size={16} />;
    case "wait":
      return <Clock size={16} />;
    case "condition":
      return <GitBranch size={16} />;
    case "internal":
      return <Bell size={16} />;
    default:
      return null;
  }
}

function makeNode(kind: ElementKind): FlowNode {
  switch (kind) {
    case "wait":
      return waitNode(3);
    case "linkedin":
      return linkedinNode("connect_request", "");
    case "internal":
      return internalNode("notify", "Notify the account manager");
    case "condition":
      return conditionNode("replied", [], []);
    case "email":
    default:
      return emailNode("", "");
  }
}

// Find a node by id anywhere in the tree (recursing into condition branches).
function findNode(nodes: FlowNode[], id: string): FlowNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === "condition") {
      const inYes = findNode(n.yes, id);
      if (inYes) return inYes;
      const inNo = findNode(n.no, id);
      if (inNo) return inNo;
    }
  }
  return null;
}

// First non-empty line of a body: the tile's one-line preview.
function firstLine(s: string): string {
  return (s || "")
    .split("\n")
    .map((x) => x.trim())
    .find(Boolean) ?? "";
}

const INTERNAL_ACTION_LABEL: Record<string, string> = {
  notify: "Notify a teammate (Slack / email)",
  task: "Create an internal task",
  webhook: "Fire a webhook",
};

const INSERT_TOKENS = ["{{first_name}}", "{{company}}", "{{title}}", "{{intro_line}}"];

// A/B/C… variant editor for an email node, as a compact ACCORDION. Variant A is
// the node's own subject/body (the fields above in the modal); this manages the
// extra variants (B, C…): each collapses to a one-line row and springs open to
// edit. Leads split evenly across all variants and we measure reply/positive-
// reply rate per one.
function EmailVariants({
  node,
  onChange,
  onAbConfigChange,
  isFirst,
  abAutoPauseDefault,
}: {
  node: EmailNode;
  onChange: (variants: EmailVariant[]) => void;
  onAbConfigChange: (cfg: EmailAbConfig | undefined) => void;
  isFirst: boolean;
  abAutoPauseDefault: boolean;
}) {
  const variants = node.variants ?? [];
  const [openVar, setOpenVar] = useState<string | null>(null);

  // Seed a new variant from A (same body; the common case is a subject-line test).
  const add = () => {
    const v = emailVariant(isFirst ? node.subject : "", node.body);
    onChange([...variants, v]);
    setOpenVar(v.id); // spring the new one open to fill it in
  };
  const update = (id: string, patch: Partial<EmailVariant>) =>
    onChange(variants.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const remove = (id: string) => {
    onChange(variants.filter((v) => v.id !== id));
    if (openVar === id) setOpenVar(null);
  };

  // Per-node auto-winner override: undefined = inherit the campaign default,
  // true/false = force on/off for THIS A/B step.
  const autoPause = node.ab_config?.autoPause;
  const autoPauseValue = autoPause === undefined ? "inherit" : autoPause ? "on" : "off";
  const setAutoPause = (v: string) => {
    const next: EmailAbConfig = { ...(node.ab_config ?? {}) };
    if (v === "inherit") delete next.autoPause;
    else next.autoPause = v === "on";
    onAbConfigChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div className={styles.field}>
      <div className={styles.abHead}>
        <label className={styles.label} style={{ margin: 0 }}>
          <GitBranch size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
          A/B test{variants.length > 0 ? ` · ${variants.length + 1} variants` : ""}
        </label>
        <button type="button" className={styles.addDashedSm} onClick={add}>
          <Plus size={13} /> Add variant
        </button>
      </div>
      {variants.length > 0 && (
        <p className={styles.hint} style={{ marginTop: 2 }}>
          Variant A is the email above. Leads split evenly across every variant; we
          measure reply &amp; positive-reply rate per variant.{" "}
          {isFirst ? "Each variant needs its own subject." : "A blank subject threads as “Re:”."}
        </p>
      )}
      {variants.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <label className={styles.label} style={{ margin: "0 0 3px" }}>
            Auto-winner
          </label>
          <select className={styles.select} value={autoPauseValue} onChange={(e) => setAutoPause(e.target.value)}>
            <option value="inherit">Use campaign default ({abAutoPauseDefault ? "auto-pause on" : "off"})</option>
            <option value="on">Auto-pause losers on</option>
            <option value="off">Off: decide manually</option>
          </select>
          <p className={styles.hint} style={{ marginTop: 2 }}>
            When on, once this test has the volume it pauses the losing variants (95% significance
            + a ≥1&nbsp;pt lead on positive-reply rate) so new leads route to the winner. Sticky:
            a lead already in a variant’s thread stays there.
          </p>
        </div>
      )}
      {variants.length > 0 && (
        <div className={styles.abAcc}>
          {variants.map((v, i) => {
            const label = String.fromCharCode(66 + i); // B, C, D…
            const open = openVar === v.id;
            const preview =
              v.subject.trim() || (isFirst ? "(add a subject)" : "Re: (threads on the first subject)");
            return (
              <div key={v.id} className={`${styles.abItem} ${open ? styles.abOpen : ""}`}>
                <div className={styles.abIRow} onClick={() => setOpenVar(open ? null : v.id)}>
                  <span className={styles.abK}>{label}</span>
                  <span className={styles.abIS}>{preview}</span>
                  <button
                    type="button"
                    className={`${styles.iconbtn} ${styles.danger}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(v.id);
                    }}
                    aria-label="Remove variant"
                  >
                    <Trash2 size={13} />
                  </button>
                  <ChevronDown size={15} className={`${styles.abChev} ${open ? styles.abChevOpen : ""}`} />
                </div>
                <div className={styles.abBW}>
                  <div className={styles.abBI}>
                    <div className={styles.abBody}>
                      <input
                        className={styles.input}
                        value={v.subject}
                        placeholder={isFirst ? "Subject for this variant" : "Subject (optional, blank threads as “Re:”)"}
                        onChange={(e) => update(v.id, { subject: e.target.value })}
                      />
                      <textarea
                        className={styles.textarea}
                        rows={5}
                        value={v.body}
                        placeholder="Body for this variant. {{first_name}} {{company}} …"
                        onChange={(e) => update(v.id, { body: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function FlowEditor({
  value,
  onChange,
  clientId,
  campaignId,
  abAutoPauseDefault = false,
}: {
  value: FlowGraph;
  onChange: (g: FlowGraph) => void;
  clientId?: string;
  campaignId?: string;
  /** Campaign-level A/B auto-pause default, shown as the per-node "inherit" state. */
  abAutoPauseDefault?: boolean;
}) {
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  // Which content node's editor MODAL is open (null = none). Only ever set from a
  // click handler, so the portal below is only rendered client-side (openId is
  // null through SSR + hydration): no document/SSR guard needed.
  const [openId, setOpenId] = useState<string | null>(null);
  // Email modal "expand" toggle: a wider, taller focused view. Sticky across
  // opens; only widens the email modal (the button lives only in its header).
  const [expanded, setExpanded] = useState(false);

  const primaryPath = flattenPrimaryPath(value.nodes);
  const firstEmail = primaryPath.find((n) => n.kind === "email") as EmailNode | undefined;
  const firstEmailId = firstEmail?.id ?? null;
  const firstEmailSubject = firstEmail?.subject.trim() ?? "";

  // ---- variable picker (Insert: chips) --------------------------------------
  // Custom variables this campaign defines (from the persisted registry), so an
  // author inserts only variables the list can actually fill. Standard chips are
  // always available. Refs + last-focused let a chip insert {{token}} at the
  // caret of whichever field (subject/body) the author last touched.
  const [customChips, setCustomChips] = useState<string[]>([]);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<"subject" | "body">("body");

  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(appUrl(`/api/campaigns/${campaignId}/client-import`));
        if (!res.ok) return;
        const data = (await res.json()) as {
          variables?: { token: string; kind: string }[];
        };
        if (cancelled) return;
        setCustomChips(
          (data.variables ?? [])
            .filter((v) => v.kind === "custom")
            .map((v) => `{{${v.token}}}`),
        );
      } catch {
        /* chips fall back to the standard defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  function insertToken(token: string) {
    if (!openId) return;
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
    patch(openId, { [field]: cur.slice(0, start) + token + cur.slice(end) });
    const caret = start + token.length;
    const target = el;
    // Restore focus + caret after the controlled re-render commits.
    setTimeout(() => {
      target.focus();
      target.setSelectionRange(caret, caret);
    }, 0);
  }

  const insertChips = [...new Set([...INSERT_TOKENS, ...customChips])];

  // Lock body scroll + wire Esc-to-close while the modal is open.
  useEffect(() => {
    if (!openId) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [openId]);

  // Click-drag panning of the (potentially wide) canvas. Ignores drags that
  // begin on a control / tile so text selection, clicks + tile-opens still work.
  const canvasRef = useRef<HTMLDivElement>(null);
  function onCanvasMouseDown(e: React.MouseEvent) {
    const el = canvasRef.current;
    if (!el || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('input,textarea,select,button,a,label,[role="menu"],[data-tile]')) return;
    // Clicking the empty canvas clears any active text selection. The mousedown
    // preventDefault() below (needed for click-drag panning) otherwise suppresses
    // the browser's native deselect, leaving a stale highlight behind.
    window.getSelection()?.removeAllRanges();
    const startX = e.clientX;
    const startY = e.clientY;
    const sl = el.scrollLeft;
    const st = el.scrollTop;
    el.style.cursor = "grabbing";
    el.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      el.scrollLeft = sl - (ev.clientX - startX);
      el.scrollTop = st - (ev.clientY - startY);
    };
    const up = () => {
      el.style.cursor = "";
      el.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    e.preventDefault();
  }

  const setNodes = (nodes: FlowNode[]) => onChange({ ...value, nodes });
  const patch = (id: string, p: Record<string, unknown>) => setNodes(updateNode(value.nodes, id, p));
  const del = (id: string) => {
    setNodes(removeNode(value.nodes, id));
    if (openId === id) setOpenId(null);
  };

  function addAt(key: string, kind: ElementKind) {
    const node = makeNode(kind);
    if (key === "top-end") {
      setNodes([...value.nodes, node]);
    } else if (key.includes(":")) {
      const [condId, branch] = key.split(":") as [string, "yes" | "no"];
      setNodes(appendToBranch(value.nodes, condId, branch, node));
    } else {
      setNodes(insertAfter(value.nodes, key, node));
    }
    // Open freshly-added content nodes in the modal so the user can fill them in.
    if (kind === "email" || kind === "linkedin" || kind === "internal") {
      setOpenId(node.id);
    }
    setOpenPicker(null);
  }

  function Picker({ pkey }: { pkey: string }) {
    return (
      <div className={styles.picker} role="menu">
        {PICKER.map((grp) => (
          <Fragment key={grp.group}>
            <p className={styles.pickH5}>{grp.group}</p>
            {grp.items.map((it) => {
              const tone =
                it.kind === "linkedin"
                  ? styles.tLi
                  : it.kind === "internal"
                    ? styles.tInt
                    : it.kind === "wait"
                      ? styles.tWait
                      : it.kind === "email"
                        ? styles.tEmail
                        : "";
              return (
                <button key={it.kind} type="button" className={styles.pickItem} onClick={() => addAt(pkey, it.kind)}>
                  <span
                    className={`${styles.chip28} ${tone}`}
                    style={it.kind === "condition" ? { background: "#eef2f7", color: "#475569" } : undefined}
                  >
                    {iconFor(it.kind)}
                  </span>
                  <span className={styles.pickT}>
                    <b>{it.label}</b>
                    <span>{it.hint}</span>
                  </span>
                  {it.badge && (
                    <span className={`${styles.pickBadge} ${it.badge === "Manual" ? styles.badgeManual : styles.badgeAuto}`}>
                      {it.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    );
  }

  function InsertPoint({ pkey }: { pkey: string }) {
    const open = openPicker === pkey;
    return (
      <div className={styles.insert}>
        <span className={styles.conn} />
        <button
          type="button"
          className={`${styles.insertBtn} ${open ? styles.open : ""}`}
          onClick={() => setOpenPicker(open ? null : pkey)}
          aria-label="Add element"
        >
          <Plus size={15} />
        </button>
        {open && <Picker pkey={pkey} />}
      </div>
    );
  }

  function AddDashed({ pkey }: { pkey: string }) {
    const open = openPicker === pkey;
    return (
      <div className={styles.insert}>
        <button
          type="button"
          className={`${styles.addDashed} ${open ? styles.open : ""}`}
          onClick={() => setOpenPicker(open ? null : pkey)}
        >
          <Plus size={15} /> Add element
        </button>
        {open && <Picker pkey={pkey} />}
      </div>
    );
  }

  // A compact "envelope" tile for a content node. Returns JSX inline (called,
  // not mounted as a component) so nothing about it re-mounts on edits.
  function renderTile(n: EmailNode | LinkedInNode | InternalNode) {
    let flapCls = styles.flapEmail;
    let chipCls = styles.tcEmail;
    let eyebrowCls = styles.kEmail;
    let eyebrow: string;
    let from: string;
    let title: string;
    let icon: React.ReactNode;
    let ghost = false;
    let variantCount = 0;

    if (n.kind === "email") {
      const isFirst = n.id === firstEmailId;
      const threaded = !isFirst && !n.subject.trim();
      eyebrow = isFirst ? "Email · first touch" : "Email · follow-up";
      from = "From the mailbox pool";
      title = isFirst
        ? n.subject.trim() || "(add a subject)"
        : n.subject.trim() || `Re: ${firstEmailSubject || "the first email"}`;
      ghost = threaded;
      variantCount = (n.variants?.length ?? 0) > 0 ? (n.variants?.length ?? 0) + 1 : 0;
      icon = <Mail size={12} />;
    } else if (n.kind === "linkedin") {
      flapCls = styles.flapLi;
      chipCls = styles.tcLi;
      eyebrowCls = styles.kLi;
      eyebrow = "LinkedIn · manual";
      from = "LinkedIn touch · manual";
      title = n.li_kind === "connect_request" ? "Connection request" : "Direct message";
      icon = <LinkedInGlyph size={12} />;
    } else {
      flapCls = styles.flapInt;
      chipCls = styles.tcInt;
      eyebrowCls = styles.kInt;
      eyebrow = "Internal · automation";
      from = "Runs inside the flow";
      title = n.label || "Notify a teammate";
      icon = <Bell size={12} />;
    }

    const preview =
      n.kind === "internal"
        ? INTERNAL_ACTION_LABEL[n.action] ?? n.action
        : firstLine(n.body) || "Empty, click to write";

    return (
      <div className={styles.tile} data-tile onClick={() => setOpenId(n.id)}>
        <div className={`${styles.flap} ${flapCls} ${ghost ? styles.flapThread : ""}`} />
        <div className={styles.tBody}>
          <div className={styles.tFrom}>
            <span className={`${styles.tChip} ${chipCls}`}>{icon}</span>
            <span className={eyebrowCls}>{eyebrow}</span>
            <span className={styles.tFromSep}>·</span>
            {from}
          </div>
          <div className={`${styles.tSubj} ${ghost ? styles.tSubjGhost : ""}`}>
            {ghost && <CornerDownRight size={13} />}
            {ghost ? <em>{title}</em> : title}
          </div>
          <div className={styles.tPrev}>{preview}</div>
        </div>
        <div className={styles.tFoot}>
          <div className={styles.tChips}>
            {variantCount > 1 && <span className={`${styles.mchip} ${styles.mchipAb}`}>A/B · {variantCount}</span>}
            {ghost && (
              <span className={`${styles.mchip} ${styles.mchipThread}`}>
                <CornerDownRight size={11} /> same thread
              </span>
            )}
            {n.kind === "linkedin" && <span className={styles.mchip}>Manual</span>}
          </div>
          <Maximize2 size={14} className={styles.tExpand} />
        </div>
      </div>
    );
  }

  function renderNode(n: FlowNode) {
    switch (n.kind) {
      case "email":
      case "linkedin":
      case "internal":
        return renderTile(n);
      case "wait":
        return (
          <div className={styles.waitWrap}>
            <span className={styles.waitChip}>
              <Clock size={14} /> Wait
              <input
                className={styles.waitInput}
                type="number"
                min={0}
                max={365}
                value={n.wait_days}
                onChange={(e) => patch(n.id, { wait_days: Math.max(0, Number(e.target.value) || 0) })}
              />
              days
              <button type="button" className={`${styles.iconbtn} ${styles.danger}`} onClick={() => del(n.id)} aria-label="Delete wait">
                <Trash2 size={13} />
              </button>
            </span>
          </div>
        );
      case "condition":
        return (
          <>
            <div className={styles.cond}>
              <div className={styles.condHead}>
                <span className={styles.condIc}>
                  <GitBranch size={15} />
                </span>
                <div className={styles.condBody}>
                  <span className={styles.condEyebrow}>Condition</span>
                  <select className={styles.condSel} value={n.trigger} onChange={(e) => patch(n.id, { trigger: e.target.value })}>
                    {OFFERED_TRIGGERS.map((k) => (
                      <option key={k} value={k}>
                        If {TRIGGER_LABELS[k]}
                      </option>
                    ))}
                    {/* A stored graph on a retired trigger keeps showing it (so it can be re-picked). */}
                    {!OFFERED_TRIGGERS.includes(n.trigger) && (
                      <option value={n.trigger}>If {TRIGGER_LABELS[n.trigger]}</option>
                    )}
                  </select>
                </div>
                <button type="button" className={`${styles.iconbtn} ${styles.danger}`} onClick={() => del(n.id)} aria-label="Delete condition">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className={styles.outs}>
                <span className={styles.outY}>Yes</span>
                <span className={styles.outN}>No</span>
              </div>
              {isUntrackedTrigger(n.trigger) && (
                <p
                  style={{
                    margin: "8px 10px 2px",
                    fontSize: 11.5,
                    lineHeight: 1.4,
                    color: "#b45309",
                    background: "#fffbeb",
                    border: "1px solid #fde68a",
                    borderRadius: 6,
                    padding: "6px 8px",
                  }}
                >
                  <b>Retired trigger.</b> We don’t track opens or clicks: it hurts
                  deliverability, so this can’t fire; everyone follows the{" "}
                  <b>No</b> path. Switch to a reply- or bounce-based condition.
                </p>
              )}
            </div>
            <div className={styles.fork}>
              <div className={styles.arm}>
                <span className={`${styles.armChip} ${styles.armYes}`}>Yes</span>
                {renderSequence(n.yes, `${n.id}:yes`)}
              </div>
              <div className={styles.arm}>
                <span className={`${styles.armChip} ${styles.armNo}`}>No</span>
                {renderSequence(n.no, `${n.id}:no`)}
              </div>
            </div>
          </>
        );
      default:
        return null;
    }
  }

  function renderSequence(nodes: FlowNode[], endKey: string) {
    if (nodes.length === 0) return <AddDashed pkey={endKey} />;
    return (
      <div className={styles.seq}>
        {nodes.map((n) => (
          <Fragment key={n.id}>
            {renderNode(n)}
            {n.kind !== "condition" && <InsertPoint pkey={n.id} />}
          </Fragment>
        ))}
      </div>
    );
  }

  // ---- the compose MODAL for the open content node --------------------------
  // Returns a portal (rendered inline via a call, so its inputs keep focus while
  // typing). Instant open, viewport-centered, contained.
  function renderModal(n: EmailNode | LinkedInNode | InternalNode) {
    let head: React.ReactNode;
    let body: React.ReactNode;

    if (n.kind === "email") {
      const isFirst = n.id === firstEmailId;
      const hasSubject = n.subject.trim().length > 0;
      const titleText = isFirst
        ? n.subject.trim() || "Email · first touch"
        : n.subject.trim() || `Re: ${firstEmailSubject || "the first email"}`;
      head = (
        <div className={styles.mHead}>
          <span className={`${styles.mChip} ${styles.tcEmail}`}>
            <Mail size={15} />
          </span>
          <div className={styles.mHeadText}>
            <div className={`${styles.mEyebrow} ${styles.kEmail}`}>{isFirst ? "Email · first touch" : "Email · follow-up"}</div>
            <div className={styles.mTitle}>{titleText}</div>
          </div>
          <button
            type="button"
            className={styles.mClose}
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Shrink email editor" : "Expand email editor"}
            title={expanded ? "Shrink" : "Expand"}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" className={styles.mClose} onClick={() => setOpenId(null)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      );
      body = (
        <div className={styles.mBody}>
          <div className={styles.field}>
            <label className={styles.label}>{isFirst ? "Subject line" : "Subject (optional)"}</label>
            <div className={styles.subjWrap}>
              <input
                ref={subjectRef}
                className={`${styles.input} ${!isFirst ? styles.ghostable : ""}`}
                value={n.subject}
                placeholder={
                  isFirst ? "Quick question, {{first_name}}" : `Re: ${firstEmailSubject || "the first email’s subject"}`
                }
                onFocus={() => (lastFocused.current = "subject")}
                onChange={(e) => patch(n.id, { subject: e.target.value })}
              />
              {!isFirst && (
                <span className={`${styles.threadTag} ${hasSubject ? styles.threadNew : styles.threadSame}`}>
                  <CornerDownRight size={13} /> {hasSubject ? "new thread" : "same thread"}
                </span>
              )}
            </div>
            {!isFirst && (
              <p className={styles.threadHelp}>
                {hasSubject ? (
                  <>
                    Custom subject: this email starts a <b>new thread</b>. Clear it to fall back to the
                    first email’s thread.
                  </>
                ) : (
                  <>
                    Leave blank to stay on the <b>first email’s thread</b>: the recipient sees it as a
                    reply, no new subject line.
                  </>
                )}
              </p>
            )}
          </div>
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
          {(() => {
            // Flag copy tokens with no mapped contact column: under the
            // columns-drive-variables model they never register a variable and
            // send blank. Mirrors the import panel's warning, at authoring time.
            const mapped = new Set(customChips.map((c) => normalizeVarKey(c.replace(/[{}]/g, ""))));
            const unmapped = extractCampaignTokens([n.subject, n.body]).custom.filter((t) => !mapped.has(t.key));
            if (unmapped.length === 0) return null;
            return (
              <p
                style={{
                  margin: "0 0 2px", fontSize: "11.5px", lineHeight: 1.45,
                  color: "#8a5a0b", background: "#f6eddc",
                  border: "1px solid #e6d3a3", borderRadius: 7, padding: "6px 10px",
                }}
              >
                Not mapped to a contact column:{" "}
                <b>{unmapped.map((t) => `{{${t.token}}}`).join(", ")}</b>: map a column when you
                import contacts, or these send blank.
              </p>
            );
          })()}
          <div className={styles.field}>
            <label className={styles.label}>Body</label>
            <textarea
              ref={bodyRef}
              className={styles.textarea}
              rows={9}
              style={expanded ? { minHeight: 360 } : undefined}
              value={n.body}
              placeholder="Plain text. Placeholders: {{first_name}} {{company}} {{title}} {{intro_line}}"
              onFocus={() => (lastFocused.current = "body")}
              onChange={(e) => patch(n.id, { body: e.target.value })}
            />
            <StepCopyCheck
              subject={isFirst ? n.subject : ""}
              body={n.body}
              clientId={clientId}
              campaignId={campaignId}
              isFirstStep={isFirst}
              onApplySpintax={(nv) =>
                patch(n.id, {
                  ...(isFirst && nv.subject !== null ? { subject: nv.subject } : {}),
                  body: nv.body,
                })
              }
            />
          </div>
          <EmailVariants
            node={n}
            isFirst={isFirst}
            abAutoPauseDefault={abAutoPauseDefault}
            onChange={(variants) => patch(n.id, { variants })}
            onAbConfigChange={(ab_config) => patch(n.id, { ab_config })}
          />
        </div>
      );
    } else if (n.kind === "linkedin") {
      head = (
        <div className={styles.mHead}>
          <span className={`${styles.mChip} ${styles.tcLi}`}>
            <LinkedInGlyph size={15} />
          </span>
          <div className={styles.mHeadText}>
            <div className={`${styles.mEyebrow} ${styles.kLi}`}>LinkedIn · manual</div>
            <div className={styles.mTitle}>{n.li_kind === "connect_request" ? "Connection request" : "Direct message"}</div>
          </div>
          <button type="button" className={styles.mClose} onClick={() => setOpenId(null)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      );
      body = (
        <div className={styles.mBody}>
          <div className={styles.field}>
            <label className={styles.label}>Action</label>
            <select className={styles.select} value={n.li_kind} onChange={(e) => patch(n.id, { li_kind: e.target.value })}>
              <option value="connect_request">Connection request</option>
              <option value="message">Direct message</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Note / message (the VA sends this by hand)</label>
            <textarea
              className={styles.textarea}
              rows={4}
              value={n.body}
              placeholder="Hi {{first_name}}: saw your work at {{company}}…"
              onChange={(e) => patch(n.id, { body: e.target.value })}
            />
          </div>
          <p className={styles.hint}>Manual for now: shows up as a VA task; it doesn’t send automatically.</p>
        </div>
      );
    } else {
      head = (
        <div className={styles.mHead}>
          <span className={`${styles.mChip} ${styles.tcInt}`}>
            <Bell size={15} />
          </span>
          <div className={styles.mHeadText}>
            <div className={`${styles.mEyebrow} ${styles.kInt}`}>Internal · automation</div>
            <div className={styles.mTitle}>{n.label || "Notify a teammate"}</div>
          </div>
          <button type="button" className={styles.mClose} onClick={() => setOpenId(null)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      );
      body = (
        <div className={styles.mBody}>
          <div className={styles.field}>
            <label className={styles.label}>Action</label>
            <select className={styles.select} value={n.action} onChange={(e) => patch(n.id, { action: e.target.value })}>
              <option value="notify">Notify a teammate (Slack / email)</option>
              <option value="task">Create an internal task</option>
              <option value="webhook">Fire a webhook</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Details</label>
            <input
              className={styles.input}
              value={n.label}
              placeholder="e.g. Ping the account manager in Slack"
              onChange={(e) => patch(n.id, { label: e.target.value })}
            />
          </div>
          <p className={styles.hint}>Runs when the flow reaches this point: doesn’t touch sending.</p>
        </div>
      );
    }

    return createPortal(
      <>
        <div className={styles.backdrop} onClick={() => setOpenId(null)} />
        <div
          className={`${styles.modal} ${expanded && n.kind === "email" ? styles.modalWide : ""}`}
          role="dialog"
          aria-modal="true"
        >
          {head}
          {body}
          <div className={styles.mFoot}>
            <button type="button" className={styles.mDelete} onClick={() => del(n.id)}>
              <Trash2 size={14} /> Delete step
            </button>
            <div style={{ flex: 1 }} />
            <button type="button" className={styles.mDone} onClick={() => setOpenId(null)}>
              Done
            </button>
          </div>
        </div>
      </>,
      document.body,
    );
  }

  const openNode = openId ? findNode(value.nodes, openId) : null;
  const modalNode =
    openNode && (openNode.kind === "email" || openNode.kind === "linkedin" || openNode.kind === "internal")
      ? openNode
      : null;

  return (
    <div className={styles.editor}>
      <div className={styles.canvas} ref={canvasRef} onMouseDown={onCanvasMouseDown}>
        <div className={styles.spine}>
          <div className={`${styles.terminus} ${styles.terminusStart}`}>Lead enrolled</div>
          <span className={styles.conn} />
          {renderSequence(value.nodes, "top-end")}
        </div>
      </div>
      {modalNode && renderModal(modalNode)}
    </div>
  );
}
