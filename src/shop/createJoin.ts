/**
 * Create / join / leave shared shop (#2).
 * Puts LocalShopStore snapshot to Firestore on create and one-time migrate.
 * Day-to-day screens still use storage.ts — live shared R/W is #3/#6.
 */

import { isExampleShopProduct } from "../catalog";
import { getFirebaseConfig, isFirebaseConfigured } from "./firebaseConfig";
import { getLocalShopStore } from "./LocalShopStore";
import { hasMigratedShop, markShopMigrated } from "./migrateMarker";
import { RemoteShopStore } from "./RemoteShopStore";
import {
  clearShopSession,
  hasJoinedShop,
  isValidShopId,
  loadShopSession,
  saveShopSession,
} from "./session";
import { generateShopCode, normalizeShopCode } from "./shopCode";
import type { ShopDocument } from "./types";

export type CreateJoinResult =
  | { ok: true; shopId: string; message: string; migrated?: boolean; hint?: string }
  | { ok: false; error: string };

/** True when the shop doc has office-meaningful data (not just example seeds). */
export function shopDocumentHasMeaningfulData(doc: ShopDocument): boolean {
  if (doc.logs.length > 0) return true;
  if (doc.people.length > 0) return true;
  if (doc.settings.shopName.trim() || doc.settings.shopTpclNumber.trim()) return true;
  if (doc.catalog.some((p) => !isExampleShopProduct(p))) return true;
  return false;
}

function remoteMissingError(error: string): boolean {
  return /was not found/i.test(error);
}

/**
 * Create a new shared shop: generate code, upload this device's local snapshot,
 * save session, mark migrated once.
 */
export async function createShop(): Promise<CreateJoinResult> {
  if (!isFirebaseConfigured()) {
    return {
      ok: false,
      error:
        "Firebase env is not configured. Copy .env.example (VITE_FIREBASE_*) and rebuild to create a shared shop.",
    };
  }
  const config = getFirebaseConfig();
  if (!config) {
    return { ok: false, error: "Firebase env is not configured." };
  }

  if (hasJoinedShop()) {
    return {
      ok: false,
      error: "This device already joined a shop. Leave the current shop before creating a new one.",
    };
  }

  const localResult = await getLocalShopStore().getShop();
  if (!localResult.ok) {
    return { ok: false, error: localResult.error };
  }

  let shopId = "";
  let lastProbeError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = generateShopCode();
    const probe = new RemoteShopStore(config, candidate);
    const existing = await probe.getShop();
    if (!existing.ok && remoteMissingError(existing.error)) {
      shopId = candidate;
      break;
    }
    if (existing.ok) {
      lastProbeError = "Shop code collision; retrying…";
      continue;
    }
    return { ok: false, error: existing.error };
  }
  if (!shopId) {
    return {
      ok: false,
      error: lastProbeError || "Could not allocate a free shop code. Try again.",
    };
  }

  const remote = new RemoteShopStore(config, shopId);
  const put = await remote.putShop(localResult.value);
  if (!put.ok) {
    return { ok: false, error: put.error };
  }

  if (!saveShopSession({ shopId })) {
    return {
      ok: false,
      error: `Shop ${shopId} was created in the cloud, but this device could not save the join session (storage blocked).`,
    };
  }
  markShopMigrated(shopId);

  return {
    ok: true,
    shopId,
    migrated: true,
    message: `Shop created. Share this code with other office devices: ${shopId}`,
  };
}

/**
 * Join an existing shop by code. Validates; loads remote.
 * Missing remote → error (does not invent).
 * Migrate once: if local has data and remote is empty/new, upload local then mark migrated.
 * If remote already has data, do not overwrite; optional backup hint.
 */
export async function joinShop(rawCode: string): Promise<CreateJoinResult> {
  if (!isFirebaseConfigured()) {
    return {
      ok: false,
      error:
        "Firebase env is not configured. Copy .env.example (VITE_FIREBASE_*) and rebuild to join a shared shop.",
    };
  }
  const config = getFirebaseConfig();
  if (!config) {
    return { ok: false, error: "Firebase env is not configured." };
  }

  if (hasJoinedShop()) {
    return {
      ok: false,
      error: "This device already joined a shop. Leave the current shop before joining another.",
    };
  }

  const shopId = normalizeShopCode(rawCode);
  if (!isValidShopId(shopId)) {
    return {
      ok: false,
      error:
        'That shop code is not valid (non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 bytes).',
    };
  }

  const remote = new RemoteShopStore(config, shopId);
  const remoteResult = await remote.getShop();
  if (!remoteResult.ok) {
    if (remoteMissingError(remoteResult.error)) {
      return {
        ok: false,
        error: `No shop found for code ${shopId}. Check the code with the office — this app will not invent a shop.`,
      };
    }
    return { ok: false, error: remoteResult.error };
  }

  const remoteDoc = remoteResult.value;
  const localResult = await getLocalShopStore().getShop();
  if (!localResult.ok) {
    return { ok: false, error: localResult.error };
  }
  const localDoc = localResult.value;

  const remoteEmpty = !shopDocumentHasMeaningfulData(remoteDoc);
  const localHasData = shopDocumentHasMeaningfulData(localDoc);
  let migrated = false;
  let hint: string | undefined;

  if (!hasMigratedShop(shopId) && localHasData && remoteEmpty) {
    // CAS against remote stamp so we do not clobber a concurrent first write.
    const put = await remote.putShop({
      ...localDoc,
      updatedAt: remoteDoc.updatedAt,
    });
    if (!put.ok) {
      return { ok: false, error: put.error };
    }
    migrated = true;
    markShopMigrated(shopId);
  } else if (!remoteEmpty && localHasData) {
    hint =
      "This shop already has cloud data. Local data on this device was not uploaded. Download a backup from Settings if you still need the local copy. Live shared read/write wires in a later slice.";
    markShopMigrated(shopId);
  } else {
    // Empty↔empty or remote-has-data / local-empty: join only; never re-upload later.
    markShopMigrated(shopId);
  }

  if (!saveShopSession({ shopId })) {
    return {
      ok: false,
      error: "Shop exists, but this device could not save the join session (storage blocked).",
    };
  }

  return {
    ok: true,
    shopId,
    migrated,
    hint,
    message: migrated
      ? `Joined ${shopId}. Local data was uploaded once (shop was empty).`
      : `Joined ${shopId}.`,
  };
}

/** Leave shared shop session → local-only. Does not wipe remote or local data. */
export function leaveShop(): CreateJoinResult {
  const session = loadShopSession();
  if (!hasJoinedShop(session)) {
    return { ok: false, error: "This device is not joined to a shared shop." };
  }
  const shopId = session.shopId.trim();
  if (!clearShopSession()) {
    return { ok: false, error: "Could not clear shop session on this device." };
  }
  return {
    ok: true,
    shopId,
    message: `Left shop ${shopId}. This device is local-only again. Cloud data was not deleted.`,
  };
}
