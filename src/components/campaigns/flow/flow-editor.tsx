"use client";

// FlowEditor — the visual branching sequence editor. Renders a FlowGraph as a
// centered spine on a dotted canvas: element cards with insert points, every
// condition forked into yes/no arms (nested sequences). Content nodes
// (email/linkedin/internal) collapse to a compact row and expand to edit.
// Controlled: the parent owns the graph and passes value + onChange. Email/wait
// are the executed path today; linkedin/internal/condition are authored +
// persisted but don't run yet.

import { Fragment, useRef, useState } from "react";
import { Mail, Clock, Plus, Trash2, GitBranch, Bell, ChevronDown } from "lucide-react";
import {
  type FlowGraph,
  type FlowNode,
  type FlowConditionTrigger,
  type EmailNode,
  type EmailVariant,
  type EmailAbConfig,
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

// A/B/C… variant editor for an email node. Variant A is the node's own
// subject/body (the fields above); this manages the extra variants. Leads split
// evenly across all variants and we measure reply/positive-reply rate per one.
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
  // Seed a new variant from A (same body; the common case is a subject-line test).
  const add = () => onChange([...variants, emailVariant(isFirst ? node.subject : "", node.body)]);
  const update = (id: string, patch: Partial<EmailVariant>) =>
    onChange(variants.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const remove = (id: string) => onChange(variants.filter((v) => v.id !== id));

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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label className={styles.label} style={{ margin: 0 }}>
          A/B test{variants.length > 0 ? ` · ${variants.length + 1} variants` : ""}
        </label>
        <button
          type="button"
          className={styles.addDashed}
          style={{ padding: "3px 8px", fontSize: 12, width: "auto" }}
          onClick={add}
        >
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
          <select
            className={styles.input}
            value={autoPauseValue}
            onChange={(e) => setAutoPause(e.target.value)}
          >
            <option value="inherit">
              Use campaign default ({abAutoPauseDefault ? "auto-pause on" : "off"})
            </option>
            <option value="on">Auto-pause losers on</option>
            <option value="off">Off — decide manually</option>
          </select>
          <p className={styles.hint} style={{ marginTop: 2 }}>
            When on, once this test has the volume it pauses the losing variants (95% significance
            + a ≥1&nbsp;pt lead on positive-reply rate) so new leads route to the winner. Sticky:
            a lead already in a variant’s thread stays there.
          </p>
        </div>
      )}
      {variants.map((v, i) => (
        <div
          key={v.id}
          style={{ marginTop: 8, border: "1px solid #e2e8f0", borderRadius: 8, padding: 10 }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>
              Variant {String.fromCharCode(66 + i)}
            </span>
            <button
              type="button"
              className={`${styles.iconbtn} ${styles.danger}`}
              onClick={() => remove(v.id)}
              aria-label="Remove variant"
            >
              <Trash2 size={13} />
            </button>
          </div>
          <input
            className={styles.input}
            value={v.subject}
            placeholder={isFirst ? "Subject for this variant" : "Subject (optional — blank threads as “Re:”)"}
            onChange={(e) => update(v.id, { subject: e.target.value })}
            style={{ marginBottom: 6 }}
          />
          <textarea
            className={styles.textarea}
            rows={4}
            value={v.body}
            placeholder="Body for this variant. {{first_name}} {{company}} …"
            onChange={(e) => update(v.id, { body: e.target.value })}
          />
        </div>
      ))}
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

  const firstEmailId = flattenPrimaryPath(value.nodes).find((n) => n.kind === "email")?.id ?? null;
  // Start with the first email open for editing; everything else collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    firstEmailId ? new Set([firstEmailId]) : new Set(),
  );

  // Click-drag panning of the (potentially wide) canvas. Ignores drags that
  // begin on a control so text selection / clicks still work.
  const canvasRef = useRef<HTMLDivElement>(null);
  function onCanvasMouseDown(e: React.MouseEvent) {
    const el = canvasRef.current;
    if (!el || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('input,textarea,select,button,a,label,[role="menu"]')) return;
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
  const del = (id: string) => setNodes(removeNode(value.nodes, id));
  const toggleExp = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
    // Open freshly-added content nodes so the user can fill them in.
    if (kind === "email" || kind === "linkedin" || kind === "internal") {
      setExpanded((prev) => new Set(prev).add(node.id));
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

  // Header for a collapsible content node (email / linkedin / internal).
  function NodeHead({
    id,
    idxClass,
    icon,
    eyebrowClass,
    eyebrow,
    title,
    exp,
  }: {
    id: string;
    idxClass: string;
    icon: React.ReactNode;
    eyebrowClass: string;
    eyebrow: string;
    title: string;
    exp: boolean;
  }) {
    return (
      <div className={`${styles.head} ${styles.headClickable}`} onClick={() => toggleExp(id)}>
        <span className={`${styles.idx} ${idxClass}`}>{icon}</span>
        <div className={styles.titleWrap}>
          <div className={`${styles.titleK} ${eyebrowClass}`}>{eyebrow}</div>
          <div className={styles.titleS}>{title}</div>
        </div>
        <div className={styles.acts}>
          <button
            type="button"
            className={`${styles.iconbtn} ${styles.danger}`}
            onClick={(e) => {
              e.stopPropagation();
              del(id);
            }}
            aria-label="Delete step"
          >
            <Trash2 size={14} />
          </button>
          <ChevronDown size={16} className={`${styles.chev} ${exp ? styles.chevOpen : ""}`} />
        </div>
      </div>
    );
  }

  function renderNode(n: FlowNode) {
    switch (n.kind) {
      case "email": {
        const isFirst = n.id === firstEmailId;
        const exp = expanded.has(n.id);
        return (
          <div className={styles.card}>
            <NodeHead
              id={n.id}
              idxClass={styles.idxEmail}
              icon={<Mail size={14} />}
              eyebrowClass={styles.kEmail}
              eyebrow={isFirst ? "Email · first" : "Email · follow-up"}
              title={n.subject || (isFirst ? "(add a subject)" : "Re: (threads on the first subject)")}
              exp={exp}
            />
            {exp && (
              <div className={styles.body}>
                <div className={styles.field}>
                  <label className={styles.label}>{isFirst ? "Subject line" : "Subject (optional — threads as “Re:”)"}</label>
                  <input
                    className={styles.input}
                    value={n.subject}
                    placeholder={isFirst ? "Quick question, {{first_name}}" : "Leave blank to thread on the first subject"}
                    onChange={(e) => patch(n.id, { subject: e.target.value })}
                  />
                </div>
                <div className={styles.varRow}>
                  <span className={styles.varLbl}>Insert:</span>
                  {["{{first_name}}", "{{company}}", "{{title}}", "{{intro_line}}"].map((v) => (
                    <span key={v} className={styles.varChip}>
                      {v}
                    </span>
                  ))}
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Body</label>
                  <textarea
                    className={styles.textarea}
                    rows={7}
                    value={n.body}
                    placeholder="Plain text. Placeholders: {{first_name}} {{company}} {{title}} {{intro_line}}"
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
            )}
          </div>
        );
      }
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
      case "linkedin": {
        const exp = expanded.has(n.id);
        return (
          <div className={styles.card}>
            <NodeHead
              id={n.id}
              idxClass={styles.idxLi}
              icon={<LinkedInGlyph size={14} />}
              eyebrowClass={styles.kLi}
              eyebrow="LinkedIn · manual"
              title={n.li_kind === "connect_request" ? "Connection request" : "Direct message"}
              exp={exp}
            />
            {exp && (
              <div className={styles.body}>
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
                    rows={3}
                    value={n.body}
                    placeholder="Hi {{first_name}} — saw your work at {{company}}…"
                    onChange={(e) => patch(n.id, { body: e.target.value })}
                  />
                </div>
                <p className={styles.hint}>Manual for now — shows up as a VA task; it doesn’t send automatically.</p>
              </div>
            )}
          </div>
        );
      }
      case "internal": {
        const exp = expanded.has(n.id);
        return (
          <div className={styles.card}>
            <NodeHead
              id={n.id}
              idxClass={styles.idxInt}
              icon={<Bell size={14} />}
              eyebrowClass={styles.kInt}
              eyebrow="Internal · automation"
              title={n.label || "Notify a teammate"}
              exp={exp}
            />
            {exp && (
              <div className={styles.body}>
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
            )}
          </div>
        );
      }
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

  return (
    <div className={styles.editor}>
      <div className={styles.canvas} ref={canvasRef} onMouseDown={onCanvasMouseDown}>
        <div className={styles.spine}>
          <div className={`${styles.terminus} ${styles.terminusStart}`}>Lead enrolled</div>
          <span className={styles.conn} />
          {renderSequence(value.nodes, "top-end")}
        </div>
      </div>
    </div>
  );
}
