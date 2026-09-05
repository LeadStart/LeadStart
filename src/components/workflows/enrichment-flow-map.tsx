"use client";

// Enrichment Flow Map: the two prospecting veins (LinkedIn + Maps) drawn as
// branching decision graphs on the SAME dotted, grab-to-pan canvas as the
// campaign flow editor. The diagram CONTENT + costs live in ./enrichment-flow-
// map.data.ts (wired to the live pricing/config constants + guarded by
// scripts/test-flow-map-sync.ts); this file is presentation only: colours,
// fonts, SVG rendering, and the drag-to-pan behaviour.

import { useRef } from "react";
import styles from "./enrichment-flow-map.module.css";
import {
  type FlowNode,
  type FlowEdge,
  type Tone,
  type LineStyle,
  LI_NODES,
  LI_EDGES,
  MAPS_NODES,
  MAPS_EDGES,
} from "./enrichment-flow-map.data";

const TONE: Record<Tone, { fill: string; stroke: string; dash?: string }> = {
  srcLi: { fill: "#eaf1ff", stroke: "#2f5fe0" },
  srcMaps: { fill: "#f3ecfc", stroke: "#7c3aed" },
  step: { fill: "#ffffff", stroke: "#cdd5e3" },
  stepV: { fill: "#f6f2fe", stroke: "#8b5cf6" },
  addon: { fill: "#f7f4fe", stroke: "#a78bfa" },
  skip: { fill: "#f1f4f8", stroke: "#c3cbd9", dash: "5 4" },
  good: { fill: "#eafaf1", stroke: "#10b981" },
  warn: { fill: "#fff8e9", stroke: "#f0a92a" },
  grey: { fill: "#eef1f6", stroke: "#c3cbd9" },
  dia: { fill: "#fff6ea", stroke: "#d9820a" },
  done: { fill: "#111827", stroke: "#111827" },
};

// Use the app's mono token (JetBrains Mono) rather than the OS mono face, so
// these SVG labels match the 100+ font-mono usages elsewhere in the app. Same
// pattern as flow.module.css. The fallback only fires outside the app shell.
const MONO = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)";
const LS: Record<LineStyle, React.CSSProperties> = {
  title: { fontSize: 12.5, fontWeight: 700, fill: "#1c2333" },
  titleSm: { fontSize: 12, fontWeight: 700, fill: "#1c2333" },
  actor: { fontSize: 10.5, fontWeight: 600, fill: "#455066", fontFamily: MONO },
  muted: { fontSize: 10.5, fontWeight: 500, fill: "#5b6472" },
  hit: { fontSize: 10.5, fontWeight: 700, fill: "#0f7a43", fontFamily: MONO },
  pq: { fontSize: 10.5, fontWeight: 700, fill: "#b45309", fontFamily: MONO },
  mv: { fontSize: 10.5, fontWeight: 700, fill: "#6d28d9", fontFamily: MONO },
  opt: { fontSize: 10.5, fontWeight: 700, fill: "#7c3aed", fontFamily: MONO },
  dia: { fontSize: 12, fontWeight: 700, fill: "#7a4a10" },
  done: { fontSize: 12.5, fontWeight: 800, fill: "#ffffff" },
};

