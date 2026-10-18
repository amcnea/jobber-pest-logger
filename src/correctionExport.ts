// Change-history text for CSV/PDF exports, built only from the stored model
// (revision + history corrections, and re-upload records). Logs with neither produce
// nothing here, so their export output stays exactly as it was before.
import type { ApplicationLog, AppliedProduct, CorrectionEntry, FieldChange, LogSnapshot, ReuploadRecord } from "./types";

/** CSV columns appended only when an export includes a log with change history. Not TDA fields. */
export const CORRECTION_CSV_COLUMNS = [
  "Correction status (not TDA-required)",
  "Change history (not TDA-required)",
] as const;

export const REUPLOADED_LABEL = "Re-uploaded";

export function isCorrectedLog(log: ApplicationLog): boolean {
  return (log.revision ?? 0) > 0 || (log.history?.length ?? 0) > 0;
}

export function isReuploadedLog(log: ApplicationLog): boolean {
  return (log.reuploads?.length ?? 0) > 0;
}

/** Corrected or re-uploaded: the export shows a change-history section for it. */
export function hasChangeHistory(log: ApplicationLog): boolean {
  return isCorrectedLog(log) || isReuploadedLog(log);
}

/** "Corrected (rev N)" or "" for uncorrected logs. */
export function correctedLabel(log: ApplicationLog): string {
  if (!isCorrectedLog(log)) return "";
  const rev = log.revision ?? log.history?.at(-1)?.revision ?? 0;
  return `Corrected (rev ${rev})`;
}

/** "Corrected (rev N)", "Re-uploaded", both joined by "; ", or "". */
export function changeStatusLabel(log: ApplicationLog): string {
  return [correctedLabel(log), isReuploadedLog(log) ? REUPLOADED_LABEL : ""].filter(Boolean).join("; ");
}

// ---------------------------------------------------------------------------
// Field labels: the same labels the CSV export uses for each column (csv.ts
// TDA_CSV_COLUMNS). Product-line fields read "<product name>: <column label>".
// ---------------------------------------------------------------------------

/** Top-level log fields → CSV column label. */
export const LOG_FIELD_LABELS: Readonly<Record<string, string>> = {
  customerBillingName: "Customer billing name",
  customerBillingAddress: "Customer billing address",
  serviceAddress: "Service address",
  poleLocation: "Pole location (utility-pole retreatment)",
  targetPestOrPurpose: "Target pest or purpose",
  dateUsed: "Date used",
  shopTpclNumber: "Shop TPCL number",
  shopTpclLetter: "Shop TPCL letter",
  isTermite: "Termite work",
  jobberJobNumber: "Jobber job # (optional, not TDA-required)",
  jobberAddress: "Jobber address paste (optional, not TDA-required)",
};

/** `termite.<key>` → CSV column label. */
export const TERMITE_FIELD_LABELS: Readonly<Record<string, string>> = {
  areaTreatedSqFt: "Area treated (sq ft; blank if bait)",
  isBait: "Termite bait",
  physicalBarrierMeasurement: "Physical-barrier measurement",
  diagramNote: "Diagram note (text, not a drawing)",
  isCommercialPretreat: "Commercial pretreat (not baits/wood/barriers)",
  tankCount: "Pretreat tank count",
  tankGallons: "Pretreat tank gallons",
  startTime: "Pretreat start time",
  stopTime: "Pretreat stop time",
};

/** `personnel[<role>].<key>` → CSV column label. */
export const PERSONNEL_FIELD_LABELS: Readonly<Record<string, string>> = {
  "applying.name": "Person applying — name",
  "applying.licenseNumber": "Person applying — license number",
  "supervising.name": "Person supervising — name",
  "supervising.licenseNumber": "Person supervising — license number",
  "receiving_training.name": "Person receiving training — name",
  "receiving_training.licenseNumber": "Person receiving training — license number",
};

/**
 * `products[<lineId>].<key>` → CSV column label. `name` depends on the line
 * (device lines export under "Devices used"). Amount and unit share one column.
 */
export const PRODUCT_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Pesticide names",
  epaRegNo: "EPA registration numbers (blank if 25(b) / unregistered; example seeds labeled)",
  is25b: "25(b) or unregistered products",
  isExample: "Example catalog items (not real EPA numbers)",
  rtuAmount: "RTU total amount (AI % unchanged)",
  rtuUnit: "RTU total amount (AI % unchanged)",
  mixingRate: "Mixing rate",
  percentAi: "Percent AI",
  mixedTotal: "Total material applied (mixed)",
  mixedUnit: "Total material applied (mixed)",
  deviceCount: "Device counts",
};
export const DEVICE_NAME_LABEL = "Devices used";
/** Product-line keys with no export column: shown as "<product name>: <key>". */
const PRODUCT_KEYS_WITHOUT_COLUMN = new Set(["method", "catalogId"]);

