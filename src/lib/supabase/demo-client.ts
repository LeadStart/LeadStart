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
  MOCK_PROSPECTS,
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
  prospects: MOCK_PROSPECTS as unknown as MockRow[],
};

interface QueryBuilder {
  select: (columns?: string) => QueryBuilder;
  eq: (col: string, val: unknown) => QueryBuilder;
  in: (col: string, vals: unknown[]) => QueryBuilder;
  gte: (col: string, val: unknown) => QueryBuilder;
  lte: (col: string, val: unknown) => QueryBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  single: () => Promise<{ data: MockRow | null; error: null }>;
  then: (resolve: (val: { data: MockRow[]; error: null }) => void) => void;
}

function createQueryBuilder(tableName: string): QueryBuilder {
  let rows = [...(TABLES[tableName] || [])];
  const filters: Array<(r: MockRow[]) => MockRow[]> = [];
  let limitN: number | null = null;
  let orderCol: string | null = null;
  let orderAsc = true;

  const builder: QueryBuilder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r.filter((row) => row[col] === val));
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
      let result = [...rows];
      for (const fn of filters) result = fn(result);
      return { data: result[0] || null, error: null };
    },
    then(resolve) {
      let result = [...rows];
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
      resolve({ data: result, error: null });
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
      async signInWithPassword() {
        const user = currentDemoRole === "client" ? DEMO_USER_CLIENT : DEMO_USER_ADMIN;
        return { data: { user, session: {} }, error: null };
      },
      async signOut() {
        return { error: null };
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
