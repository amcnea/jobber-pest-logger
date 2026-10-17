/**
 * Slice 1 of the shop-catalog CSV import: a pure, dependency-free parser.
 *
 * It only turns CSV text into candidate rows plus problems. It never saves,
 * never activates, and never assigns ids. Every candidate is archived and must
 * go through the existing label-confirm flow before a tech can pick it.
 * EPA reg # checks here are format-only.
 */
import type { ProductKind, ShopProduct } from "../types";

export const CSV_IMPORT_MAX_BYTES = 1_000_000;
export const CSV_IMPORT_MAX_ROWS = 2000;

/** Fields a CSV column may map onto — all already exist on ShopProduct. */
export type CsvImportField = "name" | "epaRegNo" | "is25b" | "kind";

const HEADER_ALIASES: Record<CsvImportField, string[]> = {
  name: ["name", "product", "product name", "productname", "item", "item name"],
  epaRegNo: [
    "epa reg no",
    "epa reg #",
    "epa reg",
    "epa #",
    "epa no",
    "epa number",
    "epa reg number",
    "epa registration number",
    "epa registration no",
    "epa registration #",
    "epaRegNo",
    "reg no",
    "reg #",
  ],
  is25b: ["25b", "25(b)", "is 25b", "is25b", "minimum risk", "25(b) exempt", "25b exempt"],
  kind: ["kind", "type", "product type"],
};

export const REQUIRED_CSV_FIELDS: CsvImportField[] = ["name"];

function headerKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*([#()])\s*/g, "$1").replace(/\.$/, "");
}

const ALIAS_LOOKUP = new Map<string, CsvImportField>();
for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [CsvImportField, string[]][]) {
  for (const a of aliases) ALIAS_LOOKUP.set(headerKey(a), field);
}

export function matchCsvHeader(raw: string): CsvImportField | null {
  const key = headerKey(raw);
  return ALIAS_LOOKUP.get(key) ?? ALIAS_LOOKUP.get(key.replace(/\./g, "")) ?? null;
}

/** Candidate row: ShopProduct fields minus id. Always archived, never an example. */
export type CsvCandidate = Omit<ShopProduct, "id">;

export interface CsvRowProblem {
  /** 1-based line number in the file where the row starts (header is line 1). */
  line: number;
  field: CsvImportField | null;
  message: string;
}

export interface CsvParsedRow {
  line: number;
  candidate: CsvCandidate;
  problems: CsvRowProblem[];
}

export interface CsvImportResult {
  rows: CsvParsedRow[];
  fileProblems: string[];
  /** Header cells that did not map to a shop-list field (ignored). */
  ignoredColumns: string[];
  /** Column index -> field, for the preview step. */
  columnMap: Record<number, CsvImportField>;
}

/** Standard EPA format: company-product, optional distributor. Format-only check. */
const EPA_FORMAT = /^\d{1,7}-\d{1,7}(-\d{1,7})?$/;

export function epaRegNoFormatOk(value: string): boolean {
  return EPA_FORMAT.test(value.trim());
}

/** RFC-4180 tokenizer. Returns records with the 1-based line each starts on. */
export function tokenizeCsv(text: string): { cells: string[]; line: number }[] {
  const out: { cells: string[]; line: number }[] = [];
  let i = 0;
  let line = 1;
  let field = "";
  let row: string[] = [];
  let rowLine = 1;
  let inQuotes = false;
  let fieldStarted = false;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    out.push({ cells: row, line: rowLine });
    row = [];
    field = "";
    fieldStarted = false;
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (c === "\n") line++;
      if (c === "\r" && text[i + 1] === "\n") {
        field += "\n";
        line++;
        i += 2;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++;
      rowLine = line;
      continue;
    }
    field += c;
    fieldStarted = true;
    i++;
  }
  if (fieldStarted || field !== "" || row.length > 0) endRow();
  return out;
}

const YES = new Set(["y", "yes", "true", "1", "x", "25b", "25(b)"]);
const NO = new Set(["n", "no", "false", "0", ""]);

