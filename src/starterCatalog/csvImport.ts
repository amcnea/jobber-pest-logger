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

/** Plain column labels for user-facing text (never show the internal field ids). */
export const CSV_FIELD_LABELS: Record<CsvImportField, string> = {
  name: "Product name",
  epaRegNo: "EPA Reg. No.",
  is25b: "25(b)",
  kind: "Type",
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

/** A record dropped because its quoted field never closed before the end of the file. */
export interface CsvUnclosedQuote {
  /** 1-based line where the record started. */
  rowLine: number;
  /** 1-based line where the unterminated opening quote sits. */
  quoteLine: number;
}

export interface CsvTokenizeResult {
  records: { cells: string[]; line: number }[];
  /** Records skipped because of an unclosed quote, in file order. */
  unclosedQuotes: CsvUnclosedQuote[];
  /**
   * Start lines of records that had text right after a closing quote (other
   * than spaces/tabs) before the next comma or line end, e.g. `"Bait"x`. That
   * usually means a quote was forgotten or doubled somewhere above.
   */
  textAfterClosingQuote: number[];
}

/**
 * RFC-4180 tokenizer with recovery. An opening quote that never closes would
 * otherwise swallow the rest of the file into one cell. Instead, the record
 * holding it is dropped (and reported), and reading starts again on the line
 * after the opening quote, so later rows still come through.
 */
export function tokenizeCsvWithRecovery(text: string): CsvTokenizeResult {
  const records: { cells: string[]; line: number }[] = [];
  const unclosedQuotes: CsvUnclosedQuote[] = [];
  const stray = new Set<number>();
  let start = 0;
  let startLine = 1;
  while (start < text.length) {
    const r = tokenizeFrom(text, start, startLine, records, stray);
    if (!r) break;
    unclosedQuotes.push({ rowLine: r.rowLine, quoteLine: r.quoteLine });
    if (r.resumeAt < 0) break;
    start = r.resumeAt;
    startLine = r.quoteLine + 1;
  }
  const kept = new Set(records.map((r) => r.line));
  const textAfterClosingQuote = [...stray].filter((line) => kept.has(line)).sort((a, b) => a - b);
  return { records, unclosedQuotes, textAfterClosingQuote };
}

/** RFC-4180 tokenizer. Returns records with the 1-based line each starts on. */
export function tokenizeCsv(text: string): { cells: string[]; line: number }[] {
  return tokenizeCsvWithRecovery(text).records;
}

/**
 * Tokenizes text[start..] into `out`. Returns null at a clean end of input, or
 * details of an unclosed quote (the partial record is not added to `out`).
 * `resumeAt` is the index just past the first line break after the opening
 * quote, or -1 when there is none.
 */
function tokenizeFrom(
  text: string,
  start: number,
  startLine: number,
  out: { cells: string[]; line: number }[],
  stray: Set<number>,
): { rowLine: number; quoteLine: number; resumeAt: number } | null {
  let i = start;
  let line = startLine;
  let field = "";
  let row: string[] = [];
  let rowLine = startLine;
  let inQuotes = false;
  let fieldStarted = false;
  let quoteLine = startLine;
  let resumeAt = -1;
  let afterClose = false;
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
        afterClose = true;
        i++;
        continue;
      }
      if (resumeAt < 0 && (c === "\n" || c === "\r")) {
        resumeAt = i + (c === "\r" && text[i + 1] === "\n" ? 2 : 1);
      }
      if (c === "\r" && text[i + 1] === "\n") {
        field += "\n";
        line++;
        i += 2;
        continue;
      }
      // LF and a bare CR (old Mac line ending) each end a line, matching how
      // line breaks outside quotes are counted (#157).
      if (c === "\n" || c === "\r") line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      quoteLine = line;
      resumeAt = -1;
      i++;
      continue;
    }
    if (afterClose && c !== "," && c !== "\r" && c !== "\n" && c !== " " && c !== "\t") {
      stray.add(rowLine);
      afterClose = false;
    }
    if (c === ",") {
      afterClose = false;
      row.push(field);
      field = "";
      fieldStarted = false;
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      afterClose = false;
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
  if (inQuotes) return { rowLine, quoteLine, resumeAt: resumeAt < n ? resumeAt : -1 };
  if (fieldStarted || field !== "" || row.length > 0) endRow();
  return null;
}

/**
 * UTF-8 byte length without allocating an encoded copy. Matches
 * `new TextEncoder().encode(text).length` (a lone surrogate counts as the
 * 3-byte replacement character). Stops counting once `stopAbove` is passed.
 */
