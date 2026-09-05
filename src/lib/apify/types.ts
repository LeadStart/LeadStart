// Apify REST v2 shapes we depend on. Only the fields we read are typed;
// everything else on a run/dataset item is passed through as `unknown`.

export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMING-OUT"
  | "TIMED-OUT"
  | "ABORTING"
  | "ABORTED";

export interface ApifyRun {
  id: string;
  actId: string;
  status: ApifyRunStatus;
  statusMessage?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  defaultDatasetId: string;
  defaultKeyValueStoreId?: string;
  // Only present when the token owns the run (our token does).
  usageTotalUsd?: number | null;
  // NOTE: the run's `stats` object carries NO dataset item count (verified
  // against the live API: it holds runtime/memory/CPU/network numbers only).
  // For live progress while a run is in flight, read the run's dataset:
  // ApifyClient.getDatasetItemCount(run.defaultDatasetId).
}

export interface ApifyUser {
  id?: string;
  username: string;
  email?: string;
  plan?: { id?: string } | string | null;
}

// Terminal run states.
export const TERMINAL_OK: readonly ApifyRunStatus[] = ["SUCCEEDED"];
export const TERMINAL_BAD: readonly ApifyRunStatus[] = ["FAILED", "TIMED-OUT", "ABORTED"];
export const IN_PROGRESS: readonly ApifyRunStatus[] = ["READY", "RUNNING", "TIMING-OUT", "ABORTING"];

export function isTerminalOk(s: ApifyRunStatus): boolean {
  return TERMINAL_OK.includes(s);
}
export function isTerminalBad(s: ApifyRunStatus): boolean {
  return TERMINAL_BAD.includes(s);
}
export function isInProgress(s: ApifyRunStatus): boolean {
  return IN_PROGRESS.includes(s);
}
