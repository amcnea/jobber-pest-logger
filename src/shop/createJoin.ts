/**
 * Create / join / leave / sign-in shared shop (#2 + #3 PIN/role + #5 Auth/membership).
 * Puts LocalShopStore snapshot to Firestore on create and one-time migrate.
 * Day-to-day screens still use storage.ts — live shared R/W is a later slice.
 *
 * #5 flow:
 *   Create → Anonymous Auth → put shop with ownerUid + members[uid]=office + auth hashes
 *   Join   → Anonymous Auth → read shop → verify PIN client-side → addMembership → session
 *   Unlock → same as join membership ensure + session
 */

import { isExampleShopProduct } from "../catalog";
import { ensureAnonymousAuth } from "./firebaseAuth";
import { getFirebaseConfig, isFirebaseConfigured } from "./firebaseConfig";
import { getLocalShopStore } from "./LocalShopStore";
import { hasMigratedShop, markShopMigrated } from "./migrateMarker";
import {
  buildShopPinAuth,
  isShopRole,
  isValidPin,
  pinRecordForRole,
  verifyPin,
  type ShopRole,
} from "./pinCrypto";
import { RemoteShopStore } from "./RemoteShopStore";
import {
  clearSessionAuth,
  clearShopSession,
  hasJoinedShop,
  isSessionAuthenticated,
  isValidShopId,
  loadShopSession,
  saveShopSession,
} from "./session";
import { generateShopCode, normalizeShopCode } from "./shopCode";
import type { ShopDocument, ShopPinAuth } from "./types";

export type CreateJoinResult =
  | {
      ok: true;
      shopId: string;
      message: string;
      migrated?: boolean;
      hint?: string;
      role?: ShopRole;
    }
  | { ok: false; error: string; reason?: "pins-missing" };

export interface CreateShopPins {
  officePin: string;
  officePinConfirm: string;
  techPin: string;
  techPinConfirm: string;
}

export interface RolePinInput {
  role: ShopRole;
  pin: string;
}

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

function requireFirebase():
  | { ok: true; config: NonNullable<ReturnType<typeof getFirebaseConfig>> }
  | { ok: false; error: string } {
  if (!isFirebaseConfigured()) {
    return {
      ok: false,
      error:
        "Firebase env is not configured. Copy .env.example (VITE_FIREBASE_*) and rebuild to use a shared shop.",
    };
  }
  const config = getFirebaseConfig();
  if (!config) {
    return { ok: false, error: "Firebase env is not configured." };
  }
  return { ok: true, config };
}

function validatePinPair(
  pin: string,
  confirm: string,
  label: string,
): string | null {
  if (!isValidPin(pin)) {
    return `${label} must be 4–8 digits.`;
  }
  if (pin !== confirm) {
    return `${label} confirmation does not match.`;
  }
  return null;
}

function validateCreatePins(pins: CreateShopPins): string | null {
  const officeErr = validatePinPair(pins.officePin, pins.officePinConfirm, "Office PIN");
  if (officeErr) return officeErr;
  const techErr = validatePinPair(pins.techPin, pins.techPinConfirm, "Tech PIN");
  if (techErr) return techErr;
  if (pins.officePin === pins.techPin) {
    return "Office and tech PINs must be different.";
  }
  return null;
}

async function persistAuthenticatedSession(
  shopId: string,
  role: ShopRole,
): Promise<string | null> {
  const verifiedAt = new Date().toISOString();
  if (!saveShopSession({ shopId, role, verifiedAt })) {
    return "this device could not save the session (storage blocked).";
  }
  return null;
}

async function verifyAgainstAuth(
  auth: ShopPinAuth | undefined,
  role: ShopRole,
  pin: string,
): Promise<{ error: string; reason?: "pins-missing" } | null> {
  if (!auth) {
    return {
      error:
        "This shop has no PINs yet. An office device must set office and tech PINs before unlock/join.",
      reason: "pins-missing",
    };
  }
  if (!isValidPin(pin)) {
    return { error: "PIN must be 4–8 digits." };
  }
  const record = pinRecordForRole(auth, role);
  const ok = await verifyPin(pin, record);
  if (!ok) {
    return { error: "Incorrect PIN for that role. Try again or ask the office." };
  }
  return null;
}

/** True when the shop has #5 membership fields. */
function hasMembership(doc: ShopDocument): boolean {
  return Boolean(doc.ownerUid) || Boolean(doc.members && Object.keys(doc.members).length > 0);
}

/**
 * After PIN verify: ensure this uid is in members (join-self / legacy claim).
 * No-op write when already a member with the same role.
 */
