/**
 * Office review queue: per-log "Needs a look: [field]" flags.
 *
 * Only these rules, nothing else (no ranges, no label checks, no rate limits):
 *   a. a required field is blank (reuses the export completeness gate / validateLog);
 *   b. a value that is meant to be parseable does not parse (date, time, numeric amounts);
 *   c. date used (or pretreat start/stop time) is in the future, device-local, vs injected `now`;
 *   d. a rate/amount has no unit;
 *   e. a product line is no longer on the shop list (deleted) or is an example / SAMPLE seed.
 *
 * Pure: no storage, no clock reads unless `now` is omitted.
 */
import { inferIsExample, isExampleShopProduct } from "./catalog";
import { localDateYmd, parseLocalYmd } from "./dates";
import { exportCompletenessIssues, FIELD_LABELS } from "./formDefaults";
import type { ApplicationLog, AppliedProduct, ShopProduct } from "./types";

export type ReviewRule = "blank" | "unparseable" | "future" | "noUnit" | "product";

export interface ReviewFlag {
  rule: ReviewRule;
  /** Human field label (the app's existing labels where one exists). */
  field: string;
  /** User-visible line: exactly "Needs a look: [field]". */
  text: string;
}

export interface ReviewQueueEntry {
  log: ApplicationLog;
  flags: ReviewFlag[];
}

export function needsALookText(field: string): string {
  return `Needs a look: ${field}`;
}

/** Plain decimal / integer, optional sign and thousands commas. No exponent / hex. */
const NUMBER_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;

export function parsesAsNumber(value: string): boolean {
  const v = value.trim();
  if (!v || !/\d/.test(v)) return false;
  return NUMBER_RE.test(v);
}

/** HH:MM or HH:MM:SS (what <input type="time"> stores). Returns minutes since midnight. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function lineLabel(index: number, part: string): string {
  return `Product line ${index + 1}: ${part}`;
}

function productFlags(
  p: AppliedProduct,
  i: number,
  catalogById: Map<string, ShopProduct>,
  add: (rule: ReviewRule, field: string) => void,
): void {
  // b. parseable numeric amounts (blank is left to rule a / optional fields).
  if (p.method === "rtu" && p.rtuAmount.trim() && !parsesAsNumber(p.rtuAmount)) {
    add("unparseable", lineLabel(i, "RTU amount"));
  }
  if (p.method === "mixed") {
    if (p.mixedTotal.trim() && !parsesAsNumber(p.mixedTotal)) {
      add("unparseable", lineLabel(i, "total material applied"));
    }
    if (p.percentAi.trim() && !parsesAsNumber(p.percentAi.replace(/%\s*$/, ""))) {
      add("unparseable", lineLabel(i, "% AI"));
    }
  }
  if (p.method === "device" && p.deviceCount.trim() && !parsesAsNumber(p.deviceCount)) {
    add("unparseable", lineLabel(i, "device count"));
  }

  // d. rate / amount with no unit.
  if (p.method === "rtu" && p.rtuAmount.trim() && !p.rtuUnit.trim()) {
    add("noUnit", lineLabel(i, "unit"));
  }
  if (p.method === "mixed") {
    if (p.mixedTotal.trim() && !p.mixedUnit.trim()) {
      add("noUnit", lineLabel(i, "unit"));
    }
    // Mixing rate is free text ("1 oz / gal"); a bare number carries no unit.
    if (p.mixingRate.trim() && parsesAsNumber(p.mixingRate)) {
      add("noUnit", lineLabel(i, "mixing rate unit"));
    }
  }

  // e. example / SAMPLE seed, or product removed from the shop list.
  const shop = catalogById.get(p.catalogId);
  const isExample =
    inferIsExample({ isExample: p.isExample, catalogId: p.catalogId, epaRegNo: p.epaRegNo }) ||
    (shop !== undefined && isExampleShopProduct(shop));
  if (isExample) {
    add("product", lineLabel(i, "EPA registration number"));
  } else if (!shop) {
    const name = p.name.trim();
    add("product", lineLabel(i, name ? `product (${name})` : "product"));
  }
}

/** Flags for one log. Empty array means nothing needs a look. */
export function reviewFlagsForLog(
  log: ApplicationLog,
  catalog: ShopProduct[],
  now: Date = new Date(),
): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const seen = new Set<string>();
  const add = (rule: ReviewRule, field: string) => {
    if (seen.has(field)) return;
    seen.add(field);
    flags.push({ rule, field, text: needsALookText(field) });
  };

  // a. blank required fields — same check and labels as the export gate.
  const issue = exportCompletenessIssues([log])[0];
  for (const field of issue?.fields ?? []) add("blank", field);

  // b + c. date used.
  const today = localDateYmd(now);
  const dateUsed = log.dateUsed.trim();
  const dateOk = dateUsed ? parseLocalYmd(dateUsed) !== null : false;
  if (dateUsed && !dateOk) add("unparseable", FIELD_LABELS.dateUsed);
  if (dateOk && dateUsed > today) add("future", FIELD_LABELS.dateUsed);

  // Termite (b) extras that are meant to be numbers / times, only when the form shows them.
  if (log.isTermite) {
    const t = log.termite;
    if (!t.isBait && t.areaTreatedSqFt.trim() && !parsesAsNumber(t.areaTreatedSqFt)) {
      add("unparseable", FIELD_LABELS.termiteArea);
    }
    if (!t.isBait && t.isCommercialPretreat) {
      if (t.tankCount.trim() && !parsesAsNumber(t.tankCount)) {
        add("unparseable", FIELD_LABELS.termiteTankCount);
      }
      if (t.tankGallons.trim() && !parsesAsNumber(t.tankGallons)) {
        add("unparseable", FIELD_LABELS.termiteTankGallons);
      }
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const times: [string, string][] = [
        [t.startTime, FIELD_LABELS.termiteStart],
        [t.stopTime, FIELD_LABELS.termiteStop],
      ];
      for (const [value, label] of times) {
        if (!value.trim()) continue;
        const minutes = parseTimeOfDay(value);
        if (minutes === null) {
          add("unparseable", label);
        } else if (dateOk && dateUsed === today && minutes > nowMinutes) {
          // A future date is already flagged on Date used; only same-day times compare clock.
          add("future", label);
        }
      }
    }
  }

  const catalogById = new Map(catalog.map((p) => [p.id, p]));
  log.products.forEach((p, i) => productFlags(p, i, catalogById, add));

  // Export gate also blocks on the saved sampleData marker; surface it if no line explains it.
  if (log.sampleData && !flags.some((f) => f.rule === "product")) {
    add("product", FIELD_LABELS.products);
  }

  return flags;
}

/** Logs with at least one flag, newest date used first. */
export function buildReviewQueue(
  logs: ApplicationLog[],
  catalog: ShopProduct[],
  now: Date = new Date(),
): ReviewQueueEntry[] {
  return logs
    .map((log) => ({ log, flags: reviewFlagsForLog(log, catalog, now) }))
    .filter((e) => e.flags.length > 0)
    .sort((a, b) => {
      const d = b.log.dateUsed.localeCompare(a.log.dateUsed);
      return d !== 0 ? d : b.log.createdAt.localeCompare(a.log.createdAt);
    });
}
