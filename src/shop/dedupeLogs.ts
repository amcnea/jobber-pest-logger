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
  /**
   * Log IDs whose legacy winner cannot overwrite the existing `shops/{shopId}/logs/{logId}`
   * doc under `firestore.rules` (or whose unreviewed winner migration was deferred while
   * `legacyLogs.length > 48`), so their legacy entries stay in `remainingLegacy`.
   */
  blockedWinnerIds: ReadonlySet<string>;
}

const YMD_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const CREATED_AT_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T/;

function isRuleYmd(v: unknown): v is string {
  return typeof v === "string" && YMD_RE.test(v.trim());
}

function ymdInt(v: string): number {
  return Number(v.slice(0, 4)) * 10000 + Number(v.slice(5, 7)) * 100 + Number(v.slice(8, 10));
}

function addTwoYearsInt(start: number): number {
  return start % 10000 === 229 ? start + 20072 : start + 20000;
}

function fallbackUntilInt(du: unknown, ca: unknown): number {
  const caOk = typeof ca === "string" && CREATED_AT_RE.test(ca);
  if (isRuleYmd(du)) {
    const duVal = ymdInt(du.trim());
    return addTwoYearsInt(caOk ? Math.max(duVal, ymdInt(ca) + 1) : duVal);
  }
  return caOk ? addTwoYearsInt(ymdInt(ca) + 1) : 99999999;
}

function holdUntilInt(log: Record<string, unknown>): number {
  return isRuleYmd(log.retainUntil)
    ? ymdInt(log.retainUntil.trim())
    : fallbackUntilInt(log.dateUsed, log.createdAt);
}

function affectedTopKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (!(k in a) || !(k in b) || stableJson(a[k]) !== stableJson(b[k])) out.push(k);
  }
  return out;
}

function nonBlankStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * True when updating an existing `shops/{shopId}/logs/{logId}` document from `prev` to
 * `next` is permitted by `firestore.rules` (`reviewedChangeOk` / `unreviewedEditOk`).
 */
export function canUpdateSubcollectionLog(prev: ApplicationLog, next: ApplicationLog): boolean {
  if (prev.id !== next.id || !nonBlankStr(next.id)) return false;
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  if (!isLogReviewed(prev)) {
    const diff = affectedTopKeys(p, n);
    if (!diff.some((k) => k === "retainUntil" || k === "dateUsed" || k === "createdAt")) {
      return true;
    }
    if (isRuleYmd(n.retainUntil) && ymdInt(n.retainUntil.trim()) >= holdUntilInt(p)) {
      return true;
    }
    return (
      !("retainUntil" in p) &&
      !("retainUntil" in n) &&
      fallbackUntilInt(n.dateUsed, n.createdAt) >= fallbackUntilInt(p.dateUsed, p.createdAt)
    );
  }
  if (!isLogReviewed(next)) return false;
  const priorHistory = Array.isArray(p.history) ? p.history : [];
  const prevRev = typeof p.revision === "number" ? p.revision : priorHistory.length;
  const nextRev = typeof n.revision === "number" ? n.revision : -1;
  const prevRetain = typeof p.retainUntil === "string" ? p.retainUntil : "";
  const nextRetain = typeof n.retainUntil === "string" ? n.retainUntil : "";
  if (nextRev === prevRev + 1) {
    const diff = affectedTopKeys(p, n);
    if (diff.some((k) => k === "id" || k === "createdAt" || k === "reviewedAt" || k === "reviewedBy" || k === "reuploads")) {
      return false;
    }
    if (nextRetain < prevRetain) return false;
    const nextHistory = Array.isArray(n.history) ? n.history : null;
    if (!nextHistory || nextHistory.length !== priorHistory.length + 1) return false;
    if (stableJson(nextHistory.slice(0, priorHistory.length)) !== stableJson(priorHistory)) return false;
    const entry = nextHistory[priorHistory.length] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") return false;
    if (
      entry.revision !== prevRev + 1 ||
      !nonBlankStr(entry.changedAt) ||
      !nonBlankStr(entry.changedBy) ||
      !nonBlankStr(entry.reason) ||
      !Array.isArray(entry.changes) ||
      entry.changes.length === 0
    ) {
      return false;
    }
    const snap = entry.priorSnapshot as Record<string, unknown> | null;
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) return false;
    if ("history" in snap || "reuploads" in snap || "retainUntil" in snap) return false;
    const snapDiff = affectedTopKeys(p, snap);
    return snapDiff.every((k) => k === "history" || k === "reuploads" || k === "retainUntil");
  }
  const diff = affectedTopKeys(p, n);
  if (!diff.every((k) => k === "retainUntil" || k === "reuploads")) return false;
  if (nextRetain < prevRetain) return false;
  const beforeReuploads = Array.isArray(p.reuploads) ? p.reuploads : [];
  if (beforeReuploads.length === 0) return true;
  const nextReuploads = Array.isArray(n.reuploads) ? n.reuploads : null;
  if (!nextReuploads || nextReuploads.length < beforeReuploads.length) return false;
  return stableJson(nextReuploads.slice(0, beforeReuploads.length)) === stableJson(beforeReuploads);
}

/**
 * #215: plan migrating winners from a legacy `shops/{shopId}.logs` array into
 * `shops/{shopId}/logs/{logId}` and draining removable entries from `shops/{shopId}.logs`
 * in batches of <= MAX_DEDUPE_CLEANUP_BATCH (8). Preserves the exact `rawLegacyLogs`
 * objects for kept entries in `drainBatches` and `remainingLegacy` so Firestore rules
 * (`before.removeAll(after)`) see unchanged raw maps even when `normalizeLog` added
 * default fields like `history: []`.
 */
