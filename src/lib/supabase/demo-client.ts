/**
 * Mock Supabase client for demo mode.
 * Returns static mock data so the app works without a running Supabase instance.
 *
 * Supports role switching via URL: the dashboard layout reads the pathname
 * to determine which demo user to return.
 */
import {
  MOCK_CLIENTS,
  MOCK_CAMPAIGNS,
  MOCK_SNAPSHOTS,
  MOCK_FEEDBACK,
  MOCK_REPORTS,
  MOCK_EVENTS,
  MOCK_PROFILES,
  MOCK_CONTACTS,
  MOCK_STEP_METRICS,
  MOCK_CLIENT_USERS,
  MOCK_PRICING_PLANS,
  MOCK_QUOTES,
  MOCK_CLIENT_SUBSCRIPTIONS,
  MOCK_BILLING_INVOICES,
  MOCK_PAYMENT_LINKS,
} from "@/lib/mock-data";

type MockRow = Record<string, unknown>;

// In-memory store keyed by table name
const TABLES: Record<string, MockRow[]> = {
  clients: MOCK_CLIENTS as unknown as MockRow[],
  campaigns: MOCK_CAMPAIGNS as unknown as MockRow[],
  campaign_snapshots: MOCK_SNAPSHOTS as unknown as MockRow[],
  lead_feedback: MOCK_FEEDBACK as unknown as MockRow[],
  kpi_reports: MOCK_REPORTS as unknown as MockRow[],
  webhook_events: MOCK_EVENTS as unknown as MockRow[],
  profiles: MOCK_PROFILES as unknown as MockRow[],
  contacts: MOCK_CONTACTS as unknown as MockRow[],
  campaign_step_metrics: MOCK_STEP_METRICS as unknown as MockRow[],
  client_users: MOCK_CLIENT_USERS as unknown as MockRow[],
  pricing_plans: MOCK_PRICING_PLANS as unknown as MockRow[],
  quotes: MOCK_QUOTES as unknown as MockRow[],
  client_subscriptions: MOCK_CLIENT_SUBSCRIPTIONS as unknown as MockRow[],
  billing_invoices: MOCK_BILLING_INVOICES as unknown as MockRow[],
  payment_links: MOCK_PAYMENT_LINKS as unknown as MockRow[],
  stripe_events: [],
};

