/**
 * #209: de-duplicate log ids in the shared shop doc. Firestore rules can't loop over
 * `logs`, so they can't stop two entries with the same id (#208); the client reads
 * the first match by id, so a stray copy could otherwise stand in for the reviewed
 * record. Every remote read (RemoteShopStore.getShop) keeps one winner per id, and
 * every other copy goes to the set-aside store (backup JSON, cleared by wipe).
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
 * Writing back (RemoteShopStore.putShop) stays inside the #208 review lock: unreviewed
 * losers and exact copies are removed in a cleanup write of their own (so the per-log
 * pairing in the rules is unaffected); a reviewed loser can't be deleted under #208, so
 * it is left in the doc unchanged. A loser whose set-aside copy can't be saved on this
 * device is also left in the doc, so no copy is ever lost.
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

function stableJson(value: unknown): string {
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
    return false; // the losers stay in the shop doc (planDedupedWrite)
  }
}

export interface DedupedWritePlan {
  /** Stored logs minus the removable copies, in stored order; null when nothing to remove. */
  cleanup: ApplicationLog[] | null;
  /** What to write: the caller's logs plus stored copies that must stay. */
  logs: ApplicationLog[];
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
  const keep: ApplicationLog[] = [];
  for (const l of losers) {
    if (l.identical || (setAsideOk && !isLogReviewed(l.log))) removable.add(l.index);
    else keep.push(l.log);
  }
  return {
    cleanup: removable.size ? stored.filter((_, i) => !removable.has(i)) : null,
    logs: [...next, ...keep],
  };
}
