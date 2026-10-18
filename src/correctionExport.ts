// Change-history text for CSV/PDF exports, built only from the stored correction
// model (revision + history). Uncorrected logs produce nothing here, so their
// export output stays exactly as it was before corrections existed.
import type { ApplicationLog, CorrectionEntry, FieldChange } from "./types";

/** CSV columns appended only when an export includes at least one corrected log. Not TDA fields. */
export const CORRECTION_CSV_COLUMNS = [
  "Correction status (not TDA-required)",
  "Change history (not TDA-required)",
] as const;

export function isCorrectedLog(log: ApplicationLog): boolean {
  return (log.revision ?? 0) > 0 || (log.history?.length ?? 0) > 0;
}

/** "Corrected (rev N)" or "" for uncorrected logs. */
export function correctedLabel(log: ApplicationLog): string {
  if (!isCorrectedLog(log)) return "";
  const rev = log.revision ?? log.history?.at(-1)?.revision ?? 0;
  return `Corrected (rev ${rev})`;
}

function valueText(v: FieldChange["old"]): string {
  if (v === null || v === "") return "(blank)";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** "field: old → new". The PDF passes "->" because its built-in font has no arrow glyph. */
export function changeText(change: FieldChange, arrow = "→"): string {
  return `${change.field}: ${valueText(change.old)} ${arrow} ${valueText(change.new)}`;
}

export function entryHeading(entry: CorrectionEntry, sep = "·"): string {
  return `Rev ${entry.revision} ${sep} ${entry.changedAt} ${sep} ${entry.changedBy} ${sep} Reason: ${entry.reason}`;
}

/** One CSV cell: entries oldest first, separated by " | "; changes within an entry by "; ". */
export function changeHistoryCell(log: ApplicationLog): string {
  return (log.history ?? [])
    .map((entry) => {
      const changes = entry.changes.map((c) => changeText(c)).join("; ");
      return changes ? `${entryHeading(entry)} · ${changes}` : entryHeading(entry);
    })
    .join(" | ");
}

/** PDF lines for a corrected log (heading + one indented line per change); [] when uncorrected. */
export function changeHistoryPdfLines(log: ApplicationLog): string[] {
  if (!isCorrectedLog(log)) return [];
  const out = ["Change history (original values kept):"];
  for (const entry of log.history ?? []) {
    out.push(`  ${entryHeading(entry, "—")}`);
    for (const c of entry.changes) out.push(`    ${changeText(c, "->")}`);
  }
  return out;
}