export function planLegacyDrain(
  subLogs: ReadonlyMap<string, ApplicationLog>,
  legacyLogs: readonly ApplicationLog[],
  rawLegacyLogs: readonly unknown[],
  nextLogs: readonly ApplicationLog[],
  setAsideOk: boolean,
): LegacyDrainPlan {
  if (legacyLogs.length === 0) {
    return { winnersToCreate: [], drainBatches: [], remainingLegacy: [], blockedWinnerIds: new Set() };
  }

  const allStored = [...subLogs.values(), ...legacyLogs];
  const { logs: winners } = dedupeLogsById(allStored);
  const winnerById = new Map<string, ApplicationLog>();
  const winnerJsonById = new Map<string, string>();
  for (const w of winners) {
    winnerById.set(w.id, w);
    winnerJsonById.set(w.id, stableJson(w));
  }

  const nextById = new Map(nextLogs.map((l) => [l.id, l]));
  const nextIds = new Set(nextById.keys());
  const winnersToCreate: LegacyWinnerToMigrate[] = [];
  const queuedWinnerIds = new Set<string>();
  const blockedWinnerIds = new Set<string>();
  const deferredIds = new Set<string>();
  const needsScanForUnreviewedCreate = legacyLogs.length > 48;
  const directCandidates: LegacyWinnerToMigrate[] = [];
  const editedScanCandidates: LegacyWinnerToMigrate[] = [];
  const unchangedScanCandidates: LegacyWinnerToMigrate[] = [];

  for (let i = 0; i < legacyLogs.length; i++) {
    const id = legacyLogs[i].id;
    if (queuedWinnerIds.has(id) || blockedWinnerIds.has(id)) continue;
    const w = winnerById.get(id)!;
    const existingSub = subLogs.get(id);
    const rawIdx = legacyLogs.indexOf(w);
    const raw =
      rawIdx >= 0 && rawIdx < rawLegacyLogs.length && rawLegacyLogs[rawIdx] !== undefined
        ? rawLegacyLogs[rawIdx]
        : w;
    if (existingSub) {
      if (stableJson(existingSub) === winnerJsonById.get(id)) continue;
      if (!canUpdateSubcollectionLog(existingSub, raw as ApplicationLog)) {
        blockedWinnerIds.add(id);
        continue;
      }
    }
    // Migrate the winner unless the caller omitted an unreviewed log (expired hold deletion).
    if (nextIds.has(id) || isLogReviewed(w)) {
      queuedWinnerIds.add(id);
      const item: LegacyWinnerToMigrate = { id, log: w, raw };
      if (needsScanForUnreviewedCreate && !existingSub && !isLogReviewed(w)) {
        const nextLog = nextById.get(id);
        const callerEdited = Boolean(nextLog && stableJson(nextLog) !== winnerJsonById.get(id));
        if (callerEdited) {
          editedScanCandidates.push(item);
        } else {
          unchangedScanCandidates.push(item);
        }
      } else {
        directCandidates.push(item);
      }
    }
  }

  winnersToCreate.push(...directCandidates);
  const scanOrdered = [...editedScanCandidates, ...unchangedScanCandidates];
  for (let i = 0; i < scanOrdered.length; i++) {
    if (i < MAX_DEDUPE_CLEANUP_BATCH) {
      winnersToCreate.push(scanOrdered[i]);
    } else {
      deferredIds.add(scanOrdered[i].id);
    }
  }

  const rawAt = (i: number): ApplicationLog =>
    (i < rawLegacyLogs.length && rawLegacyLogs[i] !== undefined
      ? rawLegacyLogs[i]
      : legacyLogs[i]) as ApplicationLog;

  const removableIndices: number[] = [];
  const removableSet = new Set<number>();
  for (let i = 0; i < legacyLogs.length; i++) {
    const c = legacyLogs[i];
    const isWinnerCopy = stableJson(c) === winnerJsonById.get(c.id);
    if (
      !deferredIds.has(c.id) &&
      ((isWinnerCopy && !blockedWinnerIds.has(c.id)) ||
        (!isWinnerCopy && setAsideOk && !isLogReviewed(c)))
    ) {
      removableIndices.push(i);
      removableSet.add(i);
    }
  }

  const remainingLegacy: ApplicationLog[] = legacyLogs
    .map((_, i) => i)
    .filter((i) => !removableSet.has(i))
    .map(rawAt);

  if (removableIndices.length === 0) {
    return { winnersToCreate, drainBatches: [], remainingLegacy, blockedWinnerIds };
  }

  // Group identical removable entries together so dropping a group removes all copies of that
  // raw JSON value at once; each batch drops <= MAX_DEDUPE_CLEANUP_BATCH total indices.
  const keptJsons = new Set(remainingLegacy.map((l) => stableJson(l)));
  const zeroCostIndices: number[] = [];
  const groupsByJson = new Map<string, number[]>();
  for (const idx of removableIndices) {
    const json = stableJson(rawAt(idx));
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
    return legacyLogs
      .map((_, i) => i)
      .filter((i) => !dropped.has(i))
      .map(rawAt);
  });

  return { winnersToCreate, drainBatches, remainingLegacy, blockedWinnerIds };
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
