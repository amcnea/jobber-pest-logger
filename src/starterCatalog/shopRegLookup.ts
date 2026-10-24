/**
 * Shared shop reg # lookup (perf only). Built once per shop-catalog change and
 * shared by the starter list, the add-from-starter duplicate check, the
 * label-confirm fallback, and the CSV import's shop reg # match.
 *
 * Every reg # comparison that uses this was previously a linear scan of the
 * catalog with `normalizeImportEpa(p.epaRegNo) === key`. The lookup keeps, per
 * key, every matching shop row in catalog order, so each caller can apply its own
 * existing tie-break exactly as before (first match, or first non-archived).
 *
 * A lookup is only used for the exact catalog array it was built from; with any
 * other array, callers fall back to the old scan, so results never differ.
 */
import type { ShopProduct } from "../types";

/** Lowercase, drop all whitespace, and treat any dash-like character as "-". */
export function normalizeImportEpa(epa: string | null | undefined): string {
  return String(epa ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, "");
}

export interface ShopRegLookup {
  /** The catalog array this lookup was built from (identity checked by callers). */
  readonly catalog: readonly ShopProduct[];
  /** normalizeImportEpa(full reg #) -> matching shop rows, in catalog order. Blank keys are left out. */
  readonly byRegNo: ReadonlyMap<string, readonly ShopProduct[]>;
}

export function buildShopRegLookup(catalog: readonly ShopProduct[]): ShopRegLookup {
  const byRegNo = new Map<string, ShopProduct[]>();
  for (const p of catalog) {
    const key = normalizeImportEpa(p.epaRegNo);
    if (!key) continue;
    const list = byRegNo.get(key);
    if (list) list.push(p);
    else byRegNo.set(key, [p]);
  }
  return { catalog, byRegNo };
}

/**
 * Working copy of a shop reg # lookup for one multi-add run (perf only).
 *
 * Returns a fresh ShopRegLookup whose `catalog` and `byRegNo` buckets are shallow-cloned
 * from `lookup` when `lookup` was built from this exact `catalog` array, or undefined
 * otherwise (callers then keep the old combined-array scan). Appending rows with
 * `appendShopRegLookup` keeps existing rows first, then new rows in add order, with
 * blank reg #s skipped in `byRegNo`, without mutating the shared `lookup`.
 */
export function cloneShopRegLookup(
  catalog: readonly ShopProduct[],
  lookup?: ShopRegLookup,
): ShopRegLookup | undefined {
  if (!lookup || lookup.catalog !== catalog) return undefined;
  const byRegNo = new Map<string, ShopProduct[]>();
  for (const [key, rows] of lookup.byRegNo) {
    byRegNo.set(key, [...rows]);
  }
  return { catalog: [...catalog], byRegNo };
}

/**
 * Append a newly added shop row to a per-run lookup copy from `cloneShopRegLookup`.
 * Keeps `lookup.catalog` (existing rows first, then new rows in add order) and
 * `lookup.byRegNo` (blank reg #s skipped) in sync so `shopRowsWithRegNo` returns
 * the exact same rows and order as scanning the combined list.
 */
export function appendShopRegLookup(lookup: ShopRegLookup, product: ShopProduct): void {
  (lookup.catalog as ShopProduct[]).push(product);
  const key = normalizeImportEpa(product.epaRegNo);
  if (!key) return;
  const byRegNo = lookup.byRegNo as Map<string, ShopProduct[]>;
  const list = byRegNo.get(key);
  if (list) list.push(product);
  else byRegNo.set(key, [product]);
}

/**
 * Shop rows whose normalized reg # equals `key` (already normalized, non-blank), in
 * catalog order. Uses the lookup when it was built from this exact catalog array,
 * otherwise the old linear scan; both give the same list.
 */
export function shopRowsWithRegNo(
  catalog: readonly ShopProduct[],
  key: string,
  lookup?: ShopRegLookup,
): readonly ShopProduct[] {
  if (!key) return [];
  if (lookup && lookup.catalog === catalog) return lookup.byRegNo.get(key) ?? [];
  return catalog.filter((p) => normalizeImportEpa(p.epaRegNo) === key);
}
