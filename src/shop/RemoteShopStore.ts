/**
 * RemoteShopStore — Firestore shops/{shopId}.
 * Only constructed when Firebase env is configured AND a shop session id exists.
 * Firebase SDK is lazy-imported so local-only builds do not need a project at runtime.
 * #5: every remote op signs in anonymously first so rules can check request.auth.uid.
 */

import { parseShopSections } from "../storage";
import { ensureAnonymousAuth } from "./firebaseAuth";
import { getFirebaseApp } from "./firebaseApp";
import type { FirebaseClientConfig } from "./firebaseConfig";
import { isShopRole, parseShopPinAuth } from "./pinCrypto";
import { isValidShopId } from "./session";
import type { ShopDocument, ShopMembers, ShopStore, ShopStoreResult } from "./types";

const SHOPS_COLLECTION = "shops";

/** Thrown inside a transaction when remote updatedAt !== caller's snapshot. */
class ShopWriteConflictError extends Error {
  readonly conflict = true as const;
  constructor(message = "Shop was updated elsewhere; reload and try again.") {
    super(message);
    this.name = "ShopWriteConflictError";
  }
}

type FirestoreSnap = { exists: () => boolean; data: () => unknown };

type FirestoreFns = {
  docRef: unknown;
  getDoc: (ref: unknown) => Promise<FirestoreSnap>;
  setDoc: (ref: unknown, data: unknown) => Promise<void>;
  /**
   * CAS put: fails with ShopWriteConflictError if the remote doc's updatedAt
   * differs from expectedUpdatedAt (caller's snapshot). Stamps a fresh updatedAt
   * on the written payload after the check succeeds, and returns that committed stamp.
   * When expectedUpdatedAt is "" and the doc is missing, create is allowed.
   */
  putWithCas: (expectedUpdatedAt: string, payload: ShopDocument) => Promise<string>;
  /**
   * Membership-only update (join / legacy claim). Does not rewrite logs/catalog.
   * CAS on updatedAt; merges members (+ ownerUid when claiming legacy).
   */
  mergeMembership: (args: {
    expectedUpdatedAt: string;
    uid: string;
    role: "office" | "tech";
    /** When true and remote has no ownerUid, set ownerUid to uid (legacy claim). */
    claimOwnerIfMissing: boolean;
  }) => Promise<{ updatedAt: string; members: ShopMembers; ownerUid?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMembers(raw: unknown): ShopMembers | undefined {
  if (!isRecord(raw)) return undefined;
  const out: ShopMembers = {};
  for (const [uid, role] of Object.entries(raw)) {
    if (typeof uid !== "string" || !uid.trim()) continue;
    if (!isShopRole(role)) continue;
    out[uid] = role;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseOwnerUid(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const uid = raw.trim();
  return uid || undefined;
}

/** Validate remote shop doc with the same section parsers as backup restore. */
function coerceShopDocument(raw: unknown): ShopDocument | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.version !== "string" || !raw.version.trim()) return null;
  if (typeof raw.updatedAt !== "string" || !raw.updatedAt.trim()) return null;

  let lastBackupAt: string | null | undefined;
  if (raw.lastBackupAt === undefined) {
    lastBackupAt = undefined;
  } else if (raw.lastBackupAt === null) {
    lastBackupAt = null;
  } else if (
    typeof raw.lastBackupAt === "string" &&
    raw.lastBackupAt.trim() !== "" &&
    !Number.isNaN(Date.parse(raw.lastBackupAt))
  ) {
    lastBackupAt = raw.lastBackupAt.trim();
  } else {
    return null;
  }

  const sectionsResult = parseShopSections({
    logs: raw.logs,
    catalog: raw.catalog,
    people: raw.people,
    settings: raw.settings,
  });
  if (!sectionsResult.ok) return null;

  const { logs, catalog, people, settings } = sectionsResult.sections;
  const doc: ShopDocument = {
    version: raw.version.trim(),
    updatedAt: raw.updatedAt.trim(),
    logs,
    catalog,
    people,
    settings,
    lastBackupAt,
  };
  // auth key present and not undefined: parse or mark unreadable (client-only signal).
  if ("auth" in raw && raw.auth !== undefined) {
    const auth = parseShopPinAuth(raw.auth);
    if (auth) {
      doc.auth = auth;
    } else {
      doc.authUnreadable = true;
    }
  }
  const ownerUid = parseOwnerUid(raw.ownerUid);
  if (ownerUid) doc.ownerUid = ownerUid;
  const members = parseMembers(raw.members);
  if (members) doc.members = members;
  return doc;
}

/** Strip client-only signals before Firestore writes. */
function firestorePayload(doc: ShopDocument): Record<string, unknown> {
  const payload: ShopDocument = { ...doc };
  delete payload.authUnreadable;
  return { ...payload };
}

async function loadFirestore(config: FirebaseClientConfig, shopId: string): Promise<FirestoreFns> {
  if (!isValidShopId(shopId)) {
    throw new Error(
      'Cannot build shops/{shopId} path: shopId must be non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 UTF-8 bytes',
    );
  }
  // Auth first — rules require request.auth for all shop access (#5).
  await ensureAnonymousAuth(config);

  const app = await getFirebaseApp(config);
  const { getFirestore, doc, getDoc, setDoc, runTransaction } = await import("firebase/firestore");

  const db = getFirestore(app);
  const docRef = doc(db, SHOPS_COLLECTION, shopId);
  return {
    docRef,
    getDoc: getDoc as FirestoreFns["getDoc"],
    setDoc: setDoc as FirestoreFns["setDoc"],
    putWithCas: async (expectedUpdatedAt, payload) => {
      let committedUpdatedAt = "";
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(docRef);
        if (snap.exists()) {
          const data = snap.data() as Record<string, unknown> | undefined;
          const remoteUpdatedAt =
            data && typeof data.updatedAt === "string" ? data.updatedAt : "";
          if (remoteUpdatedAt !== expectedUpdatedAt) {
            throw new ShopWriteConflictError();
          }
        }
        committedUpdatedAt = new Date().toISOString();
        transaction.set(docRef, {
          ...firestorePayload(payload),
          updatedAt: committedUpdatedAt,
        });
      });
      return committedUpdatedAt;
    },
    mergeMembership: async ({ expectedUpdatedAt, uid, role, claimOwnerIfMissing }) => {
      let committedUpdatedAt = "";
      let nextMembers: ShopMembers = {};
      let nextOwnerUid: string | undefined;
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(docRef);
        if (!snap.exists()) {
          throw new Error(`Shop "${shopId}" was not found in Firestore.`);
        }
        const data = snap.data() as Record<string, unknown>;
        const remoteUpdatedAt = typeof data.updatedAt === "string" ? data.updatedAt : "";
        if (remoteUpdatedAt !== expectedUpdatedAt) {
          throw new ShopWriteConflictError();
        }
        const existingMembers = parseMembers(data.members) ?? {};
        nextMembers = { ...existingMembers, [uid]: role };
        const existingOwner = parseOwnerUid(data.ownerUid);
        nextOwnerUid =
          existingOwner ?? (claimOwnerIfMissing ? uid : existingOwner);

        committedUpdatedAt = new Date().toISOString();
        const patch: Record<string, unknown> = {
          members: nextMembers,
          updatedAt: committedUpdatedAt,
        };
        if (nextOwnerUid && !existingOwner) {
          patch.ownerUid = nextOwnerUid;
        }
        transaction.update(docRef, patch);
      });
      return {
        updatedAt: committedUpdatedAt,
        members: nextMembers,
        ownerUid: nextOwnerUid,
      };
    },
  };
}

