/**
 * 2-year record keeping guard (4 TAC § 7.144 record keeping: application records are
 * kept for 2 years). A log may be deleted in the app only on or after its
 * `retainUntil`: the local calendar date 2 years after the latest of its current
 * dateUsed, every earlier dateUsed (stored copies, change history) and createdAt.
 * retainUntil only ever moves later, so editing the date back never shortens the hold.
 *
 * Leap day: an application on Feb 29 reaches 2 years on Mar 1 (the later of the two
 * choices), so a record is never deletable before 2 full years have passed.
 *
 * Example-only logs (every product an example seed, i.e. demo data) are not real
 * application records and are not held by this guard.
 */
import { inferIsExample, logHasExampleProducts } from "./catalog";
import { localDateYmd, parseLocalYmd } from "./dates";
import type { ApplicationLog } from "./types";

export const RETENTION_YEARS = 2;

/** YYYY-MM-DD two years after `ymd` (Feb 29 → Mar 1), or null if `ymd` is not a valid date. */
export function retentionEndYmd(ymd: string): string | null {
  const start = parseLocalYmd(ymd);
  if (!start) return null;
  const y = start.getFullYear() + RETENTION_YEARS;
  const m = start.getMonth();
  const d = start.getDate();
  const end = new Date(y, m, d, 12, 0, 0, 0);
  // Feb 29 into a non-leap year rolls to Mar 1 (Date does this; keep it explicit).
  if (end.getMonth() !== m) return localDateYmd(new Date(y, m + 1, 1, 12));
  return localDateYmd(end);
}

/** Application date: dateUsed, else the local date of createdAt; null when neither is readable. */
export function applicationDateYmd(log: Pick<ApplicationLog, "dateUsed" | "createdAt">): string | null {
  if (parseLocalYmd(log.dateUsed ?? "")) return log.dateUsed.trim();
  const created = Date.parse(log.createdAt ?? "");
  return Number.isNaN(created) ? null : localDateYmd(new Date(created));
}

/** Every product is an example seed (or a sample log with no products): demo data. */
export function isExampleOnlyLog(log: Pick<ApplicationLog, "sampleData" | "products">): boolean {
  const hadExamples = log.sampleData === true || logHasExampleProducts(log.products);
  return (
    hadExamples &&
    log.products.every((p) => inferIsExample({ isExample: p.isExample, catalogId: p.catalogId, epaRegNo: p.epaRegNo }))
  );
}

function isYmd(value: unknown): value is string {
  return typeof value === "string" && parseLocalYmd(value) !== null;
}

/** Later of two YYYY-MM-DD values (either may be missing). */
export function laterYmd(a: string | null | undefined, b: string | null | undefined): string | null {
  const x = isYmd(a) ? a.trim() : null;
  const y = isYmd(b) ? b.trim() : null;
  if (!x) return y;
  if (!y) return x;
  return x >= y ? x : y;
}

/**
 * retainUntil computed from the log itself: 2 years after the latest of its dateUsed,
 * every dateUsed in its change history (prior snapshots), and the local date of
 * createdAt. Null when none of those is a readable date.
 */
export function computeRetainUntil(
  log: Pick<ApplicationLog, "dateUsed" | "createdAt" | "history">,
): string | null {
  let latest: string | null = isYmd(log.dateUsed) ? log.dateUsed.trim() : null;
  for (const entry of log.history ?? []) latest = laterYmd(latest, entry.priorSnapshot?.dateUsed);
  const created = Date.parse(log.createdAt ?? "");
  if (!Number.isNaN(created)) latest = laterYmd(latest, localDateYmd(new Date(created)));
  return latest ? retentionEndYmd(latest) : null;
}

/**
 * The date (YYYY-MM-DD) from which the log may be deleted: the later of the stored
 * `retainUntil` (which only ever moves later) and the value computed from the log.
 * Older logs without `retainUntil` use the computed value. Null when neither exists.
 */
export function effectiveRetainUntil(
  log: Pick<ApplicationLog, "dateUsed" | "createdAt" | "history" | "retainUntil">,
): string | null {
  return laterYmd(log.retainUntil, computeRetainUntil(log));
}

/** @deprecated Use effectiveRetainUntil. */
export const deletableFromYmd = effectiveRetainUntil;

/**
 * True while the log must be kept: today (device-local) is before its retainUntil.
 * Example-only demo logs are not held unless a retainUntil was stamped on them (e.g. a
 * real log later edited to example seeds). No readable date at all → kept (fail closed).
 */
export function isWithinRetention(log: ApplicationLog, now: Date = new Date()): boolean {
  if (isExampleOnlyLog(log) && !isYmd(log.retainUntil)) return false;
  const until = effectiveRetainUntil(log);
  if (!until) return true;
  return localDateYmd(now) < until;
}

export function countWithinRetention(logs: ApplicationLog[], now: Date = new Date()): number {
  return logs.filter((l) => isWithinRetention(l, now)).length;
}

/** Short reason shown instead of Delete, or null when the log may be deleted. */
export function deleteBlockedReason(log: ApplicationLog, now: Date = new Date()): string | null {
  if (!isWithinRetention(log, now)) return null;
  const from = effectiveRetainUntil(log);
  if (!from) {
    return "Can't delete. This log has no readable application date, and Texas requires keeping records for 2 years from that date.";
  }
  return `Can't delete yet. Texas requires keeping this record for 2 years from the application date. You can delete it on or after ${from}.`;
}

/** Wipe-confirm warning when real logs under 2 years old exist; "" when none. */
export function wipeRetentionWarning(n: number): string {
  if (n <= 0) return "";
  if (n === 1) {
    return "1 log is less than 2 years old. Texas requires the shop to keep this record for 2 years. Download the backup JSON or export first.";
  }
  return `${n} logs are less than 2 years old. Texas requires the shop to keep these records for 2 years. Download the backup JSON or export first.`;
}