type QueryResult = { data: MockRow[]; error: null };
type Operation = "select" | "insert" | "upsert" | "update" | "delete";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface QueryBuilder {
  select: (columns?: string) => QueryBuilder;
  insert: (row: MockRow | MockRow[]) => QueryBuilder;
  upsert: (row: MockRow | MockRow[], opts?: { onConflict?: string }) => QueryBuilder;
  update: (updates: Partial<MockRow>) => QueryBuilder;
  delete: () => QueryBuilder;
  eq: (col: string, val: unknown) => QueryBuilder;
  is: (col: string, val: null | boolean) => QueryBuilder;
  not: (col: string, op: string, val: unknown) => QueryBuilder;
  in: (col: string, vals: unknown[]) => QueryBuilder;
  gte: (col: string, val: unknown) => QueryBuilder;
  lte: (col: string, val: unknown) => QueryBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  single: () => Promise<{ data: MockRow | null; error: null }>;
  then: (onfulfilled?: (value: QueryResult) => any, onrejected?: (reason: any) => any) => Promise<any>;
  catch: (onrejected?: (reason: any) => any) => Promise<any>;
  [Symbol.toStringTag]: string;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function createQueryBuilder(tableName: string): QueryBuilder {
  const filters: Array<(r: MockRow[]) => MockRow[]> = [];
  let limitN: number | null = null;
  let orderCol: string | null = null;
  let orderAsc = true;
  let op: Operation = "select";
  let insertPayload: MockRow[] = [];
  let updatePayload: Partial<MockRow> = {};
  let upsertConflictKey: string = "id";

  function resolveResult(): MockRow[] {
    if (!TABLES[tableName]) TABLES[tableName] = [];
    const table = TABLES[tableName];

    if (op === "insert") {
      table.push(...insertPayload);
      return [...insertPayload];
    }

    if (op === "upsert") {
      const results: MockRow[] = [];
      for (const row of insertPayload) {
        const conflictVal = row[upsertConflictKey];
        const existingIdx = table.findIndex(
          (r) => r[upsertConflictKey] === conflictVal,
        );
        if (existingIdx >= 0) {
          Object.assign(table[existingIdx], row, {
            updated_at: new Date().toISOString(),
          });
          results.push(table[existingIdx]);
        } else {
          table.push(row);
          results.push(row);
        }
      }
      return results;
    }

    if (op === "update") {
      let matches = [...table];
      for (const fn of filters) matches = fn(matches);
      for (const row of matches) {
        Object.assign(row, updatePayload, { updated_at: new Date().toISOString() });
      }
      return matches;
    }

    if (op === "delete") {
      let matches = [...table];
      for (const fn of filters) matches = fn(matches);
      const ids = new Set(matches.map((r) => r.id));
      TABLES[tableName] = table.filter((r) => !ids.has(r.id));
      return matches;
    }

    // select
    let result = [...table];
    for (const fn of filters) result = fn(result);
    if (orderCol) {
      const col = orderCol;
      const asc = orderAsc;
      result.sort((a, b) => {
        const av = a[col] as string;
        const bv = b[col] as string;
        return asc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
      });
    }
    if (limitN !== null) result = result.slice(0, limitN);
    return result;
  }

  const builder: QueryBuilder = {
    select() {
      return builder;
    },
    insert(row: MockRow | MockRow[]) {
      op = "insert";
      insertPayload = Array.isArray(row) ? [...row] : [row];
      return builder;
    },
    upsert(row: MockRow | MockRow[], opts?: { onConflict?: string }) {
      op = "upsert";
      insertPayload = Array.isArray(row) ? [...row] : [row];
      upsertConflictKey = opts?.onConflict || "id";
      return builder;
    },
    update(updates: Partial<MockRow>) {
      op = "update";
      updatePayload = updates;
      return builder;
    },
    delete() {
      op = "delete";
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r.filter((row) => row[col] === val));
      return builder;
    },
    is(col: string, val: null | boolean) {
      filters.push((r) =>
        r.filter((row) => {
          const cell = row[col];
          if (val === null) return cell === null || cell === undefined;
          return cell === val;
        }),
      );
      return builder;
    },
    not(col: string, op: string, val: unknown) {
      filters.push((r) =>
        r.filter((row) => {
          const cell = row[col];
          if (op === "is" && val === null)
            return cell !== null && cell !== undefined;
          return cell !== val;
        }),
      );
      return builder;
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => r.filter((row) => vals.includes(row[col])));
      return builder;
    },
    gte(col: string, val: unknown) {
      filters.push((r) => r.filter((row) => (row[col] as string) >= (val as string)));
      return builder;
    },
    lte(col: string, val: unknown) {
      filters.push((r) => r.filter((row) => (row[col] as string) <= (val as string)));
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderCol = col;
      orderAsc = opts?.ascending ?? true;
      return builder;
    },
    limit(n: number) {
      limitN = n;
      return builder;
    },
    async single() {
      const result = resolveResult();
      return { data: result[0] || null, error: null };
    },
    [Symbol.toStringTag]: "QueryBuilder" as const,
    then(onfulfilled?: (value: QueryResult) => unknown) {
      const value: QueryResult = { data: resolveResult(), error: null };
      return Promise.resolve(onfulfilled ? onfulfilled(value) : value);
    },
    catch() {
      return Promise.resolve({ data: [], error: null });
    },
  };

  return builder;
}

// Admin demo user
const DEMO_USER_ADMIN = {
  id: "user-owner-001",
  email: "admin@leadstart.com",
  app_metadata: { role: "owner", organization_id: "00000000-0000-0000-0000-000000000001" },
  user_metadata: {},
};

// Client demo user — matches MOCK_CLIENTS[0].user_id
const DEMO_USER_CLIENT = {
  id: "user-client-001",
  email: "john@acmecorp.com",
  app_metadata: { role: "client", organization_id: "00000000-0000-0000-0000-000000000001" },
  user_metadata: {},
};

// Track which role to demo — default to admin, switchable
let currentDemoRole: "owner" | "client" = "owner";

export function setDemoRole(role: "owner" | "client") {
  currentDemoRole = role;
}

export function getDemoRole() {
  return currentDemoRole;
}

export function createDemoClient() {
  return {
    from(table: string) {
      return createQueryBuilder(table);
    },
    auth: {
      async getUser() {
        const user = currentDemoRole === "client" ? DEMO_USER_CLIENT : DEMO_USER_ADMIN;
        return { data: { user }, error: null };
      },
      async getSession() {
        const user = currentDemoRole === "client" ? DEMO_USER_CLIENT : DEMO_USER_ADMIN;
        return { data: { session: { user } }, error: null };
      },
      async signInWithPassword() {
        const user = currentDemoRole === "client" ? DEMO_USER_CLIENT : DEMO_USER_ADMIN;
        return { data: { user, session: {} }, error: null };
      },
      async signOut() {
        return { error: null };
      },
      async updateUser(_updates: unknown) {
        return { data: { user: DEMO_USER_ADMIN }, error: null };
      },
      onAuthStateChange(_callback: unknown) {
        return {
          data: {
            subscription: {
              unsubscribe() {},
            },
          },
        };
      },
    },
  };
}
