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
  },
  {
    id: "example-25b-concentrate",
    name: "Example 25(b) concentrate",
    epaRegNo: null,
    is25b: true,
    kind: "pesticide",
    isExample: true,
  },
  {
    id: "example-insect-monitor",
    name: "Example insect monitor",
    epaRegNo: null,
    is25b: false,
    kind: "device",
    isExample: true,
  },
];

export const AMOUNT_UNITS = ["fl oz", "gal", "oz", "lb", "each"] as const;

/** Exact export label for example seeds. Do not print a fake EPA #. */
export const EXAMPLE_EPA_LABEL = "example / not a real EPA number";

export function looksLikeSampleEpa(epaRegNo: string | null | undefined): boolean {
  return typeof epaRegNo === "string" && /^SAMPLE-/i.test(epaRegNo.trim());
}

export function inferIsExample(product: {
  isExample?: boolean;
  catalogId?: string;
  epaRegNo?: string | null;
}): boolean {
  if (typeof product.isExample === "boolean") return product.isExample;
  if (typeof product.catalogId === "string" && product.catalogId.startsWith("sample-")) return true;
  if (looksLikeSampleEpa(product.epaRegNo)) return true;
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
  return products.some((p) => p.isExample || looksLikeSampleEpa(p.epaRegNo));
}