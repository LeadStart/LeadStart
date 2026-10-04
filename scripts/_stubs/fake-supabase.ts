/**
 * In-memory stand-in for the Supabase clients, so a harness can drive a REAL
 * route handler with no database. scripts/tsconfig.client-import-harness.json
 * maps "@/lib/supabase/admin", "@/lib/supabase/server" and
 * "@/lib/notifications/owner-alerts" to this file, so the route under test
 * gets these exports instead of the real modules. No network.
 *
 * It implements only the PostgREST builder calls the client-import route
 * makes (select / insert / update / upsert with eq, in, is, gte, or, order,
 * maybeSingle, count+head), the two unique indexes that route relies on
 * (contacts: org + lower(email); campaign_enrollments: campaign + contact),
 * and records every write. Anything else throws, so a route change that
 * outgrows the fake fails loudly instead of passing by accident.
 */
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type DbError = { message: string; code?: string };
type Result = { data: unknown; error: DbError | null; count?: number | null };

export interface FakeState {
  tables: Record<string, Row[]>;
  user: { id: string; email: string; app_metadata: Record<string, unknown> } | null;
  writes: { table: string; op: "insert" | "update" | "upsert"; ids: string[] }[];
  alerts: Record<string, unknown>[];
  /** "table:op" keys whose next call returns an error, e.g. "campaign_enrollments:select". */
  failOn: Set<string>;
}

// On globalThis so the route (which reaches this file through the path alias)
// and the harness (relative import) share one store even if loaded twice.
const g = globalThis as unknown as { __fakeSupabase?: FakeState };
export function fakeState(): FakeState {
  g.__fakeSupabase ??= { tables: {}, user: null, writes: [], alerts: [], failOn: new Set() };
  return g.__fakeSupabase;
}

export function resetFake(tables: Record<string, Row[]>, user: FakeState["user"]): void {
  const s = fakeState();
  s.tables = structuredClone(tables);
  s.user = user;
  s.writes = [];
  s.alerts = [];
  s.failOn = new Set();
}

const clone = <T>(v: T): T => structuredClone(v);

function uniqueKey(table: string, r: Row): string | null {
  if (table === "contacts") return `${r.organization_id}|${String(r.email ?? "").toLowerCase()}`;
  if (table === "campaign_enrollments") return `${r.campaign_id}|${r.contact_id}`;
  return null;
}

function withDefaults(table: string, r: Row): Row {
  const now = new Date().toISOString();
  if (table === "contacts") {
    return { id: randomUUID(), email_verification_status: null, created_at: now, updated_at: now, ...r };
  }
  if (table === "campaign_enrollments") {
    return { id: randomUUID(), last_action_at: null, started_at: now, created_at: now, updated_at: now, ...r };
  }
  return { id: randomUUID(), ...r };
}

function project(r: Row, cols: string | undefined): Row {
  if (!cols || cols.trim() === "*") return clone(r);
  const out: Row = {};
  for (const c of cols.split(",").map((s) => s.trim()).filter(Boolean)) out[c] = clone(r[c]);
  return out;
}

