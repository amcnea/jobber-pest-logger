/**
 * Shared export / backup pull (#7).
 * Office CSV/PDF and JSON backup prefer a fresh remote shop snapshot when
 * resolveShopStore() is shared; local-only mode is unchanged.
 */

import type { ShopSections } from "../storage";
import {
  canAccessOffice,
  canUseOfficeSurfaces,
  getSessionMutationEpoch,
  loadShopSession,
} from "./session";
import { RemoteShopStore } from "./RemoteShopStore";
import { resolveShopStore, type ResolvedShopStoreInfo } from "./resolveShopStore";

export type ExportPullResult =
  | { kind: "local"; sections: ShopSections }
  | { kind: "shared"; sections: ShopSections; shopId: string }
  | {
      kind: "shared-fallback-local";
      sections: ShopSections;
      shopId: string;
      error: string;
    }
  | { kind: "canceled"; error: string };

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
 * If the session/shop changes while getShop awaits, cancel — do not download
 * either snapshot.
 */
export async function resolveExportSections(
  localSections: ShopSections,
): Promise<ExportPullResult> {
  const info = resolveShopStore();
  if (!shouldPullSharedExport(info) || !info.shopId) {
    return { kind: "local", sections: localSections };
  }

  const shopId = info.shopId.trim();
  const epoch = getSessionMutationEpoch();
  const before = loadShopSession();
  if (
    !canAccessOffice(before) ||
    !canUseOfficeSurfaces(before) ||
    before.shopId.trim() !== shopId
  ) {
    return {
      kind: "canceled",
      error:
        "Shop session is no longer an authenticated office session for this shop — export canceled.",
    };
  }

  const got = await info.store.getShop();

  const after = loadShopSession();
  if (
    epoch !== getSessionMutationEpoch() ||
    !canAccessOffice(after) ||
    !canUseOfficeSurfaces(after) ||
    after.shopId.trim() !== shopId
  ) {
    return {
      kind: "canceled",
      error:
        "Shop session changed during the shared pull — export canceled. Unlock and try again.",
    };
  }

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

  // Do not trust localStorage office role alone — require remote membership/owner.
  // (Firestore get is still open to any signed-in caller for PIN join; CF-scoped
  // export read is backlog. This blocks forged local office sessions that are not
  // office on the shop document.)
  if (!(info.store instanceof RemoteShopStore)) {
    return {
      kind: "canceled",
      error: "Shared export requires the remote shop store.",
    };
  }
  let uid: string;
  try {
    uid = await info.store.ensureUid();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not verify Firebase identity for export.";
    return { kind: "canceled", error: message };
  }
  const members = got.value.members ?? {};
  const isRemoteOffice =
    got.value.ownerUid === uid || members[uid] === "office";
  if (!isRemoteOffice) {
    return {
      kind: "canceled",
      error:
        "Shared export requires office membership on the shop document — not only a local office session.",
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