export function utf8ByteLength(text: string, stopAbove = Infinity): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > stopAbove) return bytes;
  }
  return bytes;
}

/** True when the text is over CSV_IMPORT_MAX_BYTES once encoded as UTF-8. */
export function csvOverByteLimit(text: string): boolean {
  // Each UTF-16 code unit is 1-3 UTF-8 bytes, so skip counting when the answer is clear.
  if (text.length > CSV_IMPORT_MAX_BYTES) return true;
  if (text.length * 3 <= CSV_IMPORT_MAX_BYTES) return false;
  return utf8ByteLength(text, CSV_IMPORT_MAX_BYTES) > CSV_IMPORT_MAX_BYTES;
}

function unclosedQuoteMessage(u: CsvUnclosedQuote, more: boolean): string {
  const where =
    u.rowLine === u.quoteLine
      ? `unclosed quote starting on line ${u.quoteLine}. That row was skipped`
      : `unclosed quote starting on line ${u.quoteLine} (row starting on line ${u.rowLine}). That row was skipped`;
  return `Needs a look: ${where}${more ? "; the lines after it were still read." : "."}`;
}

const YES = new Set(["y", "yes", "true", "1", "x", "25b", "25(b)"]);
const NO = new Set(["n", "no", "false", "0", ""]);

/** Shown when a file is over CSV_IMPORT_MAX_BYTES. */
export function csvTooLargeMessage(): string {
  return `Needs a look: file is too large (limit is about ${Math.round(CSV_IMPORT_MAX_BYTES / 1000)} KB).`;
}

export function parseCatalogCsv(input: string): CsvImportResult {
  const result: CsvImportResult = { rows: [], fileProblems: [], ignoredColumns: [], columnMap: {} };
  if (csvOverByteLimit(input)) {
    result.fileProblems.push(csvTooLargeMessage());
    return result;
  }
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const tokenized = tokenizeCsvWithRecovery(text);
  const records = tokenized.records.filter((r) => r.cells.some((c) => c.trim() !== ""));
  const unclosed = tokenized.unclosedQuotes;
  // An unclosed quote before (or in) the header row means we can't trust which
  // line is the header, so read nothing rather than guess.
  if (unclosed.length && (records.length === 0 || unclosed[0].rowLine < records[0].line)) {
    const u = unclosed[0];
    result.fileProblems.push(
      `Needs a look: unclosed quote starting on line ${u.quoteLine}, before the product rows. Nothing was read; close the quote and try again.`,
    );
    return result;
  }
  for (const u of unclosed) {
    const more = records.some((r) => r.line > u.quoteLine);
    result.fileProblems.push(unclosedQuoteMessage(u, more));
  }
  if (records.length === 0) {
    result.fileProblems.push("Needs a look: the file is empty.");
    return result;
  }
  const strayLines = new Set(tokenized.textAfterClosingQuote);
  const [header, ...body] = records;
  if (strayLines.has(header.line)) {
    result.fileProblems.push(
      `Needs a look: the header row on line ${header.line} has text after a closing quote; check for a missing or extra quote. Nothing was read.`,
    );
    return result;
  }
  const seen = new Set<CsvImportField>();
  header.cells.forEach((raw, idx) => {
    const field = matchCsvHeader(raw);
    if (!field) {
      if (raw.trim()) result.ignoredColumns.push(raw.trim());
      return;
    }
    if (seen.has(field)) {
      result.fileProblems.push(
        `Needs a look: more than one column maps to "${CSV_FIELD_LABELS[field]}"; using the first.`,
      );
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
    if (strayLines.has(rec.line)) {
      // Cells here can't be trusted (often a forgotten quote above pulled
      // several lines into one cell), so never offer this row as a product.
      result.fileProblems.push(
        `Needs a look: row starting on line ${rec.line} has text after a closing quote; check for a missing or extra quote. That row was skipped.`,
      );
      continue;
    }
    const get = (f: CsvImportField): string | undefined => {
      const idx = colFor(f);
      return idx === undefined ? undefined : (rec.cells[Number(idx)] ?? "").trim();
    };
    const problems: CsvRowProblem[] = [];
    const flag = (field: CsvImportField | null, message: string) =>
      problems.push({ line: rec.line, field, message });

    const mapped = Object.values(result.columnMap).map((f) => get(f) ?? "");
    if (mapped.some((v) => v.includes("\n") || v.includes("\r"))) {
      flag(null, `Needs a look: row starting on line ${rec.line} has a line break inside a cell; check for a missing or extra quote.`);
    }

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