// Split on commas that are not inside parentheses: "a.eq.1,b.in.(x,y)".
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function orTerm(term: string): (r: Row) => boolean {
  const m = /^([A-Za-z_]+)\.(eq|is|in)\.(.*)$/.exec(term.trim());
  if (!m) throw new Error(`fake-supabase: unsupported or() term "${term}"`);
  const [, col, op, val] = m;
  if (op === "eq") return (r) => r[col] != null && String(r[col]) === val;
  if (op === "is") {
    if (val !== "null") throw new Error(`fake-supabase: unsupported is.${val}`);
    return (r) => r[col] == null;
  }
  const inner = val.replace(/^\(/, "").replace(/\)$/, "");
  const set = new Set(splitTopLevel(inner).map((v) => v.trim()));
  return (r) => r[col] != null && set.has(String(r[col]));
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private payload: unknown = null;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private cols: string | undefined;
  private returning: string | undefined;
  private countExact = false;
  private head = false;
  private orderBy: { col: string; asc: boolean } | null = null;

  constructor(private table: string) {}

  select(cols?: string, opts?: { count?: "exact"; head?: boolean }): this {
    if (this.op === "select") {
      this.cols = cols;
      this.countExact = opts?.count === "exact";
      this.head = opts?.head === true;
    } else {
      this.returning = cols ?? "*";
    }
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  upsert(payload: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    this.payload = payload;
    this.upsertOpts = opts ?? {};
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  in(col: string, vals: unknown[]): this {
    const set = new Set(vals);
    this.filters.push((r) => set.has(r[col]));
    return this;
  }
  is(col: string, val: null): this {
    if (val !== null) throw new Error("fake-supabase: is() only supports null");
    this.filters.push((r) => r[col] == null);
    return this;
  }
  gte(col: string, val: string | number): this {
    this.filters.push((r) => r[col] != null && (r[col] as string | number) >= val);
    return this;
  }
  or(expr: string): this {
    const terms = splitTopLevel(expr).map(orTerm);
    this.filters.push((r) => terms.some((t) => t(r)));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }

  async maybeSingle(): Promise<Result> {
    const res = await this.run();
    if (res.error) return res;
    const rows = (res.data as Row[] | null) ?? [];
    if (rows.length > 1) return { data: null, error: { message: "multiple rows for maybeSingle", code: "PGRST116" } };
    return { data: rows[0] ?? null, error: null };
  }

  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private matching(): Row[] {
    const rows = fakeState().tables[this.table] ?? [];
    return rows.filter((r) => this.filters.every((f) => f(r)));
  }

  private async run(): Promise<Result> {
    const s = fakeState();
    const key = `${this.table}:${this.op}`;
    if (s.failOn.has(key)) {
      s.failOn.delete(key);
      return { data: null, error: { message: `injected failure on ${key}`, code: "XX000" } };
    }
    s.tables[this.table] ??= [];
    const table = s.tables[this.table];

    if (this.op === "select") {
      let rows = this.matching();
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        rows = [...rows].sort((a, b) => ((a[col] as number) - (b[col] as number)) * (asc ? 1 : -1));
      }
      if (this.head) return { data: null, error: null, count: this.countExact ? rows.length : null };
      return { data: rows.map((r) => project(r, this.cols)), error: null, count: this.countExact ? rows.length : null };
    }

    if (this.op === "insert") {
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const taken = new Set(table.map((r) => uniqueKey(this.table, r)).filter(Boolean));
      const rows = incoming.map((r) => withDefaults(this.table, clone(r)));
      for (const r of rows) {
        const k = uniqueKey(this.table, r);
        if (k && taken.has(k)) {
          // One statement: a single collision inserts nothing.
          return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
        }
        if (k) taken.add(k);
      }
      table.push(...rows);
      s.writes.push({ table: this.table, op: "insert", ids: rows.map((r) => String(r.id)) });
      return { data: this.returning ? rows.map((r) => project(r, this.returning)) : null, error: null };
    }

    if (this.op === "update") {
      const rows = this.matching();
      for (const r of rows) Object.assign(r, clone(this.payload as Row));
      s.writes.push({ table: this.table, op: "update", ids: rows.map((r) => String(r.id)) });
      return { data: this.returning ? rows.map((r) => project(r, this.returning)) : null, error: null };
    }

    // upsert
    if (!this.upsertOpts.ignoreDuplicates) throw new Error("fake-supabase: only ignoreDuplicates upserts are supported");
    const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
    const taken = new Set(table.map((r) => uniqueKey(this.table, r)).filter(Boolean));
    const added: Row[] = [];
    for (const raw of incoming) {
      const r = withDefaults(this.table, clone(raw));
      const k = uniqueKey(this.table, r);
      if (k && taken.has(k)) continue; // ON CONFLICT DO NOTHING
      if (k) taken.add(k);
      table.push(r);
      added.push(r);
    }
    s.writes.push({ table: this.table, op: "upsert", ids: added.map((r) => String(r.id)) });
    return { data: this.returning ? added.map((r) => project(r, this.returning)) : null, error: null };
  }
}

// ── The swapped-in module exports ──────────────────────────────────────────

/** Stands in for @/lib/supabase/admin. `__fake` lets a harness prove the swap took. */
export function createAdminClient() {
  return { __fake: true as const, from: (table: string) => new Query(table) };
}

/** Stands in for @/lib/supabase/server: the signed-in user is fakeState().user. */
export async function createClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fakeState().user }, error: null }),
    },
  };
}

/** Stands in for @/lib/notifications/owner-alerts: records the alert, sends nothing. */
export async function enqueueOwnerAlert(input: Record<string, unknown>): Promise<void> {
  const rest = { ...input };
  delete rest.admin;
  fakeState().alerts.push(rest);
}
