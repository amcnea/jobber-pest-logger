/**
 * RemoteShopStore — Firestore shops/{shopId}.
 * Only constructed when Firebase env is configured AND a shop session id exists.
 * Firebase SDK is lazy-imported so local-only builds do not need a project at runtime.
 */

import { parseShopSections } from "../storage";
import type { FirebaseClientConfig } from "./firebaseConfig";
import { parseShopPinAuth } from "./pinCrypto";
import { isValidShopId } from "./session";
import type { ShopDocument, ShopStore, ShopStoreResult } from "./types";

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
   */
  putWithCas: (expectedUpdatedAt: string, payload: ShopDocument) => Promise<string>;
};

async function loadFirestore(config: FirebaseClientConfig, shopId: string): Promise<FirestoreFns> {
  // Belt-and-suspenders: never build a Firestore doc path with an invalid shopId.
  if (!isValidShopId(shopId)) {
    throw new Error(
      'Cannot build shops/{shopId} path: shopId must be non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 UTF-8 bytes',
    );
  }
  // Lazy import — tree-shakeable entry; not pulled into the critical path when unused.
  const [{ initializeApp, getApps }, { getFirestore, doc, getDoc, setDoc, runTransaction }] =
    await Promise.all([import("firebase/app"), import("firebase/firestore")]);

  const appName = "jobber-pest-logger";
  const existing = getApps().find((a) => a.name === appName);
  const app =
    existing ??
    initializeApp(
      {
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        appId: config.appId,
      },
      appName,
    );
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
        // Missing doc ⇒ first write / create; no conflict.
        // Stamp write time only after CAS succeeds (and on each retry attempt).
        committedUpdatedAt = new Date().toISOString();
        transaction.set(docRef, {
          ...payload,
          updatedAt: committedUpdatedAt,
        });
      });
      return committedUpdatedAt;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const auth = parseShopPinAuth(raw.auth);
  return {
    version: raw.version.trim(),
    updatedAt: raw.updatedAt.trim(),
    logs,
    catalog,
    people,
    settings,
    lastBackupAt,
    ...(auth ? { auth } : {}),
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
    // Match session.isValidShopId — reject empty, `/`, `.`, `..`, `__.*__`, >1500 UTF-8 bytes.
    // Any path that builds a Firestore doc id must use a validated shopId (constructor gate).
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
      // CAS against caller's snapshot updatedAt; return the committed stamp for next CAS.
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

  /** Stub — onSnapshot subscribe is a later offline/live slice. */
  subscribe(_onChange: (doc: ShopDocument) => void): () => void {
    return () => {};
  }
}