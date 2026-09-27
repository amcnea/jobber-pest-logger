/**
 * Shop PIN + membership callables (cf1, docs/BACKLOG.md). Every call requires
 * Firebase Auth; PINs are verified against stored hashes server-side and
 * membership/owner is checked before any grant or PIN change. Writes use the
 * Admin SDK inside a transaction. Not deployed from CI — see functions/README.md.
 */
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { decideBootstrap, decideChangePins, decideJoin, type Decision, type ShopAccessDoc } from "./access";
import { buildShopPinAuth, type ShopPinAuth } from "./pin";
import { effectiveAccessDoc, shopDocExposesAuth, type ShopDocWithPins, type ShopSecretDoc } from "./secrets";
import {
  MAX_FAILS_PER_CALLER,
  MAX_FAILS_PER_SHOP,
  callerKey,
  currentCounter,
  isLocked,
  lockedMessage,
  recordFail,
  shopKey,
} from "./rateLimit";

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

interface ShopCtx {
  tx: Transaction;
  /** Access doc with PIN auth resolved from shopSecrets (legacy: shop doc). */
  doc: ShopAccessDoc;
  shop: ShopDocWithPins;
  ref: DocumentReference;
  secretRef: DocumentReference;
}

async function withShop<T>(shopId: string, fn: (ctx: ShopCtx) => T): Promise<T> {
  const db = getFirestore();
  const ref = db.collection("shops").doc(shopId);
  const secretRef = db.collection("shopSecrets").doc(shopId);
  return db.runTransaction(async (tx: Transaction) => {
    const [snap, secretSnap] = await Promise.all([tx.get(ref), tx.get(secretRef)]);
    if (!snap.exists) throw new HttpsError("not-found", `No shop found for code ${shopId}.`);
    const shop = snap.data() as ShopDocWithPins;
    const secret = secretSnap.exists ? (secretSnap.data() as ShopSecretDoc) : undefined;
    return fn({ tx, doc: effectiveAccessDoc(shop, secret), shop, ref, secretRef });
  });
}

/** Store hashes in shopSecrets and strip them from the readable shop doc (cf2). */
function writeHiddenPins(ctx: ShopCtx, auth: ShopPinAuth | unknown, updatedAt: string, shopPatch: Record<string, unknown>): void {
  ctx.tx.set(ctx.secretRef, { auth, updatedAt });
  ctx.tx.update(ctx.ref, { ...shopPatch, auth: FieldValue.delete(), pinsConfigured: true, updatedAt });
}

/**
 * Join / unlock: { shopId, role, pin } → grants members[uid]=role after server PIN verify.
 * Failed PIN attempts are limited per caller (uid + shop) and per shop in a
 * fixed window (see rateLimit.ts). The counters are written in the same
 * transaction, and the wrong-PIN error is thrown only after that commit so the
 * failure is recorded rather than rolled back.
 */
export const joinShopWithPin = onCall(async (req) => {
  const { uid, data, shopId } = requireCaller(req);
  const db = getFirestore();
  const callerRef = db.collection("pinAttempts").doc(callerKey(shopId, uid));
  const shopRef = db.collection("pinAttempts").doc(shopKey(shopId));
  const outcome = await withShop(shopId, async (ctx) => {
    const { tx } = ctx;
    const [callerSnap, shopSnap] = await Promise.all([tx.get(callerRef), tx.get(shopRef)]);
    const nowMs = Date.now();
    const caller = currentCounter(callerSnap.data(), nowMs);
    const shop = currentCounter(shopSnap.data(), nowMs);
    if (isLocked(caller, MAX_FAILS_PER_CALLER)) throw new HttpsError("resource-exhausted", lockedMessage(caller, nowMs));
    if (isLocked(shop, MAX_FAILS_PER_SHOP)) throw new HttpsError("resource-exhausted", lockedMessage(shop, nowMs));

    const d = decideJoin(ctx.doc, uid, data.role, data.pin);
    const updatedAt = new Date(nowMs).toISOString();
    if (!d.ok) {
      if (d.code !== "permission-denied") throw new HttpsError(d.code, d.message);
      tx.set(callerRef, { ...recordFail(caller), shopId, uid, updatedAt });
      tx.set(shopRef, { ...recordFail(shop), shopId, updatedAt });
      return { ok: false as const, message: d.message };
    }
    const grant = d.value;
    const patch: Record<string, unknown> = { members: grant.members, updatedAt };
    if (grant.ownerUid) patch.ownerUid = grant.ownerUid;
    if (shopDocExposesAuth(ctx.shop)) {
      // Legacy doc: the PIN just verified, so move the hashes out of the readable doc.
      writeHiddenPins(ctx, ctx.doc.auth, updatedAt, patch);
    } else {
      tx.update(ctx.ref, patch);
    }
    if (callerSnap.exists) tx.delete(callerRef);
    return { ok: true as const, value: { role: grant.role, members: grant.members, ownerUid: grant.ownerUid || null, updatedAt } };
  });
  if (!outcome.ok) throw new HttpsError("permission-denied", outcome.message);
  return outcome.value;
});

/** Legacy bootstrap: { shopId, officePin, techPin } for shops without PIN auth. */
export const bootstrapShopPins = onCall(async (req) => {
  const { uid, data, shopId } = requireCaller(req);
  return withShop(shopId, (ctx) => {
    const grant = unwrap(decideBootstrap(ctx.doc, uid, data.officePin, data.techPin));
    const updatedAt = new Date().toISOString();
    const auth = buildShopPinAuth(data.officePin as string, data.techPin as string);
    writeHiddenPins(ctx, auth, updatedAt, { members: grant.members, ownerUid: grant.ownerUid });
    return { members: grant.members, ownerUid: grant.ownerUid, updatedAt };
  });
});

/** Office PIN change: { shopId, officePin, techPin }; caller must be owner/office member. */
export const changeShopPins = onCall(async (req) => {
  const { uid, data, shopId } = requireCaller(req);
  return withShop(shopId, (ctx) => {
    unwrap(decideChangePins(ctx.doc, uid, data.officePin, data.techPin));
    const updatedAt = new Date().toISOString();
    const auth = buildShopPinAuth(data.officePin as string, data.techPin as string);
    writeHiddenPins(ctx, auth, updatedAt, {});
    return { updatedAt };
  });
});
