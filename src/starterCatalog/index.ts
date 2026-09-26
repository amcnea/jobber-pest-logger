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

/**
 * Find a shop row that already matches this starter (EPA #, or name+kind for 25(b)/device
 * rows with no EPA #). When several shop rows match, prefer the first non-archived (active)
 * row; if none is active, return the first archived match; otherwise undefined.
 */
export function findShopMatchForStarter(
  catalog: ShopProduct[],
  starter: StarterProduct,
): ShopProduct | undefined {
  const starterEpa = normalizeEpa(starter.epaRegNo);
  const name = normalizeName(starter.name);
  const matches = catalog.filter((p) =>
    starterEpa
      ? normalizeEpa(p.epaRegNo) === starterEpa
      : p.kind === starter.kind && normalizeName(p.name) === name && !normalizeEpa(p.epaRegNo),
  );
  return matches.find((p) => !p.archived) ?? matches[0];
}

export type StarterKindFilter = "all" | "pesticide" | "device";

export type StarterShopStatusFilter = "all" | "hide-active" | "not-added" | "pending";

/**
 * Filter starter rows by their shop-list status (via findShopMatchForStarter):
 * - all: no filtering
 * - hide-active: hide starters with an active (non-archived) shop match; pending/archived stay
 * - not-added: only starters with no shop match at all
 * - pending: only starters whose shop match is archived (pending label confirm)
 */
export function filterStartersByShopStatus(
  rows: StarterProduct[],
  catalog: ShopProduct[],
  status: StarterShopStatusFilter,
): StarterProduct[] {
  if (status === "all") return rows;
  return rows.filter((starter) => {
    const match = findShopMatchForStarter(catalog, starter);
    switch (status) {
      case "hide-active":
        return !(match && !match.archived);
      case "not-added":
        return !match;
      case "pending":
        return !!match && match.archived;
      default:
        return true;
    }
  });
}

/** Case-insensitive search over name, EPA #, kind, and 25(b). Empty query returns all (for the given kind filter). */
export function searchTexasStarterCatalog(
  query: string,
  kindFilter: StarterKindFilter = "all",
): StarterProduct[] {
  const q = query.trim().toLowerCase();
  return TEXAS_COMMON_STARTER.filter((p) => {
    if (kindFilter !== "all" && p.kind !== kindFilter) return false;
    if (!q) return true;
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
