import type { AppliedProduct, ShopProduct } from "./types";

/**
 * Shop-owned product list. Seeded once with obvious examples — not EPA data,
 * not scraped from EPA, and never given fake-looking registration numbers.
 */
export const EXAMPLE_SEEDS: ShopProduct[] = [
  {
    id: "example-rtu-insecticide",
    name: "Example RTU insecticide",
    epaRegNo: null,
    is25b: false,
    kind: "pesticide",
    isExample: true,
    archived: false,
  },
  {
    id: "example-25b-concentrate",
    name: "Example 25(b) concentrate",
    epaRegNo: null,
    is25b: true,
    kind: "pesticide",
    isExample: true,
    archived: false,
  },
  {
    id: "example-insect-monitor",
    name: "Example insect monitor",
    epaRegNo: null,
    is25b: false,
    kind: "device",
    isExample: true,
    archived: false,
  },
];

export const AMOUNT_UNITS = ["fl oz", "gal", "oz", "lb", "each"] as const;

/** Exact export label for example seeds. Do not print a fake EPA #. */
export const EXAMPLE_EPA_LABEL = "example / not a real EPA number";

export function looksLikeSampleEpa(epaRegNo: string | null | undefined): boolean {
  return typeof epaRegNo === "string" && /^SAMPLE-/i.test(epaRegNo.trim());
}

const EXAMPLE_SEED_IDS = new Set(EXAMPLE_SEEDS.map((p) => p.id));

export function inferIsExample(product: {
  isExample?: boolean;
  catalogId?: string;
  epaRegNo?: string | null;
}): boolean {
  // SAMPLE / example seed markers win over an explicit false — audit exports must never
  // print SAMPLE-* or built-in example-* seeds as real EPA #s, even if isExample was omitted.
  if (looksLikeSampleEpa(product.epaRegNo)) return true;
  if (typeof product.catalogId === "string") {
    if (
      product.catalogId.startsWith("sample-") ||
      product.catalogId.startsWith("example-") ||
      EXAMPLE_SEED_IDS.has(product.catalogId)
    ) {
      return true;
    }
  }
  if (typeof product.isExample === "boolean") return product.isExample;
  return false;
}

/** EPA cell for CSV/PDF. Example seeds never emit a registration number. */
export function epaExportText(
  product: Pick<AppliedProduct, "isExample" | "epaRegNo" | "is25b" | "catalogId" | "method">,
): string {
  if (inferIsExample(product)) return EXAMPLE_EPA_LABEL;
  if (product.method === "device" || product.is25b || !product.epaRegNo) return "";
  return product.epaRegNo;
}

export function productEpaCaption(product: {
  isExample: boolean;
  is25b: boolean;
  epaRegNo: string | null;
  method?: AppliedProduct["method"];
  kind?: ShopProduct["kind"];
}): string {
  if (product.isExample || looksLikeSampleEpa(product.epaRegNo)) return EXAMPLE_EPA_LABEL;
  if (product.method === "device" || product.kind === "device") return "device";
  if (product.is25b || !product.epaRegNo) return "25(b) · no EPA #";
  return `EPA ${product.epaRegNo}`;
}

export function catalogPickerLabel(product: ShopProduct): string {
  if (product.kind === "device") {
    return product.isExample ? `${product.name} (device · example)` : `${product.name} (device)`;
  }
  if (product.isExample) return `${product.name} (${EXAMPLE_EPA_LABEL})`;
  if (product.is25b || !product.epaRegNo) return `${product.name} (25(b) — no EPA #)`;
  return `${product.name} (${product.epaRegNo})`;
}

export function logHasExampleProducts(products: AppliedProduct[]): boolean {
  return products.some((p) =>
    inferIsExample({ isExample: p.isExample, catalogId: p.catalogId, epaRegNo: p.epaRegNo }),
  );
}

/** True when a shop-list row is an example / SAMPLE seed. */
export function isExampleShopProduct(product: ShopProduct): boolean {
  return inferIsExample({
    isExample: product.isExample,
    catalogId: product.id,
    epaRegNo: product.epaRegNo,
  });
}

/** True when the shop list still includes any example / SAMPLE seed. */
export function catalogHasExampleProducts(catalog: ShopProduct[]): boolean {
  return catalog.some(isExampleShopProduct);
}

/** Count example / SAMPLE products still on the shop list. */
export function countExampleCatalogProducts(catalog: ShopProduct[]): number {
  return catalog.filter(isExampleShopProduct).length;
}

/** True when any saved log still references an example / SAMPLE product line. */
export function logsHaveExampleProducts(
  logs: { products: AppliedProduct[]; sampleData?: boolean }[],
): boolean {
  return logs.some((log) => log.sampleData === true || logHasExampleProducts(log.products));
}

/** Count saved logs that still reference example / SAMPLE products. */
export function countLogsWithExampleProducts(
  logs: { products: AppliedProduct[]; sampleData?: boolean }[],
): number {
  return logs.filter((log) => log.sampleData === true || logHasExampleProducts(log.products)).length;
}

/**
 * Soft gate for real CSV/PDF export: blocked while example seeds remain on the
 * catalog or any saved log still references an example product.
 */
export function exportBlockedByExamples(
  catalog: ShopProduct[],
  logs: { products: AppliedProduct[]; sampleData?: boolean }[],
): { blocked: boolean; catalogExamples: number; logExamples: number } {
  const catalogExamples = countExampleCatalogProducts(catalog);
  const logExamples = countLogsWithExampleProducts(logs);
  return {
    blocked: catalogExamples > 0 || logExamples > 0,
    catalogExamples,
    logExamples,
  };
}


/** Products available on New log picker (not archived). */
export function activeCatalogProducts(catalog: ShopProduct[]): ShopProduct[] {
  return catalog.filter((p) => !p.archived);
}
