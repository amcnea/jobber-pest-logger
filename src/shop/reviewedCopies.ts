/**
 * #212: office note when the shared shop doc holds two or more reviewed copies of one
 * log id that don't match (exact copies don't count). #211 shows the winner and sets
 * the others aside; the #208 rules don't let anyone delete a reviewed copy, so the
 * stray stays in the doc and this note tells the office to take a look.
 *
 * Every shared read (RemoteShopStore) re-records the shop's conflicts from the stored
 * logs, so the note survives reloads and clears on the first read after the doc no
 * longer holds the duplicate. Stored per shop id; this device only; not exported.
 */

import { isLogReviewed } from "../reviewQueue";
import type { ApplicationLog } from "../types";
import { dedupeLogsById, revisionOf } from "./dedupeLogs";
import { loadShopSession } from "./session";

export const REVIEWED_COPIES_KEY = "jobber-pest-logger:reviewed-copies:v1";

/** How the shown copy was picked: by revision (tie-break step 2) or anything after it. */
export type ReviewedCopiesPick = "revision" | "other";

/** Lawgical wording (#212), word for word. */
export function reviewedCopiesNote(pick: ReviewedCopiesPick): string {
  return pick === "revision"
    ? "Needs a look: the shop data has two reviewed versions of this log that don't match. This app shows the higher revision. The other is set aside and kept in the backup JSON."
    : "Needs a look: the shop data has two reviewed versions of this log that don't match. This app shows the one picked by revision and review date. The other is set aside and kept in the backup JSON.";
}

/**
 * Ids whose winner and at least one non-identical copy are both reviewed. "revision"
 * only when every such copy lost on revision; otherwise "other".
 */
export function findReviewedCopyConflicts(logs: readonly ApplicationLog[]): Record<string, ReviewedCopiesPick> {
  const { logs: winners, losers } = dedupeLogsById(logs);
  const out: Record<string, ReviewedCopiesPick> = {};
  if (losers.length === 0) return out;
  const byId = new Map(winners.map((w) => [w.id, w]));
  for (const { log, identical } of losers) {
    const winner = byId.get(log.id);
    if (identical || !winner || !isLogReviewed(winner) || !isLogReviewed(log)) continue;
    const pick: ReviewedCopiesPick = revisionOf(winner) !== revisionOf(log) ? "revision" : "other";
    out[log.id] = out[log.id] === "other" ? "other" : pick;
  }
  return out;
}

type Stored = Record<string, Record<string, ReviewedCopiesPick>>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(REVIEWED_COPIES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

/** Replace this shop's entry with what the stored logs show now (removed when none). */
export function recordReviewedCopyConflicts(shopId: string, storedLogs: readonly ApplicationLog[]): void {
  const id = shopId.trim();
  if (!id) return;
  const found = findReviewedCopyConflicts(storedLogs);
  const all = readAll();
  const had = id in all;
  if (Object.keys(found).length === 0) {
    if (!had) return;
    delete all[id];
  } else {
    all[id] = found;
  }
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(REVIEWED_COPIES_KEY);
    else localStorage.setItem(REVIEWED_COPIES_KEY, JSON.stringify(all));
  } catch {
    // Display-only flag: the next read tries again.
  }
}

/** Conflicts recorded for a shop (default: the current shop session). */
export function loadReviewedCopyConflicts(shopId: string = loadShopSession().shopId): Record<string, ReviewedCopiesPick> {
  const entry = readAll()[shopId.trim()];
  const out: Record<string, ReviewedCopiesPick> = {};
  if (!entry || typeof entry !== "object") return out;
  for (const [logId, pick] of Object.entries(entry)) {
    if (pick === "revision" || pick === "other") out[logId] = pick;
  }
  return out;
}

/** Note text for a log, or null. */
export function reviewedCopiesNoteFor(logId: string, conflicts = loadReviewedCopyConflicts()): string | null {
  const pick = conflicts[logId];
  return pick ? reviewedCopiesNote(pick) : null;
}
