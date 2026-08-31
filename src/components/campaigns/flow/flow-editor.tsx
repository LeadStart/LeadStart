"use client";

// FlowEditor — the visual branching sequence editor. Renders a FlowGraph as a
// centered spine on a dotted canvas: compact "envelope" tiles for content nodes
// (email/linkedin/internal), wait chips, and every condition forked into yes/no
// arms (nested sequences). Clicking a content tile opens a centered compose
// MODAL (instant, viewport-centered, contained) to edit it — the tiles stay a
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
  type EmailAbConfig,
  type LinkedInNode,
  type InternalNode,
  type ResolvedVariant,
  emailNode,
  emailVariant,
  emailVariants,
  waitNode,
  linkedinNode,
  internalNode,
  conditionNode,
  flattenPrimaryPath,
  walkAll,
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
  reply_interested: "they reply — interested",
  reply_objection: "they reply — objection",
  reply_not_interested: "they reply — not interested",
  reply_ooo: "they reply — out of office",
  bounced: "it bounces",
  // Retired — shown only if a stored graph still uses one (never offered anew).
  opened: "they open a message (retired)",
  clicked: "they click a link (retired)",
  manual: "a VA marks it (retired)",
};

// The triggers the builder OFFERS. We route on inbound signals only — replies
// (+ classifier sentiment) and bounces. opened/clicked need open/link tracking we
// deliberately never add (deliverability); manual has no automation — all retired.
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

// Resolve a clicked variant id to its owning email node. A variant id is the
// node id for variant A, or an EmailVariant.id for B/C/…, so this covers both the
// tile you click and the id stored in `openId` while its modal is open.
function findEmailForVariant(
  nodes: FlowNode[],
  id: string,
): { node: EmailNode; variantId: string } | null {
  let found: { node: EmailNode; variantId: string } | null = null;
  walkAll(nodes, (n) => {
    if (found || n.kind !== "email") return;
    if (n.id === id) {
      found = { node: n, variantId: n.id };
      return;
    }
    for (const v of n.variants ?? []) {
      if (v.id === id) {
        found = { node: n, variantId: v.id };
        break;
      }
    }
  });
  return found;
}

