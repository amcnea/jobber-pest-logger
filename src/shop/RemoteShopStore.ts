/**
 * RemoteShopStore — Firestore shops/{shopId}.
 * Only constructed when Firebase env is configured AND a shop session id exists.
 * Firebase SDK is lazy-imported so local-only builds do not need a project at runtime.
 */

import type { FirebaseClientConfig } from "./firebaseConfig";
import type { ShopDocument, ShopStore, ShopStoreResult } from "./types";

const SHOPS_COLLECTION = "shops";

type FirestoreFns = {
  docRef: unknown;
  getDoc: (ref: unknown) => Promise<{ exists: () => boolean; data: () => unknown }>;
  setDoc: (ref: unknown, data: unknown) => Promise<void>;
};

async function loadFirestore(config: FirebaseClientConfig, shopId: string): Promise<FirestoreFns> {
  // Lazy import — tree-shakeable entry; not pulled into the critical path when unused.
  const [{ initializeApp, getApps }, { getFirestore, doc, getDoc, setDoc }] = await Promise.all([
    import("firebase/app"),
    import("firebase/firestore"),
  ]);

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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Light shape check — full field validation stays in storage parsers for now. */
function coerceShopDocument(raw: unknown): ShopDocument | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.version !== "string" || !raw.version.trim()) return null;
  if (typeof raw.updatedAt !== "string" || !raw.updatedAt.trim()) return null;
  if (!Array.isArray(raw.logs) || !Array.isArray(raw.catalog) || !Array.isArray(raw.people)) {
    return null;
  }
  if (!isRecord(raw.settings)) return null;
  const lastBackupAt =
    raw.lastBackupAt === undefined
      ? undefined
      : raw.lastBackupAt === null
        ? null
        : typeof raw.lastBackupAt === "string"
          ? raw.lastBackupAt
          : undefined;
  return {
    version: raw.version.trim(),
    updatedAt: raw.updatedAt.trim(),
    logs: raw.logs as unknown as ShopDocument["logs"],
    catalog: raw.catalog as unknown as ShopDocument["catalog"],
    people: raw.people as unknown as ShopDocument["people"],
    settings: raw.settings as unknown as ShopDocument["settings"],
    lastBackupAt,
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
    if (!this.shopId) {
      throw new Error("RemoteShopStore requires a non-empty shopId");
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

  async putShop(doc: ShopDocument): Promise<ShopStoreResult<void>> {
    try {
      const { docRef, setDoc } = await this.fs();
      const payload: ShopDocument = {
        ...doc,
        updatedAt: doc.updatedAt || new Date().toISOString(),
      };
      await setDoc(docRef, payload);
      return { ok: true, value: undefined };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not save shop to Firestore.";
      return { ok: false, error: message };
    }
  }

  /** Stub — onSnapshot subscribe is a later slice. */
  subscribe(_onChange: (doc: ShopDocument) => void): () => void {
    return () => {};
  }
}
