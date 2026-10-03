import type { ShopProduct } from "../types";
import { TEXAS_COMMON_STARTER, TEXAS_STARTER_CATALOG_VERSION } from "./texasCommon";
import type { StarterProduct } from "./types";

export type { StarterProduct } from "./types";
export type { LabelConfirmReadResult } from "./labelConfirmStore";
export { TEXAS_COMMON_STARTER, TEXAS_STARTER_CATALOG_VERSION };
export { highlightSegments, type HighlightSegment } from "./highlight";

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

export type StarterShopStatusFilter =
  | "all"
  | "hide-active"
  | "active"
  | "not-added"
  | "pending"
  | "archived";

/** Shop-list state of a starter row relative to the shop catalog. */
export type StarterShopState = "not-added" | "active" | "pending" | "archived";

function toIdSet(pendingIds: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return pendingIds instanceof Set ? pendingIds : new Set(pendingIds as readonly string[]);
}

/**
 * Classify a starter by its shop match (via findShopMatchForStarter):
 * - not-added: no shop match
 * - active: match is not archived
 * - pending: match is archived AND its id is awaiting label confirm (pendingIds)
 * - archived: match is archived but not awaiting label confirm (normally archived product)
 */
export function starterShopState(
  catalog: ShopProduct[],
  starter: StarterProduct,
  pendingIds: ReadonlySet<string> | readonly string[],
): StarterShopState {
  const match = findShopMatchForStarter(catalog, starter);
  if (!match) return "not-added";
  if (!match.archived) return "active";
  return toIdSet(pendingIds).has(match.id) ? "pending" : "archived";
}

/**
 * Filter starter rows by their shop-list state (via starterShopState):
 * - all: no filtering
 * - hide-active: hide only starters with an active (non-archived) shop match; pending/archived stay
 * - active: only starters with an active (non-archived) shop match
 * - not-added: only starters with no shop match at all
 * - pending: only starters whose archived shop match is awaiting label confirm (id in pendingIds)
 * - archived: only starters whose shop match is archived and NOT awaiting label confirm
 */
export function filterStartersByShopStatus(
  rows: StarterProduct[],
  catalog: ShopProduct[],
  status: StarterShopStatusFilter,
  pendingIds: ReadonlySet<string> | readonly string[],
): StarterProduct[] {
  if (status === "all") return rows;
  const ids = toIdSet(pendingIds);
  return rows.filter((starter) => {
    const state = starterShopState(catalog, starter, ids);
    switch (status) {
      case "hide-active":
        return state !== "active";
      case "active":
        return state === "active";
      case "not-added":
        return state === "not-added";
      case "pending":
        return state === "pending";
      case "archived":
        return state === "archived";
      default:
        return true;
    }
  });
}

/** Display order for starter results (applied after filtering). */
export type StarterSortOrder = "list" | "name" | "needs-action";

const NEEDS_ACTION_RANK: Record<StarterShopState, number> = {
  pending: 0,
  archived: 1,
  "not-added": 2,
  active: 3,
};

/**
 * Return a NEW array of starter rows in the requested order (input is never mutated):
 * - list: original starter list order (input order)
 * - name: name A–Z (localeCompare, sensitivity "base"), ties by id
 * - needs-action: grouped by starterShopState — pending, archived, not-added, active;
 *   stable within each group (keeps list order)
 */
export function sortStarters(
  rows: readonly StarterProduct[],
  catalog: ShopProduct[],
  pendingIds: ReadonlySet<string> | readonly string[],
  order: StarterSortOrder,
): StarterProduct[] {
  if (order === "name") {
    return [...rows].sort((a, b) => {
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      if (byName !== 0) return byName;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  if (order === "needs-action") {
    const ids = toIdSet(pendingIds);
    return rows
      .map((starter, index) => ({
        starter,
        index,
        rank: NEEDS_ACTION_RANK[starterShopState(catalog, starter, ids)],
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.starter);
  }
  return [...rows];
}

/** Lowercase an EPA reg. no. and drop spaces/dashes so "100-1070", "100 1070", and "1001070" compare equal. */
function compactEpa(epa: string | null | undefined): string {
  return String(epa ?? "")
    .toLowerCase()
    .replace(/[\s-]+/g, "");
}

/**
 * True when a starter matches a free-text query (case-insensitive substring over name, EPA #,
 * kind, and 25(b)). EPA reg. no. also matches ignoring spaces/dashes. Empty query matches all.
 */
export function starterMatchesQuery(starter: StarterProduct, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${starter.name} ${starter.epaRegNo ?? ""} ${starter.kind} ${
    starter.is25b ? "25b 25(b)" : ""
  }`.toLowerCase();
  if (hay.includes(q)) return true;
  const qEpa = compactEpa(q);
  return qEpa !== "" && compactEpa(starter.epaRegNo).includes(qEpa);
}

/** Search via starterMatchesQuery. Empty query returns all (for the given kind filter). */
export function searchTexasStarterCatalog(
  query: string,
  kindFilter: StarterKindFilter = "all",
): StarterProduct[] {
  return TEXAS_COMMON_STARTER.filter(
    (p) => (kindFilter === "all" || p.kind === kindFilter) && starterMatchesQuery(p, query),
  );
}

/** When only25b is true, keep only 25(b) pesticide starters; otherwise return rows unchanged. */
export function filterStarters25bOnly(rows: StarterProduct[], only25b: boolean): StarterProduct[] {
  return only25b ? rows.filter((p) => p.kind === "pesticide" && p.is25b) : rows;
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

/** Polite results line for the starter list, e.g. "Showing 4 of 32 starters". */
export function formatStarterResultCount(shown: number, total: number): string {
  return `Showing ${shown} of ${total} starter${total === 1 ? "" : "s"}`;
}

export {
  STARTER_LABEL_CONFIRM_KEY,
  addPendingLabelConfirm,
  clearPendingLabelConfirm,
  listPendingLabelConfirmIds,
  requiresLabelConfirm,
} from "./labelConfirmStore";
