/**
 * #209 / #215: de-duplicate log ids across the shared shop's per-log subcollection
 * (`shops/{shopId}/logs/{logId}`) and any unmigrated legacy `shops/{shopId}.logs` array.
 * Every remote read (RemoteShopStore.getShop) keeps one winner per id, and every other
 * copy goes to the set-aside store (backup JSON, cleared by wipe).
 *
 * Winner (Lawgical rule, then a documented tie-break), first rule that differs:
 *   1. reviewed beats unreviewed (isLogReviewed);
 *   2. higher revision (revision, else history length);
 *   3. later reviewedAt (only differs when both are reviewed);
 *   4. later changedAt of the newest correction (a copy with no corrections is earliest);
 *   5. first in the array.
 * Unparseable timestamps sort earliest. Exact copies of the winner (same JSON, any key
 * order) are collapsed: nothing would be lost, so they are not set aside.
 *
 * Writing back (RemoteShopStore.putShop) writes each winner to `shops/{shopId}/logs/{logId}`
 * and drains removable entries from the legacy `shops/{shopId}.logs` array in batches of at
 * most MAX_DEDUPE_CLEANUP_BATCH (8). A differing reviewed loser (#212) can't be deleted
 * under #208, so it stays in `shops/{shopId}.logs` unchanged. A loser whose set-aside copy
 * can't be saved on this device also stays in `shops/{shopId}.logs`, so no copy is ever lost.
 */

import { localIsoWithOffset } from "../dates";
import { newId } from "../ids";
import { isLogReviewed } from "../reviewQueue";
import { SET_ASIDE_KEY } from "../storage";
import type { ApplicationLog } from "../types";

/** `reason` on set-aside rows written here (sync-conflict rows carry setAsideBy instead). */
export const DUPLICATE_ID_SET_ASIDE_REASON = "duplicate-id";

export interface DuplicateLoser {
  /** Index of the losing copy in the input array. */
  index: number;
  log: ApplicationLog;
  /** Exact copy of the winner (nothing to set aside). */
  identical: boolean;
}

export interface DedupeResult {
  /** One log per id, in the input order of each id's first appearance, winner in that slot. */
  logs: ApplicationLog[];
  losers: DuplicateLoser[];
}