// First non-empty line of a body — the tile's one-line preview.
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
  // null through SSR + hydration) — no document/SSR guard needed.
  const [openId, setOpenId] = useState<string | null>(null);
  // Email modal "expand" toggle — a wider, taller focused view. Sticky across
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
    // Subject/body fields live only in the email modal; resolve which variant
    // (A = the node itself, B/C/… = node.variants) is open so the token lands on it.
    const owner = findEmailForVariant(value.nodes, openId);
    if (!owner) return;
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
    const next = cur.slice(0, start) + token + cur.slice(end);
    patchVariant(owner.node, owner.variantId, field === "subject" ? { subject: next } : { body: next });
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

  // Edit ONE variant of an email node. Variant A is the node's own subject/body
  // (variantId === node.id); B/C/… live in node.variants. Both write back through
  // patch(), so the persisted shape the sender reads (EmailNode.variants) never
  // changes: this is a pure authoring-UI move off the old modal accordion.
  const patchVariant = (node: EmailNode, variantId: string, p: { subject?: string; body?: string }) => {
    if (variantId === node.id) {
      patch(node.id, p);
      return;
    }
    const variants = (node.variants ?? []).map((v) => (v.id === variantId ? { ...v, ...p } : v));
    patch(node.id, { variants });
  };

  // Append a fresh variant (seeded from A, the common subject-line test) and open
  // it. Turns a lone email into an A/B row; on the first email each variant keeps
  // its own subject, on a follow-up a blank subject threads as "Re:".
  const addVariant = (node: EmailNode, isFirst: boolean) => {
    const v = emailVariant(isFirst ? node.subject : "", node.body);
    patch(node.id, { variants: [...(node.variants ?? []), v] });
    setOpenId(v.id);
  };

  // Remove one B/C/… variant (never A: deleting A deletes the whole step).
  const removeVariant = (node: EmailNode, variantId: string) => {
    patch(node.id, { variants: (node.variants ?? []).filter((v) => v.id !== variantId) });
    if (openId === variantId) setOpenId(null);
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

  // The chosen node style: a dark navy header (channel-tinted icon chip + eyebrow +
  // the subject in white) over a white body area, with no top flap. Shared by every
  // content node so email / linkedin / internal read as one species. Returned
  // inline (called, not mounted) so nothing re-mounts on edits.
  function contentTile(opts: {
    key?: string;
    chipCls: string;
    icon: React.ReactNode;
    eyebrow: string;
    title: string;
    ghost?: boolean;
    preview: string;
    letter?: string;
    onOpen: () => void;
    footLeft?: React.ReactNode;
  }) {
    const { chipCls, icon, eyebrow, title, ghost, preview, letter, onOpen, footLeft } = opts;
    return (
      <div className={styles.tile} data-tile onClick={onOpen} key={opts.key}>
        <div className={styles.tHead}>
          <div className={styles.tHeadTop}>
            <span className={`${styles.tChip} ${chipCls}`}>{icon}</span>
            <span className={styles.tEyebrow}>{eyebrow}</span>
            {letter && <span className={styles.tLetter}>{letter}</span>}
          </div>
          <div className={`${styles.tHeadSubj} ${ghost ? styles.tHeadSubjGhost : ""}`}>
            {ghost && <CornerDownRight size={13} />}
            {ghost ? <em>{title}</em> : title}
          </div>
        </div>
        <div className={styles.tBody}>
          <div className={styles.tPrev}>{preview}</div>
        </div>
        <div className={styles.tFoot}>
          <div className={styles.tChips}>{footLeft}</div>
          <Maximize2 size={14} className={styles.tExpand} />
        </div>
      </div>
    );
  }

  // LinkedIn / internal tiles (single, no variants).
  function renderTile(n: LinkedInNode | InternalNode) {
    if (n.kind === "linkedin") {
      return contentTile({
        chipCls: styles.tcLi,
        icon: <LinkedInGlyph size={12} />,
        eyebrow: "LinkedIn · manual",
        title: n.li_kind === "connect_request" ? "Connection request" : "Direct message",
        preview: firstLine(n.body) || "Click to write",
        onOpen: () => setOpenId(n.id),
        footLeft: <span className={styles.mchip}>Manual</span>,
      });
    }
    return contentTile({
      chipCls: styles.tcInt,
      icon: <Bell size={12} />,
      eyebrow: "Internal · automation",
      title: n.label || "Notify a teammate",
      preview: INTERNAL_ACTION_LABEL[n.action] ?? n.action,
      onOpen: () => setOpenId(n.id),
    });
  }

  // An email step. Its A/B/C… variants render as SIBLING tiles on ONE horizontal
  // row (A = the node's own subject/body; B/C… = node.variants). A lone email is a
  // single tile with a "+ A/B variant" affordance. Variants are managed here on the
  // canvas; the compose modal edits one variant at a time.
  function renderEmailStep(n: EmailNode) {
    const isFirst = n.id === firstEmailId;
    const variants = emailVariants(n); // [{ id, label, subject, body, paused }] (A first)

    const tileFor = (v: ResolvedVariant, showLetter: boolean, footExtra?: React.ReactNode) => {
      const threaded = !isFirst && !v.subject.trim();
      const title = isFirst
        ? v.subject.trim() || "(add a subject)"
        : v.subject.trim() || `Re: ${firstEmailSubject || "the first email"}`;
      return contentTile({
        key: v.id,
        chipCls: styles.tcEmail,
        icon: <Mail size={12} />,
        eyebrow: isFirst ? "Email · first touch" : "Email · follow-up",
        title,
        ghost: threaded,
        preview: firstLine(v.body) || "Click to write",
        letter: showLetter ? v.label : undefined,
        onOpen: () => setOpenId(v.id),
        footLeft: (
          <>
            {threaded && (
              <span className={`${styles.mchip} ${styles.mchipThread}`}>
                <CornerDownRight size={11} /> same thread
              </span>
            )}
            {footExtra}
          </>
        ),
      });
    };

    // Lone email → a single tile with an inline "add A/B variant".
    if (variants.length === 1) {
      return tileFor(
        variants[0],
        false,
        <button
          type="button"
          className={styles.addVarBtn}
          onClick={(e) => {
            e.stopPropagation();
            addVariant(n, isFirst);
          }}
        >
          <Plus size={12} /> A/B variant
        </button>,
      );
    }

    // A/B row → a group header (with this step's auto-winner) + one tile per variant.
    const autoPause = n.ab_config?.autoPause;
    const autoPauseValue = autoPause === undefined ? "inherit" : autoPause ? "on" : "off";
    const setAutoPause = (val: string) => {
      const next: EmailAbConfig = { ...(n.ab_config ?? {}) };
      if (val === "inherit") delete next.autoPause;
      else next.autoPause = val === "on";
      patch(n.id, { ab_config: Object.keys(next).length > 0 ? next : undefined });
    };

    return (
      <div className={styles.abStep}>
        <div className={styles.abStepHead}>
          <span className={styles.lbl}>
            <GitBranch size={14} /> A/B test · {variants.length} variants
            <span className={styles.split}>· splits evenly</span>
          </span>
          <span className={styles.abWinnerWrap}>
            Auto-winner
            <select
              className={styles.abWinnerSel}
              value={autoPauseValue}
              onChange={(e) => setAutoPause(e.target.value)}
            >
              <option value="inherit">Campaign default ({abAutoPauseDefault ? "on" : "off"})</option>
              <option value="on">Auto-pause losers on</option>
              <option value="off">Off (decide manually)</option>
            </select>
          </span>
        </div>
        <div className={styles.vrow}>
          {variants.map((v) => tileFor(v, true))}
          <div className={styles.vadd} data-tile onClick={() => addVariant(n, isFirst)}>
            <span className={styles.pl}>
              <Plus size={16} />
            </span>
            Add variant
          </div>
        </div>
      </div>
    );
  }

  function renderNode(n: FlowNode) {
    switch (n.kind) {
      case "email":
        return renderEmailStep(n);
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
                  <b>Retired trigger.</b> We don’t track opens or clicks — it hurts
                  deliverability — so this can’t fire; everyone follows the{" "}
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
  function renderModal(n: EmailNode | LinkedInNode | InternalNode, variantId?: string) {
    let head: React.ReactNode;
    let body: React.ReactNode;

    if (n.kind === "email") {
      const isFirst = n.id === firstEmailId;
      const vid = variantId ?? n.id;
      const isA = vid === n.id;
      // The variant being edited: A is the node's own subject/body; B/C/… come from
      // node.variants. Both write back via patchVariant() so the stored shape holds.
      const cur = isA
        ? { subject: n.subject, body: n.body }
        : (n.variants ?? []).find((v) => v.id === vid) ?? { subject: "", body: "" };
      const hasExtras = (n.variants?.length ?? 0) > 0;
      const vLabel = emailVariants(n).find((v) => v.id === vid)?.label ?? "A";
      const hasSubject = cur.subject.trim().length > 0;
      const titleText = isFirst
        ? cur.subject.trim() || "Email · first touch"
        : cur.subject.trim() || `Re: ${firstEmailSubject || "the first email"}`;
      head = (
        <div className={styles.mHead}>
          <span className={`${styles.mChip} ${styles.tcEmail}`}>
            <Mail size={15} />
          </span>
          <div className={styles.mHeadText}>
            <div className={`${styles.mEyebrow} ${styles.kEmail}`}>
              {isFirst ? "Email · first touch" : "Email · follow-up"}
              {hasExtras ? ` · Variant ${vLabel}` : ""}
            </div>
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
                value={cur.subject}
                placeholder={
                  isFirst ? "Quick question, {{first_name}}" : `Re: ${firstEmailSubject || "the first email’s subject"}`
                }
                onFocus={() => (lastFocused.current = "subject")}
                onChange={(e) => patchVariant(n, vid, { subject: e.target.value })}
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
                    Custom subject, so this email starts a <b>new thread</b>. Clear it to fall back to the
                    first email’s thread.
                  </>
                ) : (
                  <>
                    Leave blank to stay on the <b>first email’s thread</b>; the recipient sees it as a
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
            const unmapped = extractCampaignTokens([cur.subject, cur.body]).custom.filter((t) => !mapped.has(t.key));
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
                <b>{unmapped.map((t) => `{{${t.token}}}`).join(", ")}</b>. Map a column when you
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
              value={cur.body}
              placeholder="Plain text. Placeholders: {{first_name}} {{company}} {{title}} {{intro_line}}"
              onFocus={() => (lastFocused.current = "body")}
              onChange={(e) => patchVariant(n, vid, { body: e.target.value })}
            />
            <StepCopyCheck
              subject={isFirst ? cur.subject : ""}
              body={cur.body}
              clientId={clientId}
              campaignId={campaignId}
              isFirstStep={isFirst}
              onApplySpintax={(nv) =>
                patchVariant(n, vid, {
                  ...(isFirst && nv.subject !== null ? { subject: nv.subject } : {}),
                  body: nv.body,
                })
              }
            />
          </div>
          {/* A/B variants live as sibling nodes on the canvas now; no accordion here. */}
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
              placeholder="Hi {{first_name}} — saw your work at {{company}}…"
              onChange={(e) => patch(n.id, { body: e.target.value })}
            />
          </div>
          <p className={styles.hint}>Manual for now — shows up as a VA task; it doesn’t send automatically.</p>
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
          <p className={styles.hint}>Runs when the flow reaches this point — doesn’t touch sending.</p>
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
            <button
              type="button"
              className={styles.mDelete}
              onClick={() =>
                n.kind === "email" && variantId && variantId !== n.id
                  ? removeVariant(n, variantId)
                  : del(n.id)
              }
            >
              <Trash2 size={14} />{" "}
              {n.kind === "email" && variantId && variantId !== n.id ? "Delete variant" : "Delete step"}
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

  // Resolve the open modal target. openId is a node id (linkedin / internal, or
  // email variant A) or a B/C/… variant id; findEmailForVariant maps the latter
  // back to its owning email node so the modal edits the right variant.
  const openDirect = openId ? findNode(value.nodes, openId) : null;
  const openVariant = openId && !openDirect ? findEmailForVariant(value.nodes, openId) : null;
  const modalNode: EmailNode | LinkedInNode | InternalNode | null = openVariant
    ? openVariant.node
    : openDirect &&
        (openDirect.kind === "email" || openDirect.kind === "linkedin" || openDirect.kind === "internal")
      ? openDirect
      : null;
  const modalVariantId = openVariant
    ? openVariant.variantId
    : modalNode && modalNode.kind === "email"
      ? modalNode.id
      : undefined;

  return (
    <div className={styles.editor}>
      <div className={styles.canvas} ref={canvasRef} onMouseDown={onCanvasMouseDown}>
        <div className={styles.spine}>
          <div className={`${styles.terminus} ${styles.terminusStart}`}>Lead enrolled</div>
          <span className={styles.conn} />
          {renderSequence(value.nodes, "top-end")}
        </div>
      </div>
      {modalNode && renderModal(modalNode, modalVariantId)}
    </div>
  );
}