export class RemoteShopStore implements ShopStore {
  readonly mode = "shared" as const;
  private readonly config: FirebaseClientConfig;
  private readonly shopId: string;
  private firestore: FirestoreFns | null = null;

  constructor(config: FirebaseClientConfig, shopId: string) {
    this.config = config;
    this.shopId = shopId.trim();
    if (!isValidShopId(this.shopId)) {
      throw new Error(
        'RemoteShopStore requires a valid shopId (non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 UTF-8 bytes)',
      );
    }
  }

  private async fs(): Promise<FirestoreFns> {
    if (!this.firestore) {
      this.firestore = await loadFirestore(this.config, this.shopId);
    }
    return this.firestore;
  }

  /** Ensure anonymous auth and return this device's Firebase uid. */
  async ensureUid(): Promise<string> {
    const { uid } = await ensureAnonymousAuth(this.config);
    return uid;
  }

  async getShop(): Promise<ShopStoreResult<ShopDocument>> {
    try {
      const { docRef, getDoc } = await this.fs();
      const snap = await getDoc(docRef);
      if (!snap.exists()) {
        return {
          ok: false,
          error: `Shop "${this.shopId}" was not found in Firestore (shops/${this.shopId}).`,
        };
      }
      const doc = coerceShopDocument(snap.data());
      if (!doc) {
        return { ok: false, error: "Remote shop document has an invalid shape." };
      }
      return { ok: true, value: doc };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not load shop from Firestore.";
      return { ok: false, error: message };
    }
  }

  async putShop(doc: ShopDocument): Promise<ShopStoreResult<{ updatedAt: string }>> {
    try {
      const { putWithCas } = await this.fs();
      const updatedAt = await putWithCas(doc.updatedAt, doc);
      return { ok: true, value: { updatedAt } };
    } catch (err) {
      if (err instanceof ShopWriteConflictError || (err && (err as { conflict?: boolean }).conflict)) {
        return {
          ok: false,
          error: "Shop was updated elsewhere; reload and try again.",
          conflict: true,
        };
      }
      const message =
        err instanceof Error ? err.message : "Could not save shop to Firestore.";
      return { ok: false, error: message };
    }
  }

  /**
   * Add or refresh this uid's membership without rewriting shop data.
   * Used after client-side PIN verify on join / unlock / legacy claim.
   */
  async addMembership(args: {
    expectedUpdatedAt: string;
    uid: string;
    role: "office" | "tech";
    claimOwnerIfMissing?: boolean;
  }): Promise<
    ShopStoreResult<{ updatedAt: string; members: ShopMembers; ownerUid?: string }>
  > {
    try {
      const { mergeMembership } = await this.fs();
      const value = await mergeMembership({
        expectedUpdatedAt: args.expectedUpdatedAt,
        uid: args.uid,
        role: args.role,
        claimOwnerIfMissing: Boolean(args.claimOwnerIfMissing),
      });
      return { ok: true, value };
    } catch (err) {
      if (err instanceof ShopWriteConflictError || (err && (err as { conflict?: boolean }).conflict)) {
        return {
          ok: false,
          error: "Shop was updated elsewhere; reload and try again.",
          conflict: true,
        };
      }
      const message =
        err instanceof Error ? err.message : "Could not update shop membership.";
      return { ok: false, error: message };
    }
  }

  /** Stub — onSnapshot subscribe is a later offline/live slice. */
  subscribe(_onChange: (doc: ShopDocument) => void): () => void {
    return () => {};
  }
}
