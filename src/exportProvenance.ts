/**
 * Export provenance (#7): make CSV/PDF exports and JSON backups self-describing
 * for an office handing records to TDA. Metadata only — never adds TDA row
 * columns. All dates/times are device-local (any timezone) with UTC offset.
 */

import { localDateYmd } from "./dates";

export type ExportSourceKind = "local" | "shared" | "shared-fallback-local";

export interface ExportProvenance {
  source: ExportSourceKind;
  sourceLabel: string;
  /** Shared shop id/code when the export came from (or tried) a shared shop. */
  shopId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  rangeLabel: string;
  recordCount: number;
  /** Device-local ISO timestamp with UTC offset, e.g. 2026-09-26T13:05:00-05:00. */
  generatedAt: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Device-local ISO-8601 timestamp with numeric UTC offset (not Z). */
export function localIsoWithOffset(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return (
    `${localDateYmd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function sourceLabelFor(kind: ExportSourceKind): string {
  if (kind === "shared") return "Shared shop snapshot";
  if (kind === "shared-fallback-local") {
    return "This device's local copy (shared shop pull failed — may not match the full shop)";
  }
  return "This device's local copy";
}

export function buildExportProvenance(input: {
  kind: ExportSourceKind;
  shopId?: string | null;
  dateFrom?: string;
  dateTo?: string;
  recordCount: number;
  /** Overrides the range label (e.g. full JSON backup). */
  rangeLabel?: string;
  now?: Date;
}): ExportProvenance {
  // Same bound rules as filterLogsByDateUsed: non-YYYY-MM-DD input is ignored.
  const from = input.dateFrom?.trim() ?? "";
  const to = input.dateTo?.trim() ?? "";
  const dateFrom = YMD.test(from) ? from : null;
  const dateTo = YMD.test(to) ? to : null;
  let rangeLabel = "All dates";
  if (dateFrom && dateTo) rangeLabel = `${dateFrom} to ${dateTo}`;
  else if (dateFrom) rangeLabel = `From ${dateFrom}`;
  else if (dateTo) rangeLabel = `Through ${dateTo}`;
  const shopId = input.kind === "local" ? null : input.shopId?.trim() || null;
  return {
    source: input.kind,
    sourceLabel: sourceLabelFor(input.kind),
    shopId,
    dateFrom,
    dateTo,
    rangeLabel: input.rangeLabel ?? rangeLabel,
    recordCount: input.recordCount,
    generatedAt: localIsoWithOffset(input.now),
  };
}

/** Human-readable lines for the PDF provenance block. */
export function provenanceLines(p: ExportProvenance): string[] {
  const lines = [`Source: ${p.sourceLabel}`];
  if (p.shopId) lines.push(`Shop ID: ${p.shopId}`);
  lines.push(
    `Date range (date used): ${p.rangeLabel}`,
    `Records: ${p.recordCount}`,
    `Generated: ${p.generatedAt} (device-local time)`,
  );
  return lines;
}

/** One-line summary for the repeating PDF footer. */
export function provenanceSummary(p: ExportProvenance): string {
  const src =
    p.source === "shared"
      ? "shared shop snapshot"
      : p.source === "shared-fallback-local"
        ? "local copy (shared pull failed)"
        : "this device's local copy";
  const shop = p.shopId ? ` · shop ${p.shopId}` : "";
  return `Source: ${src}${shop} · Range: ${p.rangeLabel} · ${p.recordCount} record${p.recordCount === 1 ? "" : "s"} · Generated ${p.generatedAt}`;
}

function sourceTag(kind: ExportSourceKind): string {
  if (kind === "shared") return "shared";
  if (kind === "shared-fallback-local") return "local-fallback";
  return "local";
}

function rangeTag(p: ExportProvenance): string {
  if (p.dateFrom && p.dateTo) return `${p.dateFrom}_to_${p.dateTo}`;
  if (p.dateFrom) return `from-${p.dateFrom}`;
  if (p.dateTo) return `through-${p.dateTo}`;
  return "all-dates";
}

/**
 * Filename suffix: `<range>-<source>-generated-<local YYYY-MM-DD>`.
 * Pass `withRange: false` for full backups (no date filter).
 */
export function provenanceFileSuffix(p: ExportProvenance, withRange = true): string {
  const generatedYmd = p.generatedAt.slice(0, 10);
  const parts = withRange ? [rangeTag(p)] : [];
  parts.push(sourceTag(p.source), `generated-${generatedYmd}`);
  return parts.join("-");
}
