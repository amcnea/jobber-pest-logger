/**
 * Pure authorization decisions for the shop callables (cf1). No Firestore I/O
 * here so the rules can be unit-tested offline.
 */
import { isShopRole, parseShopPinAuth, validatePinPair, verifyPin, type ShopRole } from "./pin";

export type ShopMembers = Record<string, ShopRole>;

export interface ShopAccessDoc {
  auth?: unknown;
  ownerUid?: unknown;
  members?: unknown;
}

export type Decision<T> = { ok: true; value: T } | { ok: false; code: "permission-denied" | "failed-precondition" | "invalid-argument"; message: string };

export function parseMembers(raw: unknown): ShopMembers {
  const out: ShopMembers = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [uid, role] of Object.entries(raw as Record<string, unknown>)) {
    if (isShopRole(role)) out[uid] = role;
  }
  return out;
}

function ownerOf(doc: ShopAccessDoc): string {
  return typeof doc.ownerUid === "string" ? doc.ownerUid : "";
}

export function isOfficeCaller(doc: ShopAccessDoc, uid: string): boolean {
  return ownerOf(doc) === uid || parseMembers(doc.members)[uid] === "office";
}

export function hasMembership(doc: ShopAccessDoc): boolean {
  return Boolean(ownerOf(doc)) || Object.keys(parseMembers(doc.members)).length > 0;
}

/** Join / unlock: verify the role PIN server-side, then grant members[uid] (+ legacy owner claim). */
export function decideJoin(
  doc: ShopAccessDoc,
  uid: string,
  role: unknown,
  pin: unknown,
): Decision<{ role: ShopRole; members: ShopMembers; ownerUid: string }> {
  if (!isShopRole(role)) return { ok: false, code: "invalid-argument", message: "Choose office or tech." };
  if (doc.auth === undefined || doc.auth === null) {
    return { ok: false, code: "failed-precondition", message: "This shop has no PINs yet. An office device must set office and tech PINs before unlock/join." };
  }
  const auth = parseShopPinAuth(doc.auth);
  if (!auth) {
    return { ok: false, code: "failed-precondition", message: "This shop's PIN auth is corrupt or unreadable. Ask the office to repair the shop document." };
  }
  const record = role === "office" ? auth.officePin : auth.techPin;
  if (!verifyPin(pin, record)) {
    return { ok: false, code: "permission-denied", message: "Incorrect PIN for that role. Try again or ask the office." };
  }
  const members = { ...parseMembers(doc.members), [uid]: role };
  const owner = ownerOf(doc);
  const ownerUid = !owner && role === "office" ? uid : owner;
  return { ok: true, value: { role, members, ownerUid } };
}

/** Pre-#3 shops with no PIN auth: set hashes once; existing owner/members must be office. */
export function decideBootstrap(
  doc: ShopAccessDoc,
  uid: string,
  officePin: unknown,
  techPin: unknown,
): Decision<{ members: ShopMembers; ownerUid: string }> {
  if (doc.auth !== undefined && doc.auth !== null) {
    return { ok: false, code: "failed-precondition", message: "This shop already has PINs (or unreadable PIN auth). Sign in with office or tech PIN instead." };
  }
  if (hasMembership(doc) && !isOfficeCaller(doc, uid)) {
    return { ok: false, code: "permission-denied", message: "This shop already has an owner/members. Sign in with the office PIN instead of bootstrapping new PINs." };
  }
  const pinErr = validatePinPair(officePin, techPin);
  if (pinErr) return { ok: false, code: "invalid-argument", message: pinErr };
  const members: ShopMembers = { ...parseMembers(doc.members), [uid]: "office" };
  return { ok: true, value: { members, ownerUid: ownerOf(doc) || uid } };
}

/** PIN change: caller must already be the owner or an office member on the shop doc. */
export function decideChangePins(
  doc: ShopAccessDoc,
  uid: string,
  officePin: unknown,
  techPin: unknown,
): Decision<null> {
  if (!isOfficeCaller(doc, uid)) {
    return { ok: false, code: "permission-denied", message: "Only the office owner/members can change PINs. Sign in with the office PIN first." };
  }
  const pinErr = validatePinPair(officePin, techPin);
  if (pinErr) return { ok: false, code: "invalid-argument", message: pinErr };
  return { ok: true, value: null };
}