function NodeShape({ n }: { n: FlowNode }) {
  const t = TONE[n.tone];
  const cx = n.x + n.w / 2;
  const lh = 15.5;
  const startY = n.y + n.h / 2 - ((n.lines.length - 1) * lh) / 2 + 4;
  return (
    <g>
      {n.kind === "diamond" ? (
        <polygon
          points={`${cx},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${cx},${n.y + n.h} ${n.x},${n.y + n.h / 2}`}
          fill={t.fill}
          stroke={t.stroke}
          strokeWidth={1.5}
        />
      ) : (
        <rect
          x={n.x}
          y={n.y}
          width={n.w}
          height={n.h}
          rx={n.kind === "pill" ? n.h / 2 : 12}
          fill={t.fill}
          stroke={t.stroke}
          strokeWidth={1.4}
          strokeDasharray={t.dash}
        />
      )}
      <text textAnchor="middle">
        {n.lines.map((l, i) => (
          <tspan key={i} x={cx} y={startY + i * lh} style={LS[l.s]}>
            {l.t}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function EdgeShape({ e, mid }: { e: FlowEdge; mid: string }) {
  const d = "M" + e.pts.map((p) => p.join(",")).join(" L");
  return (
    <g>
      <path d={d} fill="none" stroke="#b4bfd0" strokeWidth={1.7} strokeDasharray={e.dash} markerEnd={`url(#${mid})`} />
      {e.label && e.at && (
        <>
          <rect
            x={e.at[0] - (e.label.length * 5.6) / 2 - 5}
            y={e.at[1] - 8}
            width={e.label.length * 5.6 + 10}
            height={16}
            rx={5}
            fill="#f4f7fb"
            stroke="#dde3ec"
          />
          <text x={e.at[0]} y={e.at[1] + 3.5} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600, fill: "#5b6472", fontFamily: MONO }}>
            {e.label}
          </text>
        </>
      )}
    </g>
  );
}

function Diagram({ id, w, h, nodes, edges }: { id: string; w: number; h: number; nodes: FlowNode[]; edges: FlowEdge[] }) {
  const mid = `arr-${id}`;
  return (
    <svg className={styles.svg} viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img">
      <defs>
        <marker id={mid} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#b4bfd0" />
        </marker>
      </defs>
      {edges.map((e, i) => (
        <EdgeShape key={i} e={e} mid={mid} />
      ))}
      {nodes.map((n) => (
        <NodeShape key={n.id} n={n} />
      ))}
    </svg>
  );
}

export function EnrichmentFlowMap() {
  // Click-drag panning of the canvas: same behavior as the campaign flow editor.
  const canvasRef = useRef<HTMLDivElement>(null);
  function onCanvasMouseDown(e: React.MouseEvent) {
    const el = canvasRef.current;
    if (!el || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("a,button")) return;
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

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>Enrichment Flow Map</h1>
        <div className={styles.legend}>
          <span className={styles.k}><span className={styles.sw} style={{ background: "#eaf1ff", borderColor: "#2f5fe0" }} /> source</span>
          <span className={styles.k}><span className={styles.sw} style={{ background: "#ffffff", borderColor: "#cdd5e3" }} /> step</span>
          <span className={styles.k}><span className={styles.sw} style={{ background: "#fff6ea", borderColor: "#d9820a" }} /> decision</span>
          <span className={styles.k}><span className={styles.sw} style={{ background: "#f7f4fe", borderColor: "#a78bfa" }} /> add-on (off by default)</span>
          <span className={styles.k}><span className={styles.sw} style={{ background: "#eafaf1", borderColor: "#10b981" }} /> email won</span>
          <span className={styles.k}><span className={styles.sw} style={{ background: "#f1f4f8", borderColor: "#c3cbd9" }} /> skipped</span>
          <span className={styles.hint}>ON HIT = paid on result · PER QUERY = paid regardless · MV = Million Verifier credits</span>
        </div>
      </div>

      <div className={styles.canvas} ref={canvasRef} onMouseDown={onCanvasMouseDown}>
        <div className={styles.inner}>
          <div className={styles.col}>
            <p className={`${styles.cap} ${styles.li}`}>LinkedIn vein: people-first</p>
            <Diagram id="li" w={640} h={1032} nodes={LI_NODES} edges={LI_EDGES} />
          </div>
          <div className={styles.col}>
            <p className={`${styles.cap} ${styles.maps}`}>Maps vein: business-first</p>
            <Diagram id="maps" w={580} h={968} nodes={MAPS_NODES} edges={MAPS_EDGES} />
          </div>
        </div>
      </div>
    </div>
  );
}