async function ensureMembershipAfterPin(
  remote: RemoteShopStore,
  doc: ShopDocument,
  uid: string,
  role: ShopRole,
): Promise<{ ok: true; doc: ShopDocument } | { ok: false; error: string }> {
  const existingRole = doc.members?.[uid];
  const needsOwnerClaim = role === "office" && !doc.ownerUid;
  // Already a member with this role and no legacy owner claim needed.
  if (existingRole === role && !needsOwnerClaim) {
    return { ok: true, doc };
  }

  const result = await remote.addMembership({
    expectedUpdatedAt: doc.updatedAt,
    uid,
    role,
    claimOwnerIfMissing: needsOwnerClaim,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return {
    ok: true,
    doc: {
      ...doc,
      updatedAt: result.value.updatedAt,
      members: result.value.members,
      ownerUid: result.value.ownerUid ?? doc.ownerUid,
    },
  };
}

/**
 * Create a new shared shop: Anonymous Auth, generate code, set owner + PIN hashes,
 * upload local snapshot, save authenticated office session, mark migrated once.
 */
export async function createShop(pins: CreateShopPins): Promise<CreateJoinResult> {
  const fb = requireFirebase();
  if (!fb.ok) return fb;

  const pinErr = validateCreatePins(pins);
  if (pinErr) return { ok: false, error: pinErr };

  if (hasJoinedShop()) {
    return {
      ok: false,
      error: "This device already joined a shop. Leave the current shop before creating a new one.",
    };
  }

  let uid: string;
  try {
    ({ uid } = await ensureAnonymousAuth(fb.config));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not sign in anonymously to Firebase.";
    return {
      ok: false,
      error: `${message} Enable Anonymous Auth in the Firebase console for this project.`,
    };
  }

  const localResult = await getLocalShopStore().getShop();
  if (!localResult.ok) {
    return { ok: false, error: localResult.error };
  }

  let auth: ShopPinAuth;
  try {
    auth = await buildShopPinAuth(pins.officePin, pins.techPin);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not hash PINs.";
    return { ok: false, error: message };
  }

  let shopId = "";
  let lastProbeError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = generateShopCode();
    const probe = new RemoteShopStore(fb.config, candidate);
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

  const remote = new RemoteShopStore(fb.config, shopId);
  const put = await remote.putShop({
    ...localResult.value,
    auth,
    ownerUid: uid,
    members: { [uid]: "office" },
  });
  if (!put.ok) {
    return { ok: false, error: put.error };
  }

  const sessionErr = await persistAuthenticatedSession(shopId, "office");
  if (sessionErr) {
    return { ok: false, error: `Shop ${shopId} was created in the cloud, but ${sessionErr}` };
  }
  markShopMigrated(shopId);

  return {
    ok: true,
    shopId,
    role: "office",
    migrated: true,
    message: `Shop created as office owner. Share code ${shopId} and the tech PIN with field devices — never the office PIN.`,
  };
}

/**
 * Join an existing shop by code + role + PIN.
 * Anonymous Auth → verify PIN → write membership for this uid → session.
 * Migrate-once rules from #2 still apply (after membership is established).
 */
export async function joinShop(
  rawCode: string,
  input: RolePinInput,
): Promise<CreateJoinResult> {
  const fb = requireFirebase();
  if (!fb.ok) return fb;

  if (hasJoinedShop() && isSessionAuthenticated()) {
    return {
      ok: false,
      error: "This device already joined a shop. Sign out or leave before joining another.",
    };
  }

  if (!isShopRole(input.role)) {
    return { ok: false, error: "Choose office or tech." };
  }

  const shopId = normalizeShopCode(rawCode);
  if (!isValidShopId(shopId)) {
    return {
      ok: false,
      error:
        'That shop code is not valid (non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 bytes).',
    };
  }

  let uid: string;
  try {
    ({ uid } = await ensureAnonymousAuth(fb.config));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not sign in anonymously to Firebase.";
    return {
      ok: false,
      error: `${message} Enable Anonymous Auth in the Firebase console for this project.`,
    };
  }

  const remote = new RemoteShopStore(fb.config, shopId);
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

  let remoteDoc = remoteResult.value;
  if (remoteDoc.authUnreadable) {
    return {
      ok: false,
      error:
        "This shop's PIN auth is corrupt or unreadable. Ask the office to repair the shop document — join cannot treat this as missing PINs.",
    };
  }
  const pinErr = await verifyAgainstAuth(remoteDoc.auth, input.role, input.pin);
  if (pinErr) return { ok: false, error: pinErr.error, reason: pinErr.reason };

  const membership = await ensureMembershipAfterPin(remote, remoteDoc, uid, input.role);
  if (!membership.ok) return { ok: false, error: membership.error };
  remoteDoc = membership.doc;

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
    // Now a member — CAS migrate; preserve PIN hashes + membership.
    const put = await remote.putShop({
      ...localDoc,
      auth: remoteDoc.auth,
      ownerUid: remoteDoc.ownerUid,
      members: remoteDoc.members,
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
    markShopMigrated(shopId);
  }

  const sessionErr = await persistAuthenticatedSession(shopId, input.role);
  if (sessionErr) {
    return { ok: false, error: `Joined ${shopId}, but ${sessionErr}` };
  }

  return {
    ok: true,
    shopId,
    role: input.role,
    migrated,
    hint,
    message: migrated
      ? `Joined ${shopId} as ${input.role}. Local data was uploaded once (shop was empty).`
      : `Joined ${shopId} as ${input.role}.`,
  };
}

/**
 * Unlock / sign-in: verify role+PIN against remote hashes; ensure membership for this uid.
 * Does not re-run migrate.
 */
export async function signInShop(
  rawCode: string,
  input: RolePinInput,
): Promise<CreateJoinResult> {
  const fb = requireFirebase();
  if (!fb.ok) return fb;

  if (!isShopRole(input.role)) {
    return { ok: false, error: "Choose office or tech." };
  }

  const remembered = loadShopSession().shopId;
  const shopId = normalizeShopCode(rawCode || remembered);
  if (!isValidShopId(shopId)) {
    return { ok: false, error: "Enter a valid shop code." };
  }

  let uid: string;
  try {
    ({ uid } = await ensureAnonymousAuth(fb.config));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not sign in anonymously to Firebase.";
    return {
      ok: false,
      error: `${message} Enable Anonymous Auth in the Firebase console for this project.`,
    };
  }

  const remote = new RemoteShopStore(fb.config, shopId);
  const remoteResult = await remote.getShop();
  if (!remoteResult.ok) {
    if (remoteMissingError(remoteResult.error)) {
      return {
        ok: false,
        error: `No shop found for code ${shopId}. Check the code with the office.`,
      };
    }
    return { ok: false, error: remoteResult.error };
  }

  if (remoteResult.value.authUnreadable) {
    return {
      ok: false,
      error:
        "This shop's PIN auth is corrupt or unreadable. Ask the office to repair the shop document — sign-in cannot treat this as missing PINs.",
    };
  }
  const pinErr = await verifyAgainstAuth(remoteResult.value.auth, input.role, input.pin);
  if (pinErr) return { ok: false, error: pinErr.error, reason: pinErr.reason };

  const membership = await ensureMembershipAfterPin(
    remote,
    remoteResult.value,
    uid,
    input.role,
  );
  if (!membership.ok) return { ok: false, error: membership.error };

  const sessionErr = await persistAuthenticatedSession(shopId, input.role);
  if (sessionErr) {
    return { ok: false, error: `Signed in to ${shopId}, but ${sessionErr}` };
  }

  return {
    ok: true,
    shopId,
    role: input.role,
    message: `Signed in to ${shopId} as ${input.role}.`,
  };
}

/**
 * One-time PIN bootstrap for pre-#3 shops (auth missing).
 * Signs in anonymously, writes hashes + owner membership, signs in as office.
 * Blocked when auth exists (including unreadable) or when membership already exists
 * without this uid being able to claim via office flow — rules also gate writes.
 */
export async function bootstrapShopPins(
  rawCode: string,
  pins: CreateShopPins,
): Promise<CreateJoinResult> {
  const fb = requireFirebase();
  if (!fb.ok) return fb;

  const pinErr = validateCreatePins(pins);
  if (pinErr) return { ok: false, error: pinErr };

  const remembered = loadShopSession().shopId;
  const shopId = normalizeShopCode(rawCode || remembered);
  if (!isValidShopId(shopId)) {
    return { ok: false, error: "Enter a valid shop code." };
  }

  let uid: string;
  try {
    ({ uid } = await ensureAnonymousAuth(fb.config));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not sign in anonymously to Firebase.";
    return {
      ok: false,
      error: `${message} Enable Anonymous Auth in the Firebase console for this project.`,
    };
  }

  const remote = new RemoteShopStore(fb.config, shopId);
  const remoteResult = await remote.getShop();
  if (!remoteResult.ok) {
    return { ok: false, error: remoteResult.error };
  }
  if (remoteResult.value.auth) {
    return {
      ok: false,
      error: "This shop already has PINs. Sign in with office or tech PIN instead.",
    };
  }
  if (remoteResult.value.authUnreadable) {
    return {
      ok: false,
      error:
        "This shop's PIN auth is corrupt or unreadable and must not be overwritten. Fix the shop document auth field (or restore from backup) before unlocking — bootstrap is blocked.",
    };
  }
  // If membership already exists and this uid is not office/owner, do not let a stranger
  // overwrite PINs via the legacy bootstrap UI (client gate; rules also restrict).
  if (hasMembership(remoteResult.value)) {
    const role = remoteResult.value.members?.[uid];
    const isOwner = remoteResult.value.ownerUid === uid;
    if (!isOwner && role !== "office") {
      return {
        ok: false,
        error:
          "This shop already has an owner/members. Sign in with the office PIN instead of bootstrapping new PINs.",
      };
    }
  }

  let auth: ShopPinAuth;
  try {
    auth = await buildShopPinAuth(pins.officePin, pins.techPin);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not hash PINs.";
    return { ok: false, error: message };
  }

  const members = {
    ...(remoteResult.value.members ?? {}),
    [uid]: "office" as const,
  };
  const put = await remote.putShop({
    ...remoteResult.value,
    auth,
    ownerUid: remoteResult.value.ownerUid ?? uid,
    members,
  });
  if (!put.ok) {
    return { ok: false, error: put.error };
  }

  const sessionErr = await persistAuthenticatedSession(shopId, "office");
  if (sessionErr) {
    return { ok: false, error: `PINs were set for ${shopId}, but ${sessionErr}` };
  }
  markShopMigrated(shopId);

  return {
    ok: true,
    shopId,
    role: "office",
    message: `PINs set for ${shopId}. You are signed in as office owner. Share the tech PIN with field devices.`,
  };
}

/**
 * Office-only: replace office + tech PIN hashes (requires authenticated office session
 * + Firebase membership as office/owner — enforced in firestore.rules).
 */
export async function changeShopPins(pins: CreateShopPins): Promise<CreateJoinResult> {
  const fb = requireFirebase();
  if (!fb.ok) return fb;

  const session = loadShopSession();
  if (!isSessionAuthenticated(session) || session.role !== "office") {
    return { ok: false, error: "Sign in as office to change PINs." };
  }

  const pinErr = validateCreatePins(pins);
  if (pinErr) return { ok: false, error: pinErr };

  let uid: string;
  try {
    ({ uid } = await ensureAnonymousAuth(fb.config));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not sign in anonymously to Firebase.";
    return {
      ok: false,
      error: `${message} Enable Anonymous Auth in the Firebase console for this project.`,
    };
  }

  const shopId = session.shopId.trim();
  const remote = new RemoteShopStore(fb.config, shopId);
  const remoteResult = await remote.getShop();
  if (!remoteResult.ok) {
    return { ok: false, error: remoteResult.error };
  }

  const doc = remoteResult.value;
  const isOwner = doc.ownerUid === uid;
  const memberRole = doc.members?.[uid];
  if (hasMembership(doc) && !isOwner && memberRole !== "office") {
    return { ok: false, error: "Only the office owner/members can change PINs." };
  }

  let auth: ShopPinAuth;
  try {
    auth = await buildShopPinAuth(pins.officePin, pins.techPin);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not hash PINs.";
    return { ok: false, error: message };
  }

  const put = await remote.putShop({
    ...doc,
    auth,
    ownerUid: doc.ownerUid ?? uid,
    members: doc.members ?? { [uid]: "office" },
  });
  if (!put.ok) {
    return { ok: false, error: put.error };
  }

  const sessionErr = await persistAuthenticatedSession(shopId, "office");
  if (sessionErr) {
    return { ok: false, error: `PINs were updated, but ${sessionErr}` };
  }

  return {
    ok: true,
    shopId,
    role: "office",
    message: "Office and tech PINs updated. Share the new tech PIN with field devices.",
  };
}

/** Sign out: clear role + verifiedAt; keep shopId for convenient unlock. Keeps Firebase anon uid. */
export function signOutShop(): CreateJoinResult {
  const session = loadShopSession();
  if (!hasJoinedShop(session)) {
    return { ok: false, error: "This device is not joined to a shared shop." };
  }
  const shopId = session.shopId.trim();
  if (!clearSessionAuth(session)) {
    return { ok: false, error: "Could not clear session auth on this device." };
  }
  return {
    ok: true,
    shopId,
    message: `Signed out of ${shopId}. Shop code is remembered on this device; enter role + PIN to unlock.`,
  };
}

/** Leave shared shop session → local-only. Does not wipe remote or local data. Keeps Firebase anon uid. */
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
