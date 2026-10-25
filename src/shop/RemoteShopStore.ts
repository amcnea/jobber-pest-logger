/**
 * RemoteShopStore — Firestore shops/{shopId} + per-log subcollection shops/{shopId}/logs/{logId} (#215).
 * Only constructed when Firebase env is configured AND a shop session id exists.
 * Firebase SDK is lazy-imported so local-only builds do not need a project at runtime.
 * #5: every remote op signs in anonymously first so rules can check request.auth.uid.
 */

import { parseShopSections } from "../storage";
import type { ApplicationLog } from "../types";
import { dedupeLogsById, planLegacyDrain, setAsideDuplicateCopies, stableJson } from "./dedupeLogs";
import { ensureAnonymousAuth } from "./firebaseAuth";
import { getFirebaseApp } from "./firebaseApp";
import type { FirebaseClientConfig } from "./firebaseConfig";
import { isShopRole, parseShopPinAuth } from "./pinCrypto";
import { recordReviewedCopyConflicts } from "./reviewedCopies";
import { isValidShopId } from "./session";
import type { ShopDocument, ShopMembers, ShopStore, ShopStoreResult } from "./types";

const SHOPS_COLLECTION = "shops";
const LOGS_SUBCOLLECTION = "logs";

/** Thrown inside a transaction when remote updatedAt !== caller's snapshot. */
class ShopWriteConflictError extends Error {
  readonly conflict = true as const;
  constructor(message = "Shop was updated elsewhere; reload and try again.") {
    super(message);
    this.name = "ShopWriteConflictError";
  }
}

type FirestoreSnap = { exists: () => boolean; data: () => unknown };
type FirestoreLogDoc = { id: string; data: unknown };

type FirestoreFns = {
  docRef: unknown;
  getDoc: (ref: unknown) => Promise<FirestoreSnap>;
  setDoc: (ref: unknown, data: unknown) => Promise<void>;
  getLogs: () => Promise<FirestoreLogDoc[]>;
  putLog: (logId: string, data: unknown) => Promise<void>;
  deleteLog: (logId: string) => Promise<void>;
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
    logs: raw.logs === undefined ? [] : raw.logs,
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
  if (raw.pinsConfigured === true) doc.pinsConfigured = true;
  const ownerUid = parseOwnerUid(raw.ownerUid);
  if (ownerUid) doc.ownerUid = ownerUid;
  const members = parseMembers(raw.members);
  if (members) doc.members = members;
  return doc;
}

/** Validate per-log documents from `shops/{shopId}/logs/{logId}` (#215). */
function coerceSubcollectionLogs(
  logDocs: readonly FirestoreLogDoc[],
  fallbackSettings: ShopDocument["settings"],
): ApplicationLog[] | null {
  if (logDocs.length === 0) return [];
  const rawLogs: unknown[] = [];
  for (const item of logDocs) {
    if (!isRecord(item.data) || item.data.id !== item.id) return null;
    rawLogs.push(item.data);
  }
  const parsed = parseShopSections({
    logs: rawLogs,
    catalog: [],
    people: [],
    settings: fallbackSettings,
  });
  return parsed.ok ? parsed.sections.logs : null;
}

/** Strip client-only signals and undefined fields before Firestore writes. */
function firestorePayload(doc: ShopDocument): Record<string, unknown> {
  const { authUnreadable: _drop, ...rest } = doc;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}

function cleanFirestoreValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  const {
    getFirestore,
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    deleteDoc,
    runTransaction,
  } = await import("firebase/firestore");

  const db = getFirestore(app);
  const docRef = doc(db, SHOPS_COLLECTION, shopId);
  const logsColRef = collection(db, SHOPS_COLLECTION, shopId, LOGS_SUBCOLLECTION);
  return {
    docRef,
    getDoc: getDoc as FirestoreFns["getDoc"],
    setDoc: setDoc as FirestoreFns["setDoc"],
    getLogs: async () => {
      const snap = await getDocs(logsColRef);
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    },
    putLog: async (logId, data) => {
      if (!isValidShopId(logId)) {
        throw new Error(
          'Cannot build shops/{shopId}/logs/{logId} path: logId must be non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 UTF-8 bytes',
        );
      }
      const logRef = doc(db, SHOPS_COLLECTION, shopId, LOGS_SUBCOLLECTION, logId);
      await setDoc(logRef, cleanFirestoreValue(data));
    },
    deleteLog: async (logId) => {
      if (!isValidShopId(logId)) {
        throw new Error(
          'Cannot build shops/{shopId}/logs/{logId} path: logId must be non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 UTF-8 bytes',
        );
      }
      const logRef = doc(db, SHOPS_COLLECTION, shopId, LOGS_SUBCOLLECTION, logId);
      await deleteDoc(logRef);
    },
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

interface StoredShopState {
  /** ShopDocument with de-duplicated winning logs across subcollection + legacy array. */
  doc: ShopDocument;
  /** Logs currently stored in `shops/{shopId}/logs/{logId}` (one per id). */
  subLogs: Map<string, ApplicationLog>;
  /** Unmigrated or kept logs currently stored in `shops/{shopId}.logs`. */
  legacyLogs: ApplicationLog[];
  /** Raw objects from `shops/{shopId}.logs` so migration writes the exact stored map. */
  rawLegacyLogs: unknown[];
  /** Whether non-identical duplicate losers were saved to SET_ASIDE_KEY. */
  setAsideOk: boolean;
}

export class RemoteShopStore implements ShopStore {
  readonly mode = "shared" as const;
  private readonly config: FirebaseClientConfig;
  private readonly shopId: string;
  private firestore: FirestoreFns | null = null;
  /** #209 / #215: last shop state read or written, reused across sequential writes (#210). */
  private stored: StoredShopState | null = null;

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
      const fs = await this.fs();
      const [snap, logDocs] = await Promise.all([fs.getDoc(fs.docRef), fs.getLogs()]);
      if (!snap.exists()) {
        return {
          ok: false,
          error: `Shop "${this.shopId}" was not found in Firestore (shops/${this.shopId}).`,
        };
      }
      const rawShop = snap.data();
      const doc = coerceShopDocument(rawShop);
      const subLogs = doc ? coerceSubcollectionLogs(logDocs, doc.settings) : null;
      if (!doc || !subLogs) {
        return { ok: false, error: "Remote shop document has an invalid shape." };
      }
      const rawLegacy = isRecord(rawShop) && Array.isArray(rawShop.logs) ? rawShop.logs : [];
      return { ok: true, value: this.cacheStored(doc, subLogs, rawLegacy) };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not load shop from Firestore.";
      return { ok: false, error: message };
    }
  }

  /**
   * #209 / #215: combine per-log subcollection docs (`subLogs`) with any unmigrated
   * legacy `shops/{shopId}.logs` entries (`doc.logs`), keep one winner per log id, set
   * aside losing copies, and record #212 conflicts.
   */
  private cacheStored(
    doc: ShopDocument,
    subLogs: readonly ApplicationLog[],
    rawLegacyLogs: readonly unknown[],
  ): ShopDocument {
    const allLogs = [...subLogs, ...doc.logs];
    const { logs, losers } = dedupeLogsById(allLogs);
    const setAsideOk = setAsideDuplicateCopies(this.shopId, losers);
    recordReviewedCopyConflicts(this.shopId, allLogs); // #212 office note
    const mergedDoc: ShopDocument = { ...doc, logs };
    this.stored = {
      doc: mergedDoc,
      subLogs: new Map(subLogs.map((l) => [l.id, l])),
      legacyLogs: doc.logs,
      rawLegacyLogs: [...rawLegacyLogs],
      setAsideOk,
    };
    return mergedDoc;
  }

  private async ensureStoredForWrite(doc: ShopDocument, fs: FirestoreFns): Promise<boolean> {
    if (this.stored && this.stored.doc.updatedAt === doc.updatedAt) {
      return true;
    }
    this.stored = null;
    if (!doc.updatedAt) {
      return true;
    }
    const [snap, logDocs] = await Promise.all([fs.getDoc(fs.docRef), fs.getLogs()]);
    if (!snap.exists()) {
      return true;
    }
    const rawShop = snap.data();
    const current = coerceShopDocument(rawShop);
    const subLogs = current ? coerceSubcollectionLogs(logDocs, current.settings) : null;
    if (!current || !subLogs) {
      throw new Error("Could not load shop from Firestore.");
    }
    if (current.updatedAt !== doc.updatedAt) {
      return false; // CAS would fail
    }
    const rawLegacy = isRecord(rawShop) && Array.isArray(rawShop.logs) ? rawShop.logs : [];
    this.cacheStored(current, subLogs, rawLegacy);
    return true;
  }

  async putShop(doc: ShopDocument): Promise<ShopStoreResult<{ updatedAt: string }>> {
    try {
      const fs = await this.fs();
      const own = dedupeLogsById(doc.logs);
      const ownOk = setAsideDuplicateCopies(this.shopId, own.losers);
      const nextLogs = own.logs;

      const ready = await this.ensureStoredForWrite(doc, fs);
      if (!ready) throw new ShopWriteConflictError();

      // Creating a brand-new shop document (`expectedUpdatedAt === ""`): create `shops/{shopId}`
      // with `logs: []` first so `isMember(shopId)` passes when creating `shops/{shopId}/logs/{logId}`.
      if (!this.stored) {
        const unSavedLosers = ownOk ? [] : own.losers.filter((l) => !l.identical).map((l) => l.log);
        const updatedAt = await fs.putWithCas(doc.updatedAt, { ...doc, logs: unSavedLosers });
        for (const log of nextLogs) {
          await fs.putLog(log.id, log);
        }
        this.cacheStored({ ...doc, logs: unSavedLosers, updatedAt }, nextLogs, unSavedLosers);
        return { ok: true, value: { updatedAt } };
      }

      const stored = this.stored;
      const migration = planLegacyDrain(
        stored.subLogs,
        stored.legacyLogs,
        stored.rawLegacyLogs,
        nextLogs,
        stored.setAsideOk && ownOk,
      );

      let expected = doc.updatedAt;

      // Step A: write unmigrated legacy winners to `shops/{shopId}/logs/{logId}` while they
      // are still present in `shops/{shopId}.logs` (satisfies `canCreateLog` in firestore.rules).
      const liveSubLogs = new Map(stored.subLogs);
      for (const item of migration.winnersToCreate) {
        await fs.putLog(item.id, item.raw);
        liveSubLogs.set(item.id, item.log);
      }

      // Step B: drain removable entries from `shops/{shopId}.logs` in <= 8-entry batches.
      for (const batchLogs of migration.drainBatches) {
        expected = await fs.putWithCas(expected, { ...stored.doc, logs: batchLogs });
        this.cacheStored(
          { ...stored.doc, logs: batchLogs, updatedAt: expected },
          [...liveSubLogs.values()],
          batchLogs,
        );
      }

      // Step C: write new/updated logs and delete removed logs in `shops/{shopId}/logs/{logId}`.
      const nextById = new Map(nextLogs.map((l) => [l.id, l]));
      for (const log of nextLogs) {
        const prev = liveSubLogs.get(log.id);
        if (!prev || stableJson(prev) !== stableJson(log)) {
          await fs.putLog(log.id, log);
        }
      }
      for (const id of liveSubLogs.keys()) {
        if (!nextById.has(id)) {
          await fs.deleteLog(id);
        }
      }

      // Step D: commit the caller's shop document update (`logs` holds only any kept legacy losers).
      const updatedAt = await fs.putWithCas(expected, { ...doc, logs: migration.remainingLegacy });
      // The written state is cached for the next write (no re-read; #210 reuses it).
      this.cacheStored(
        { ...doc, logs: migration.remainingLegacy, updatedAt },
        nextLogs,
        migration.remainingLegacy,
      );
      return { ok: true, value: { updatedAt } };
    } catch (err) {
      this.stored = null;
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
