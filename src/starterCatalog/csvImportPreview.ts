/**
 * Slice 2 of the shop-catalog CSV import: pure preview + duplicate check.
 *
 * Takes the slice-1 parser result and the shop's current catalog and marks
 * each parsed row as a duplicate (of a shop row, or of an earlier row in the
 * same file) or not. Nothing here saves. Duplicate rows and rows with a blank
 * name are left out of the import by default. EPA reg # checks are format-only.
 */
import type { ShopProduct } from "../types";
import { TEXAS_COMMON_STARTER } from "./texasCommon";
import type { StarterProduct } from "./types";
import {
  CSV_FIELD_LABELS,
  CSV_UNUSED_COLUMN_NOTES_MAX,
  epaRegNoFormatOk,
  type CsvCandidate,
  type CsvImportResult,
} from "./csvImport";

/** Lowercase, drop all whitespace, and treat any dash-like character as "-". */
export function normalizeImportEpa(epa: string | null | undefined): string {
  return String(epa ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, "");
}

/** Lowercase, trim, and collapse inner whitespace. */
export function normalizeImportName(name: string | null | undefined): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * The EPA reg # a candidate would be saved with. Matches how the shop list
 * stores rows: 25(b) and device rows never keep an EPA reg #.
 */
export function effectiveImportEpa(candidate: Pick<CsvCandidate, "epaRegNo" | "is25b" | "kind">): string | null {
  if (candidate.kind === "device" || candidate.is25b) return null;
  const epa = (candidate.epaRegNo ?? "").trim();
  return epa === "" ? null : epa;
}

/**
 * Starter-match key for an EPA reg #: trim, lowercase, and drop whitespace only.
 * No other rewriting (dashes, leading zeros, suffixes), so the match is on the FULL
 * reg #: "8033-109-279" never matches "8033-109", and vice versa.
 */