export function stableJson(value: unknown): string {
  const encode = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(encode);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = encode((v as Record<string, unknown>)[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(encode(value));
}

function time(value: string | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

export function revisionOf(log: ApplicationLog): number {
  return typeof log.revision === "number" ? log.revision : (log.history?.length ?? 0);
}

function lastChangedAt(log: ApplicationLog): number {
  const history = log.history ?? [];
  return history.length ? time(history[history.length - 1].changedAt) : -Infinity;
}

/** > 0 when `a` should win over `b` (rules 1–4); 0 leaves it to array order. */
export function compareDuplicateCopies(a: ApplicationLog, b: ApplicationLog): number {
  const ra = isLogReviewed(a) ? 1 : 0;
  const rb = isLogReviewed(b) ? 1 : 0;
  if (ra !== rb) return ra - rb;
  const rev = revisionOf(a) - revisionOf(b);
  if (rev !== 0) return rev;
  if (ra && rb) {
    const at = time(a.reviewedAt) - time(b.reviewedAt);
    if (at > 0 || at < 0) return at;
  }
  const ct = lastChangedAt(a) - lastChangedAt(b);
  return ct > 0 || ct < 0 ? ct : 0;
}

/** Keep one copy per id (see file comment); pure. */
export function dedupeLogsById(logs: readonly ApplicationLog[]): DedupeResult {
  const winnerIndex = new Map<string, number>();
  for (let i = 0; i < logs.length; i++) {
    const id = logs[i].id;
    const current = winnerIndex.get(id);
    if (current === undefined || compareDuplicateCopies(logs[i], logs[current]) > 0) winnerIndex.set(id, i);
  }
  if (winnerIndex.size === logs.length) return { logs: logs.slice(), losers: [] };
  const out: ApplicationLog[] = [];
  const losers: DuplicateLoser[] = [];
  const placed = new Set<string>();
  for (let i = 0; i < logs.length; i++) {
    const id = logs[i].id;
    const w = winnerIndex.get(id)!;
    if (!placed.has(id)) {
      placed.add(id);
      out.push(logs[w]);
    }
    if (i !== w) losers.push({ index: i, log: logs[i], identical: stableJson(logs[i]) === stableJson(logs[w]) });
  }
  return { logs: out, losers };
}

function isOurRow(row: unknown, shopId: string, log: ApplicationLog, json: string): boolean {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    r.reason === DUPLICATE_ID_SET_ASIDE_REASON &&
    r.shopId === shopId &&
    r.logId === log.id &&
    stableJson(r.deviceCopy) === json
  );
}

/**
  * Append each non-identical loser to the set-aside store once (idempotent: a copy
  * already set aside for this shop is not added again). Rows match the sync-conflict
  * rows (id, logId, deviceCopy, setAsideAt, shopId) with `reason` in place of
  * `setAsideBy`, since no person chose this. Returns false (and writes nothing) when the
  * store is unreadable or can't be saved, so callers keep the loser in the shop doc.
  */
export function setAsideDuplicateCopies(shopId: string, losers: readonly DuplicateLoser[], now: Date = new Date()): boolean {
  const pending = losers.filter((l) => !l.identical);
  if (pending.length === 0) return true;
  let before: unknown[];
  try {
    const raw = localStorage.getItem(SET_ASIDE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return false; // never overwrite rows we can't read
    before = parsed;
  } catch {
    return false;
  }
  const next = before.slice();
  for (const { log } of pending) {
    const json = stableJson(log);
    if (next.some((row) => isOurRow(row, shopId, log, json))) continue;
    next.push({
      id: newId(),
      logId: log.id,
      deviceCopy: JSON.parse(JSON.stringify(log)) as ApplicationLog,
      setAsideAt: localIsoWithOffset(now),
      shopId,
      reason: DUPLICATE_ID_SET_ASIDE_REASON,
    });
  }
  if (next.length === before.length) return true;
  try {
    localStorage.setItem(SET_ASIDE_KEY, JSON.stringify(next));
    const check = JSON.parse(localStorage.getItem(SET_ASIDE_KEY) ?? "[]") as unknown[];
    return pending.every(({ log }) => check.some((row) => isOurRow(row, shopId, log, stableJson(log))));
  } catch {
    return false; // the losers stay in the shop doc
  }
}

/**
 * #228 / #215: firestore.rules check up to 8 removed entries per shops/{shopId}.logs
 * drain write (staying under Firestore's 10-getAfter and 1,000-expression limits).
 */
export const MAX_DEDUPE_CLEANUP_BATCH = 8;

export interface LegacyWinnerToMigrate {
  id: string;
  log: ApplicationLog;
  raw: unknown;
}

export interface LegacyDrainPlan {
  /** Legacy winners not yet in `shops/{shopId}/logs/{logId}` that must be written first. */
  winnersToCreate: LegacyWinnerToMigrate[];
  /**
   * Sequential `shops/{shopId}.logs` arrays, each removing <= MAX_DEDUPE_CLEANUP_BATCH
   * entries from the previous array, ending at `remainingLegacy`. Empty when nothing
   * is removed from `shops/{shopId}.logs`.
   */
  drainBatches: ApplicationLog[][];
  /** Entries that stay in `shops/{shopId}.logs` (e.g. #212 reviewed losers, or losers when !setAsideOk). */
  remainingLegacy: ApplicationLog[];
}

/**
 * #215: plan migrating winners from a legacy `shops/{shopId}.logs` array into
 * `shops/{shopId}/logs/{logId}` and draining removable entries from `shops/{shopId}.logs`
 * in batches of <= MAX_DEDUPE_CLEANUP_BATCH (8).
 */
export function planLegacyDrain(
  subLogs: ReadonlyMap<string, ApplicationLog>,
  legacyLogs: readonly ApplicationLog[],
  rawLegacyLogs: readonly unknown[],
  nextLogs: readonly ApplicationLog[],
  setAsideOk: boolean,
): LegacyDrainPlan {
  if (legacyLogs.length === 0) {
    return { winnersToCreate: [], drainBatches: [], remainingLegacy: [] };
  }

  const allStored = [...subLogs.values(), ...legacyLogs];
  const { logs: winners } = dedupeLogsById(allStored);
  const winnerById = new Map<string, ApplicationLog>();
  const winnerJsonById = new Map<string, string>();
  for (const w of winners) {
    winnerById.set(w.id, w);
    winnerJsonById.set(w.id, stableJson(w));
  }

  const nextIds = new Set(nextLogs.map((l) => l.id));
  const winnersToCreate: LegacyWinnerToMigrate[] = [];
  const queuedWinnerIds = new Set<string>();

  for (let i = 0; i < legacyLogs.length; i++) {
    const id = legacyLogs[i].id;
    if (subLogs.has(id) || queuedWinnerIds.has(id)) continue;
    const w = winnerById.get(id)!;
    // Migrate the winner unless the caller omitted an unreviewed log (expired hold deletion).
    if (nextIds.has(id) || isLogReviewed(w)) {
      queuedWinnerIds.add(id);
      const rawIdx = legacyLogs.indexOf(w);
      const raw = rawIdx >= 0 && rawIdx < rawLegacyLogs.length ? rawLegacyLogs[rawIdx] : w;
      winnersToCreate.push({ id, log: w, raw });
    }
  }

  const removableIndices: number[] = [];
  const remainingLegacy: ApplicationLog[] = [];
  for (let i = 0; i < legacyLogs.length; i++) {
    const c = legacyLogs[i];
    const isWinnerCopy = stableJson(c) === winnerJsonById.get(c.id);
    if (isWinnerCopy || (setAsideOk && !isLogReviewed(c))) {
      removableIndices.push(i);
    } else {
      remainingLegacy.push(c);
    }
  }

  if (removableIndices.length === 0) {
    return { winnersToCreate, drainBatches: [], remainingLegacy };
  }

  // Group identical removable entries together so dropping a group removes all copies of that
  // JSON value at once; each batch drops <= MAX_DEDUPE_CLEANUP_BATCH total indices.
  const keptJsons = new Set(remainingLegacy.map((l) => stableJson(l)));
  const zeroCostIndices: number[] = [];
  const groupsByJson = new Map<string, number[]>();
  for (const idx of removableIndices) {
    const json = stableJson(legacyLogs[idx]);
    if (keptJsons.has(json)) {
      zeroCostIndices.push(idx);
    } else {
      const g = groupsByJson.get(json);
      if (g) g.push(idx);
      else groupsByJson.set(json, [idx]);
    }
  }

  const chunks: number[][] = [];
  let currentChunk: number[] = [...zeroCostIndices];
  let currentCost = 0;
  for (const group of groupsByJson.values()) {
    for (const idx of group) {
      if (currentCost >= MAX_DEDUPE_CLEANUP_BATCH) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentCost = 0;
      }
      currentChunk.push(idx);
      currentCost++;
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  const dropped = new Set<number>();
  const drainBatches: ApplicationLog[][] = chunks.map((chunk) => {
    for (const idx of chunk) dropped.add(idx);
    return legacyLogs.filter((_, i) => !dropped.has(i));
  });

  return { winnersToCreate, drainBatches, remainingLegacy };
}

export interface DedupeCleanupStep {
  /** Stored logs minus the copies removed through this batch, in stored order. */
  logs: ApplicationLog[];
  /**
   * #221: for each copy removed in this batch that differs from its kept copy, the kept
   * copy's index in `logs` ({logId: index}). Undefined when only exact copies are removed.
   */
  keptCopyAt?: Record<string, number>;
}

export interface DedupedWritePlan {
  /** Stored logs minus the removable copies, in stored order; null when nothing to remove. */
  cleanup: ApplicationLog[] | null;
  /**
   * #228: sequential cleanup batches (each removing <= MAX_DEDUPE_CLEANUP_BATCH differing
   * copies); undefined when nothing to remove. The last batch's `logs` equals `cleanup`.
   */
  cleanups?: DedupeCleanupStep[];
  /** What to write: the caller's logs plus stored copies that must stay. */
  logs: ApplicationLog[];
  /**
   * #221: for each removed copy that differs from its kept copy, the kept copy's index in
   * `cleanup` ({logId: index}). Undefined when not needed.
   */
  keptCopyAt?: Record<string, number>;
}

/**
 * Plan a write of `next` (already de-duplicated by the caller) over the stored logs. Removable:
 * exact copies, and unreviewed losers once `setAsideOk`. Kept: reviewed losers (#208
 * forbids deleting a reviewed log) and, when the set-aside failed, every loser.
 */
export function planDedupedWrite(
  stored: readonly ApplicationLog[],
  next: readonly ApplicationLog[],
  setAsideOk: boolean,
): DedupedWritePlan {
  const { losers } = dedupeLogsById(stored);
  const removable = new Set<number>();
  const differing: DuplicateLoser[] = [];
  const keep: ApplicationLog[] = [];
  for (const l of losers) {
    if (l.identical || (setAsideOk && !isLogReviewed(l.log))) {
      removable.add(l.index);
      if (!l.identical) differing.push(l);
    } else {
      keep.push(l.log);
    }
  }
  if (removable.size === 0) {
    return { cleanup: null, logs: [...next, ...keep] };
  }

  const dropped = new Set<number>();
  for (const l of losers) {
    if (l.identical) dropped.add(l.index);
  }
  const chunks: DuplicateLoser[][] = [];
  for (let i = 0; i < differing.length; i += MAX_DEDUPE_CLEANUP_BATCH) {
    chunks.push(differing.slice(i, i + MAX_DEDUPE_CLEANUP_BATCH));
  }
  if (chunks.length === 0) chunks.push([]);

  const cleanups: DedupeCleanupStep[] = chunks.map((chunk) => {
    const batchIds = new Set<string>();
    for (const l of chunk) {
      dropped.add(l.index);
      batchIds.add(l.log.id);
    }
    const logs: ApplicationLog[] = [];
    let keptCopyAt: Record<string, number> | undefined;
    stored.forEach((log, origIdx) => {
      if (dropped.has(origIdx)) return;
      const idx = logs.push(log) - 1;
      if (!removable.has(origIdx) && batchIds.has(log.id) && !(keptCopyAt && log.id in keptCopyAt)) {
        keptCopyAt = { ...keptCopyAt, [log.id]: idx };
      }
    });
    return keptCopyAt ? { logs, keptCopyAt } : { logs };
  });

  const cleanup = cleanups[cleanups.length - 1].logs;
  const allRemovedIds = new Set(differing.map((l) => l.log.id));
  let keptCopyAt: Record<string, number> | undefined;
  cleanup.forEach((log, i) => {
    if (!allRemovedIds.has(log.id) || (keptCopyAt && log.id in keptCopyAt)) return;
    keptCopyAt = { ...keptCopyAt, [log.id]: i };
  });
  return { cleanup, cleanups, logs: [...next, ...keep], keptCopyAt };
}
