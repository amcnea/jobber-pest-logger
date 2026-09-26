/**
 * Shop PIN + membership callables (cf1, docs/BACKLOG.md). Every call requires
 * Firebase Auth; PINs are verified against stored hashes server-side and
 * membership/owner is checked before any grant or PIN change. Writes use the
 * Admin SDK inside a transaction. Not deployed from CI — see functions/README.md.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { decideBootstrap, decideChangePins, decideJoin, type Decision, type ShopAccessDoc } from "./access";
import { buildShopPinAuth } from "./pin";

initializeApp();

function isValidShopId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    Buffer.byteLength(id) <= 1500 &&
    id !== "." &&
    id !== ".." &&
    !id.includes("/") &&
    !/^__.*__$/.test(id)
  );
}

function requireCaller(req: CallableRequest<unknown>): { uid: string; data: Record<string, unknown>; shopId: string } {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in before using a shared shop.");
  const data = (typeof req.data === "object" && req.data !== null ? req.data : {}) as Record<string, unknown>;
  const shopId = typeof data.shopId === "string" ? data.shopId.trim() : data.shopId;
  if (!isValidShopId(shopId)) throw new HttpsError("invalid-argument", "Enter a valid shop code.");
  return { uid, data, shopId };
}

function unwrap<T>(d: Decision<T>): T {
  if (!d.ok) throw new HttpsError(d.code, d.message);
  return d.value;
}

async function withShop<T>(
  shopId: string,
  fn: (tx: Transaction, doc: ShopAccessDoc, ref: DocumentReference) => T,
): Promise<T> {
  const db = getFirestore();
  const ref = db.collection("shops").doc(shopId);
  return db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `No shop found for code ${shopId}.`);
    return fn(tx, snap.data() as ShopAccessDoc, ref);
  });
}

/** Join / unlock: { shopId, role, pin } → grants members[uid]=role after server PIN verify. */
export const joinShopWithPin = onCall(async (req) => {
  const { uid, data, shopId } = requireCaller(req);
  return withShop(shopId, (tx, doc, ref) => {
    const grant = unwrap(decideJoin(doc, uid, data.role, data.pin));
    const updatedAt = new Date().toISOString();
    const patch: Record<string, unknown> = { members: grant.members, updatedAt };
    if (grant.ownerUid) patch.ownerUid = grant.ownerUid;
    tx.update(ref, patch);
    return { role: grant.role, members: grant.members, ownerUid: grant.ownerUid || null, updatedAt };
  });
});

/** Legacy bootstrap: { shopId, officePin, techPin } for shops without PIN auth. */
export const bootstrapShopPins = onCall(async (req) => {
  const { uid, data, shopId } = requireCaller(req);
  return withShop(shopId, (tx, doc, ref) => {
    const grant = unwrap(decideBootstrap(doc, uid, data.officePin, data.techPin));
    const updatedAt = new Date().toISOString();
    const auth = buildShopPinAuth(data.officePin as string, data.techPin as string);
    tx.update(ref, { auth, members: grant.members, ownerUid: grant.ownerUid, updatedAt });
    return { members: grant.members, ownerUid: grant.ownerUid, updatedAt };
  });
});

/** Office PIN change: { shopId, officePin, techPin }; caller must be owner/office member. */
export const changeShopPins = onCall(async (req) => {
  const { uid, data, shopId } = requireCaller(req);
  return withShop(shopId, (tx, doc, ref) => {
    unwrap(decideChangePins(doc, uid, data.officePin, data.techPin));
    const updatedAt = new Date().toISOString();
    const auth = buildShopPinAuth(data.officePin as string, data.techPin as string);
    tx.update(ref, { auth, updatedAt });
    return { updatedAt };
  });
});
