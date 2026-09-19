import type { ShopProduct } from "../types";
import { TEXAS_COMMON_STARTER, TEXAS_STARTER_CATALOG_VERSION } from "./texasCommon";
import type { StarterProduct } from "./types";

export type { StarterProduct } from "./types";
export type { LabelConfirmReadResult } from "./labelConfirmStore";
export { TEXAS_COMMON_STARTER, TEXAS_STARTER_CATALOG_VERSION };

export const STARTER_CATALOG_DISCLAIMER =
  "This Texas starter list is not official EPA or TDA data. It may be incomplete or outdated. Always confirm the product name and EPA registration number against the label before activating a row on your shop list.";

function normalizeEpa(epa: string | null | undefined): string {
  return String(epa ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Find a shop row that already matches this starter (EPA #, or name+kind for 25(b)/device). */
export function findShopMatchForStarter(
  catalog: ShopProduct[],
  starter: StarterProduct,
): ShopProduct | undefined {
  const starterEpa = normalizeEpa(starter.epaRegNo);
  if (starterEpa) {
    return catalog.find((p) => normalizeEpa(p.epaRegNo) === starterEpa);
  }
  const name = normalizeName(starter.name);
  return catalog.find(
    (p) => p.kind === starter.kind && normalizeName(p.name) === name && !normalizeEpa(p.epaRegNo),
  );
}

/** Case-insensitive search over name, EPA #, kind, and 25(b). Empty query returns all. */
export function searchTexasStarterCatalog(query: string): StarterProduct[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...TEXAS_COMMON_STARTER];
  return TEXAS_COMMON_STARTER.filter((p) => {
    const hay = `${p.name} ${p.epaRegNo ?? ""} ${p.kind} ${p.is25b ? "25b 25(b)" : ""}`.toLowerCase();
    return hay.includes(q);
  });
}

/** Copy a starter row into a new shop-owned product (inactive until label confirm activates it). */
export function starterToPendingShopProduct(starter: StarterProduct, id: string): ShopProduct {
  return {
    id,
    name: starter.name.trim(),
    epaRegNo: starter.kind === "device" || starter.is25b ? null : starter.epaRegNo,
    is25b: starter.kind === "device" ? false : starter.is25b,
    kind: starter.kind,
    isExample: false,
    archived: true,
  };
}

export function starterEpaCaption(starter: StarterProduct): string {
  if (starter.kind === "device") return "device";
  if (starter.is25b || !starter.epaRegNo) return "25(b) · no EPA #";
  return `EPA ${starter.epaRegNo}`;
}

export {
  STARTER_LABEL_CONFIRM_KEY,
  addPendingLabelConfirm,
  clearPendingLabelConfirm,
  listPendingLabelConfirmIds,
  requiresLabelConfirm,
} from "./labelConfirmStore";
