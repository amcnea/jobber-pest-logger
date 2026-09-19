/**
 * Shared export / backup pull (#7).
 * Office CSV/PDF and JSON backup prefer a fresh remote shop snapshot when
 * resolveShopStore() is shared; local-only mode is unchanged.
 */

import type { ShopSections } from "../storage";
import { canAccessOffice, canUseOfficeSurfaces } from "./session";
import { resolveShopStore, type ResolvedShopStoreInfo } from "./resolveShopStore";

export type ExportPullResult =
  | { kind: "local"; sections: ShopSections }
  | { kind: "shared"; sections: ShopSections; shopId: string }
  | {
      kind: "shared-fallback-local";
      sections: ShopSections;
      shopId: string;
      error: string;
    };

/**
 * True when Export / Settings backup should pull remote before download:
 * shared store + office-authenticated session that can use office surfaces
 * (canAccessOffice / canUseOfficeSurfaces).
 */
export function shouldPullSharedExport(
  info: ResolvedShopStoreInfo = resolveShopStore(),
): boolean {
  if (info.mode !== "shared" || info.store.mode !== "shared" || !info.shopId) {
    return false;
  }
  if (!canAccessOffice() || !canUseOfficeSurfaces()) return false;
  return true;
}

/**
 * Resolve logs/catalog/people/settings for office export or JSON backup.
 * Local-only (or non-office): returns the provided device sections unchanged.
 * Shared office: remote.getShop(); on failure falls back to local with error
 * (caller must show a clear banner — do not present local as the shop).
 */
export async function resolveExportSections(
  localSections: ShopSections,
): Promise<ExportPullResult> {
  const info = resolveShopStore();
  if (!shouldPullSharedExport(info) || !info.shopId) {
    return { kind: "local", sections: localSections };
  }

  const shopId = info.shopId;
  const got = await info.store.getShop();
  if (!got.ok) {
    return {
      kind: "shared-fallback-local",
      sections: localSections,
      shopId,
      error:
        got.error ||
        "Could not load the shared shop. Exporting this device's local copy instead — it may be incomplete.",
    };
  }

  return {
    kind: "shared",
    shopId,
    sections: {
      logs: got.value.logs,
      catalog: got.value.catalog,
      people: got.value.people,
      settings: got.value.settings,
    },
  };
}

/** Short chrome note when shared pull applies (Export / Settings). */
export function sharedExportPullHint(
  info: ResolvedShopStoreInfo = resolveShopStore(),
): string | null {
  if (!shouldPullSharedExport(info)) return null;
  return (
    "Shared shop: CSV/PDF and backup JSON pull a fresh cloud snapshot before download " +
    "(convenience only). Cloud sync is not the Texas § 7.144 two-year premises retention " +
    "path — keep Settings → Download backup JSON for on-device retention."
  );
}