type Version = Pick<LogSnapshot, "products"> | undefined;

/** "<product name>" from the version that has the line (after first), else "Product N". */
function productHeading(lineId: string, after: Version, before: Version): { text: string; line?: AppliedProduct } {
  for (const version of [after, before]) {
    const idx = version?.products.findIndex((p) => p.lineId === lineId) ?? -1;
    if (version && idx !== -1) {
      const line = version.products[idx];
      return { text: line.name.trim() || `Product ${idx + 1}`, line };
    }
  }
  return { text: "" };
}

/**
 * Readable label for a stored change path. `after` / `before` are the log as it stood
 * after / before the change (for product names). Unknown paths come back as-is.
 */
export function fieldLabel(path: string, after?: Version, before?: Version): string {
  if (LOG_FIELD_LABELS[path]) return LOG_FIELD_LABELS[path];
  const termite = /^termite\.(\w+)$/.exec(path);
  if (termite && TERMITE_FIELD_LABELS[termite[1]]) return TERMITE_FIELD_LABELS[termite[1]];
  const person = /^personnel\[([a-z_]+)\]\.(\w+)$/.exec(path);
  if (person && PERSONNEL_FIELD_LABELS[`${person[1]}.${person[2]}`]) {
    return PERSONNEL_FIELD_LABELS[`${person[1]}.${person[2]}`];
  }
  const product = /^products\[(.+)\]\.(\w+)$/.exec(path);
  if (product && (PRODUCT_FIELD_LABELS[product[2]] || PRODUCT_KEYS_WITHOUT_COLUMN.has(product[2]))) {
    const heading = productHeading(product[1], after, before);
    if (heading.text) {
      const column =
        product[2] === "name" && heading.line?.method === "device"
          ? DEVICE_NAME_LABEL
          : (PRODUCT_FIELD_LABELS[product[2]] ?? product[2]);
      return `${heading.text}: ${column}`;
    }
  }
  return path;
}

function valueText(v: FieldChange["old"]): string {
  if (v === null || v === "") return "(blank)";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** "label: old → new". The PDF passes "->" because its built-in font has no arrow glyph. */
export function changeText(change: FieldChange, arrow = "→", after?: Version, before?: Version): string {
  return `${fieldLabel(change.field, after, before)}: ${valueText(change.old)} ${arrow} ${valueText(change.new)}`;
}

export function entryHeading(entry: CorrectionEntry, sep = "·"): string {
  return `Rev ${entry.revision} ${sep} ${entry.changedAt} ${sep} ${entry.changedBy} ${sep} Reason: ${entry.reason}`;
}

export function reuploadHeading(record: ReuploadRecord, sep = "·"): string {
  return `${REUPLOADED_LABEL} ${sep} ${record.reuploadedAt} ${sep} ${record.reuploadedBy} ${sep} Reason: ${record.reason}`;
}

type HistoryItem =
  | { kind: "correction"; at: number; entry: CorrectionEntry; after: Version; before: Version }
  | { kind: "reupload"; at: number; record: ReuploadRecord };

/** Corrections and re-uploads, oldest first (stable: corrections before re-uploads on ties). */
function historyItems(log: ApplicationLog): HistoryItem[] {
  const history = log.history ?? [];
  const items: HistoryItem[] = history.map((entry, i) => ({
    kind: "correction",
    at: Date.parse(entry.changedAt),
    entry,
    after: history[i + 1]?.priorSnapshot ?? log,
    before: entry.priorSnapshot,
  }));
  for (const record of log.reuploads ?? []) {
    items.push({ kind: "reupload", at: Date.parse(record.reuploadedAt), record });
  }
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.at - b.item.at) || (a.i - b.i))
    .map(({ item }) => item);
}

/** One CSV cell: items oldest first, separated by " | "; changes within an entry by "; ". */
export function changeHistoryCell(log: ApplicationLog): string {
  return historyItems(log)
    .map((item) => {
      if (item.kind === "reupload") return reuploadHeading(item.record);
      const changes = item.entry.changes.map((c) => changeText(c, "→", item.after, item.before)).join("; ");
      return changes ? `${entryHeading(item.entry)} · ${changes}` : entryHeading(item.entry);
    })
    .join(" | ");
}

/** PDF lines for a log with change history (heading + lines per item); [] otherwise. */
export function changeHistoryPdfLines(log: ApplicationLog): string[] {
  if (!hasChangeHistory(log)) return [];
  const out = ["Change history (original values kept):"];
  for (const item of historyItems(log)) {
    if (item.kind === "reupload") {
      out.push(`  ${reuploadHeading(item.record, "—")}`);
      continue;
    }
    out.push(`  ${entryHeading(item.entry, "—")}`);
    for (const c of item.entry.changes) out.push(`    ${changeText(c, "->", item.after, item.before)}`);
  }
  return out;
}