export function starterMatchKey(epa: string | null | undefined): string {
  return String(epa ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

let starterByEpa: Map<string, StarterProduct> | null = null;

/** Map of starter reg # key -> first starter row with it. Built once, on first use. */
function starterEpaMap(): Map<string, StarterProduct> {
  if (starterByEpa) return starterByEpa;
  const map = new Map<string, StarterProduct>();
  for (const starter of TEXAS_COMMON_STARTER) {
    const key = starterMatchKey(starter.epaRegNo);
    if (key && !map.has(key)) map.set(key, starter);
  }
  starterByEpa = map;
  return map;
}

/**
 * Texas-common starter row whose reg # equals this candidate's (whole reg #, only
 * whitespace/case ignored), or null. Uses the reg # the row would be saved with, so
 * 25(b) and device rows never match. Offered only when the starter is the same kind
 * and not 25(b), so swapping the name never changes type or reg # handling.
 */
export function findStarterRegMatch(candidate: CsvCandidate): StarterProduct | null {
  const key = starterMatchKey(effectiveImportEpa(candidate));
  if (!key) return null;
  const starter = starterEpaMap().get(key);
  if (!starter || starter.kind !== candidate.kind || starter.is25b) return null;
  return starter;
}

export interface CsvPreviewRow {
  line: number;
  candidate: CsvCandidate;
  /** Parser problems for this row, as "Needs a look: …" messages. */
  problems: string[];
  /** "Needs a look: …" when this row duplicates a shop row or an earlier file row. */
  duplicate: string | null;
  /** EPA reg # (as given) passes the format check. False when blank. */
  epaFormatOk: boolean;
  /** Row can be added at all (has a name). */
  addable: boolean;
  /** Included in the import unless the user changes it. */
  includeByDefault: boolean;
  /**
   * Starter row with the same full reg #, if any. Informational: the file's name is
   * kept unless the office opts in per row ("Use starter name").
   */
  starterMatch: { id: string; name: string } | null;
}

export interface CsvImportPreview {
  rows: CsvPreviewRow[];
  fileProblems: string[];
  /** Mapped columns in header order: the file's header and the plain label it is read as. */
  columns: { header: string; label: string }[];
  /** How many columns are not used (each also has a "Needs a look" file note). */
  unusedColumns: number;
  /** How many of fileProblems are unused-column notes (capped notes plus any roll-up note). */
  unusedColumnNotes: number;
}

function shopMatch(
  catalog: ShopProduct[],
  epa: string,
  name: string,
): { product: ShopProduct; by: "epa" | "name" } | null {
  if (epa) {
    const byEpa = catalog.find((p) => normalizeImportEpa(p.epaRegNo) === epa);
    if (byEpa) return { product: byEpa, by: "epa" };
  }
  if (name) {
    const byName = catalog.find((p) => normalizeImportName(p.name) === name);
    if (byName) return { product: byName, by: "name" };
  }
  return null;
}

/** Shop-list duplicate message for a match (shared by preview and add-time recheck). */
function shopDuplicateMessage(match: { product: ShopProduct; by: "epa" | "name" }): string {
  return match.by === "epa"
    ? `Needs a look: same EPA reg # as "${match.product.name}" on your shop list.`
    : `Needs a look: same name as a product on your shop list.`;
}

/**
 * "Needs a look: …" when this candidate now matches a shop row (same
 * normalized effective EPA reg # or normalized name rules as the preview),
 * else null. Used right before saving, against the current catalog plus rows
 * already added in the same run (#178).
 */
export function findShopDuplicate(candidate: CsvCandidate, catalog: ShopProduct[]): string | null {
  const match = shopMatch(
    catalog,
    normalizeImportEpa(effectiveImportEpa(candidate)),
    normalizeImportName(candidate.name),
  );
  return match ? shopDuplicateMessage(match) : null;
}

/**
 * Build the preview list. A row is a duplicate when its normalized EPA reg #
 * or normalized name matches a shop row, or an earlier row in the file. The
 * first row in the file wins; later copies are marked.
 */
export function buildCsvImportPreview(result: CsvImportResult, catalog: ShopProduct[]): CsvImportPreview {
  const seenEpa = new Map<string, number>();
  const seenName = new Map<string, number>();
  const rows: CsvPreviewRow[] = result.rows.map((row) => {
    const { candidate } = row;
    const epa = normalizeImportEpa(effectiveImportEpa(candidate));
    const name = normalizeImportName(candidate.name);
    let duplicate: string | null = null;
    const match = shopMatch(catalog, epa, name);
    if (match) {
      duplicate = shopDuplicateMessage(match);
    } else {
      const earlierEpa = epa ? seenEpa.get(epa) : undefined;
      const earlierName = name ? seenName.get(name) : undefined;
      if (earlierEpa !== undefined) {
        duplicate = `Needs a look: same EPA reg # as line ${earlierEpa} in this file.`;
      } else if (earlierName !== undefined) {
        duplicate = `Needs a look: same name as line ${earlierName} in this file.`;
      }
    }
    if (epa && !seenEpa.has(epa)) seenEpa.set(epa, row.line);
    if (name && !seenName.has(name)) seenName.set(name, row.line);
    const addable = candidate.name.trim() !== "";
    return {
      line: row.line,
      candidate,
      problems: row.problems.map((p) => p.message),
      duplicate,
      epaFormatOk: candidate.epaRegNo !== null && epaRegNoFormatOk(candidate.epaRegNo),
      addable,
      includeByDefault: addable && duplicate === null,
      starterMatch: (() => {
        const starter = findStarterRegMatch(candidate);
        return starter ? { id: starter.id, name: starter.name } : null;
      })(),
    };
  });
  return {
    rows,
    fileProblems: result.fileProblems,
    columns: result.columns.map((c) => ({ header: c.header, label: CSV_FIELD_LABELS[c.field] })),
    unusedColumns: result.ignoredColumns.length,
    unusedColumnNotes:
      result.ignoredColumns.length > CSV_UNUSED_COLUMN_NOTES_MAX
        ? CSV_UNUSED_COLUMN_NOTES_MAX + 1
        : result.ignoredColumns.length,
  };
}

/**
 * Candidate to save for a preview row: the file's own row, or, only when the office
 * ticked "Use starter name" for that row, the same row with the starter's name.
 * Reg #, 25(b), type, archived and isExample are never changed here.
 */
export function candidateForImport(row: Pick<CsvPreviewRow, "candidate" | "starterMatch">, useStarterName: boolean): CsvCandidate {
  if (!useStarterName || !row.starterMatch) return row.candidate;
  return { ...row.candidate, name: row.starterMatch.name };
}

/** Shop row to save for an included preview row: always archived, never an example. */
export function csvCandidateToShopProduct(candidate: CsvCandidate, id: string): ShopProduct {
  return {
    id,
    name: candidate.name.trim(),
    epaRegNo: effectiveImportEpa(candidate),
    is25b: candidate.kind === "device" ? false : candidate.is25b,
    kind: candidate.kind,
    isExample: false,
    archived: true,
  };
}