export function parseCatalogCsv(input: string): CsvImportResult {
  const result: CsvImportResult = { rows: [], fileProblems: [], ignoredColumns: [], columnMap: {} };
  if (input.length > CSV_IMPORT_MAX_BYTES) {
    result.fileProblems.push(
      `Needs a look: file is too large (limit is about ${Math.round(CSV_IMPORT_MAX_BYTES / 1000)} KB).`,
    );
    return result;
  }
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records = tokenizeCsv(text).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (records.length === 0) {
    result.fileProblems.push("Needs a look: the file is empty.");
    return result;
  }
  const [header, ...body] = records;
  const seen = new Set<CsvImportField>();
  header.cells.forEach((raw, idx) => {
    const field = matchCsvHeader(raw);
    if (!field) {
      if (raw.trim()) result.ignoredColumns.push(raw.trim());
      return;
    }
    if (seen.has(field)) {
      result.fileProblems.push(`Needs a look: more than one column maps to ${field}; using the first.`);
      return;
    }
    seen.add(field);
    result.columnMap[idx] = field;
  });
  for (const req of REQUIRED_CSV_FIELDS) {
    if (!seen.has(req)) result.fileProblems.push("Needs a look: missing a product name column.");
  }
  if (result.ignoredColumns.length) {
    result.fileProblems.push(`Ignored columns: ${result.ignoredColumns.join(", ")}.`);
  }
  if (!seen.has("name")) return result;
  if (body.length === 0) result.fileProblems.push("Needs a look: no product rows under the header.");
  let rowsIn = body;
  if (body.length > CSV_IMPORT_MAX_ROWS) {
    result.fileProblems.push(
      `Needs a look: only the first ${CSV_IMPORT_MAX_ROWS} rows were read (file has ${body.length}).`,
    );
    rowsIn = body.slice(0, CSV_IMPORT_MAX_ROWS);
  }
  const colFor = (f: CsvImportField) =>
    Object.entries(result.columnMap).find(([, v]) => v === f)?.[0];
  for (const rec of rowsIn) {
    const get = (f: CsvImportField): string | undefined => {
      const idx = colFor(f);
      return idx === undefined ? undefined : (rec.cells[Number(idx)] ?? "").trim();
    };
    const problems: CsvRowProblem[] = [];
    const flag = (field: CsvImportField | null, message: string) =>
      problems.push({ line: rec.line, field, message });

    const name = get("name") ?? "";
    if (!name) flag("name", "Needs a look: product name is blank.");

    let kind: ProductKind = "pesticide";
    const kindRaw = (get("kind") ?? "").toLowerCase();
    if (kindRaw === "device" || kindRaw === "monitor" || kindRaw === "trap") kind = "device";
    else if (kindRaw && kindRaw !== "pesticide") flag("kind", `Needs a look: type "${get("kind")}" (use pesticide or device).`);

    let is25b = false;
    const b = (get("is25b") ?? "").toLowerCase();
    if (YES.has(b)) is25b = true;
    else if (!NO.has(b)) flag("is25b", `Needs a look: 25(b) value "${get("is25b")}" (use yes or no).`);

    const epaRaw = get("epaRegNo") ?? "";
    let epaRegNo: string | null = epaRaw === "" ? null : epaRaw;
    if (epaRegNo !== null) {
      if (!epaRegNoFormatOk(epaRegNo)) flag("epaRegNo", "Needs a look: EPA reg # format.");
      if (is25b || kind === "device") {
        flag("epaRegNo", "Needs a look: EPA reg # given on a 25(b) or device row.");
      }
    } else if (!is25b && kind === "pesticide") {
      flag("epaRegNo", "Needs a look: EPA reg # is blank.");
    }

    result.rows.push({
      line: rec.line,
      candidate: { name, epaRegNo, is25b, kind, isExample: false, archived: true },
      problems,
    });
  }
  return result;
}
