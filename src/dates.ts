/** Device-local calendar dates (YYYY-MM-DD). Not UTC-only, not Central-pinned. */

export function localDateYmd(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD as a local calendar day (noon local avoids DST edge cases). */
export function parseLocalYmd(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d, 12, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** Whole local calendar days from today to the given YMD (negative = past). */
export function daysUntilLocal(ymd: string, today = new Date()): number | null {
  const target = parseLocalYmd(ymd);
  if (!target) return null;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0);
  const ms = target.getTime() - start.getTime();
  return Math.round(ms / 86_400_000);
}

export type DueStatus = "ok" | "soon" | "overdue" | "missing";

/** License: past due or within 30 local calendar days. Not a TDA-required window. */
export function licenseDueStatus(ymd: string | null | undefined, withinDays = 30): DueStatus {
  if (!ymd || !String(ymd).trim()) return "missing";
  const days = daysUntilLocal(String(ymd));
  if (days === null) return "missing";
  if (days < 0) return "overdue";
  if (days <= withinDays) return "soon";
  return "ok";
}

/**
 * CE: separate from the license 30-day window. CEUs are calendar-year, so a
 * "soon" warning surfaces in device-local Nov/Dec when the CE due date falls in
 * the current local year. Overdue always warns. Not a TDA-required window.
 */
export function ceDueStatus(ymd: string | null | undefined, today = new Date()): DueStatus {
  if (!ymd || !String(ymd).trim()) return "missing";
  const days = daysUntilLocal(String(ymd), today);
  if (days === null) return "missing";
  if (days < 0) return "overdue";
  const target = parseLocalYmd(String(ymd));
  if (!target) return "missing";
  const month = today.getMonth(); // 0-based; 10=Nov, 11=Dec
  const inYearEndWindow = month >= 10;
  if (inYearEndWindow && target.getFullYear() === today.getFullYear()) return "soon";
  return "ok";
}

export function formatLicenseDueLabel(ymd: string): string | null {
  const status = licenseDueStatus(ymd);
  if (status === "missing" || status === "ok") return null;
  const days = daysUntilLocal(ymd);
  if (days === null) return null;
  if (status === "overdue") {
    const n = Math.abs(days);
    return `License overdue by ${n} day${n === 1 ? "" : "s"} (${ymd})`;
  }
  return `License due in ${days} day${days === 1 ? "" : "s"} (${ymd})`;
}

export function formatCeDueLabel(ymd: string, today = new Date()): string | null {
  const status = ceDueStatus(ymd, today);
  if (status === "missing" || status === "ok") return null;
  const days = daysUntilLocal(ymd, today);
  if (days === null) return null;
  if (status === "overdue") {
    const n = Math.abs(days);
    return `CE overdue by ${n} day${n === 1 ? "" : "s"} (${ymd})`;
  }
  return `CE due this calendar year (${ymd}) — year-end reminder`;
}


/** First and last YYYY-MM-DD of the device-local calendar month containing `d`. */
export function monthRangeLocal(d = new Date()): { from: string; to: string } {
  const y = d.getFullYear();
  const m = d.getMonth();
  const from = localDateYmd(new Date(y, m, 1, 12, 0, 0, 0));
  const to = localDateYmd(new Date(y, m + 1, 0, 12, 0, 0, 0));
  return { from, to };
}

/**
 * Filter logs by dateUsed with device-local YYYY-MM-DD string comparison.
 * Empty from/to means unbounded on that side. Invalid dateUsed strings are excluded when a bound is set.
 */
export function filterLogsByDateUsed<T extends { dateUsed: string }>(
  logs: T[],
  from: string,
  to: string,
): T[] {
  const fromTrim = from.trim();
  const toTrim = to.trim();
  if (!fromTrim && !toTrim) return logs;
  return logs.filter((log) => {
    const d = String(log.dateUsed ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    if (fromTrim && d < fromTrim) return false;
    if (toTrim && d > toTrim) return false;
    return true;
  });
}
