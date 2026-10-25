/**
 * RemoteShopStore — Firestore shops/{shopId} + per-log subcollection shops/{shopId}/logs/{logId} (#215).
 * Only constructed when Firebase env is configured AND a shop session id exists.
 * Firebase SDK is lazy-imported so local-only builds do not need a project at runtime.
 * #5: every remote op signs in anonymously first so rules can check request.auth.uid.
 */

import { parseShopSections } from "../storage";
import type { ApplicationLog } from "../types";
import {
  canUpdateSubcollectionLog,
  dedupeLogsById,
  planLegacyDrain,
  setAsideDuplicateCopies,
  stableJson,
} from "./dedupeLogs";
import { ensureAnonymousAuth } from "./firebaseAuth";
import { getFirebaseApp } from "./firebaseApp";
import type { FirebaseClientConfig } from "./firebaseConfig";
import { isShopRole, parseShopPinAuth } from "./pinCrypto";
import { recordReviewedCopyConflicts } from "./reviewedCopies";
import { isValidShopId } from "./session";
import type { ShopDocument, ShopMembers, ShopStore, ShopStoreResult } from "./types";

const SHOPS_COLLECTION = "shops";
const LOGS_SUBCOLLECTION = "logs";

/**
 * Firestore allows at most 500 writes per transaction; reserve 1 write for `shops/{shopId}`
 * so each CAS transaction carries up to 499 per-log writes/deletes.
 */
export const MAX_LOG_WRITES_PER_TX = 499;

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
  getLogs: () => Promise<FirestoreLogDoc[]>;
  /**
   * CAS commit: fails with ShopWriteConflictError if the remote doc's updatedAt
   * differs from expectedUpdatedAt (caller's snapshot). Atomically writes changed
   * `shops/{shopId}/logs/{logId}` docs, deletes removed log docs, and stamps a fresh
   * updatedAt on `shops/{shopId}` inside `runTransaction` (chunked at 499 log writes +
   * 1 shop write when the change set exceeds Firestore's 500-write transaction limit).
   * When expectedUpdatedAt is "" and the doc is missing, create is allowed.
   */
  commitWithCas: (
    expectedUpdatedAt: string,
    payload: ShopDocument,
    puts?: readonly { id: string; data: unknown }[],
    deletes?: readonly string[],
  ) => Promise<string>;
  putLegacyScanCursor?: (scan: {
    logId: string;
    allowUnreviewed: boolean;
    start: number;
    cursor: number;
    shopUpdatedAt: string;
    legacySize: number;
  }) => Promise<void>;
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

function snapStamp(snap: FirestoreSnap): unknown {
  if (!snap.exists()) return null;
  const data = snap.data();
  return isRecord(data) ? data.updatedAt : undefined;
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
    runTransaction,
  } = await import("firebase/firestore");

  const db = getFirestore(app);
  const docRef = doc(db, SHOPS_COLLECTION, shopId);
  const logsColRef = collection(db, SHOPS_COLLECTION, shopId, LOGS_SUBCOLLECTION);
  const legacyScanRef = doc(db, SHOPS_COLLECTION, shopId, "legacyScan", "cursor");
  return {
    docRef,
    putLegacyScanCursor: async (scan) => {
      await setDoc(legacyScanRef, scan);
    },
    getDoc: getDoc as FirestoreFns["getDoc"],
    getLogs: async () => {
      const snap = await getDocs(logsColRef);
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    },
    commitWithCas: async (expectedUpdatedAt, payload, puts = [], deletes = []) => {
      type LogTxOp =
        | { kind: "put"; ref: ReturnType<typeof doc>; data: unknown }
        | { kind: "delete"; ref: ReturnType<typeof doc> };
      const ops: LogTxOp[] = [];
      for (const item of puts) {
        if (!isValidShopId(item.id)) {
          throw new Error(
            'Cannot build shops/{shopId}/logs/{logId} path: logId must be non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 UTF-8 bytes',
          );
        }
        ops.push({
          kind: "put",
          ref: doc(db, SHOPS_COLLECTION, shopId, LOGS_SUBCOLLECTION, item.id),
          data: cleanFirestoreValue(item.data),
        });
      }
      for (const logId of deletes) {
        if (!isValidShopId(logId)) {
          throw new Error(
            'Cannot build shops/{shopId}/logs/{logId} path: logId must be non-empty, no "/", not ".", "..", or reserved __.*__, ≤1500 UTF-8 bytes',
          );
        }
        ops.push({
          kind: "delete",
          ref: doc(db, SHOPS_COLLECTION, shopId, LOGS_SUBCOLLECTION, logId),
        });
      }

      const chunks: LogTxOp[][] = [];
      for (let i = 0; i < ops.length; i += MAX_LOG_WRITES_PER_TX) {
        chunks.push(ops.slice(i, i + MAX_LOG_WRITES_PER_TX));
      }
      if (chunks.length === 0) {
        chunks.push([]);
      }

      let currentExpected = expectedUpdatedAt;
      let committedUpdatedAt = "";
      const basePayload = firestorePayload(payload);
      for (const chunk of chunks) {
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(docRef);
          if (snap.exists()) {
            const data = snap.data() as Record<string, unknown> | undefined;
            const remoteUpdatedAt =
              data && typeof data.updatedAt === "string" ? data.updatedAt : "";
            if (remoteUpdatedAt !== currentExpected) {
              throw new ShopWriteConflictError();
            }
          }
          for (const op of chunk) {
            if (op.kind === "put") {
              transaction.set(op.ref, op.data);
            } else {
              transaction.delete(op.ref);
            }
          }
          committedUpdatedAt = new Date().toISOString();
          transaction.set(docRef, {
            ...basePayload,
            updatedAt: committedUpdatedAt,
          });
        });
        currentExpected = committedUpdatedAt;
      }
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
      const snap = await fs.getDoc(fs.docRef);
      const logDocs = await fs.getLogs();
      const recheck = await fs.getDoc(fs.docRef);
      if (snapStamp(snap) !== snapStamp(recheck)) {
        return {
          ok: false,
          error: "Shop was updated elsewhere; reload and try again.",
          conflict: true,
        };
      }
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
    const normalizedLegacy =
      rawLegacyLogs.length === 0
        ? []
        : (coerceSubcollectionLogs(
            rawLegacyLogs.map((data) => ({
              id: isRecord(data) && typeof data.id === "string" ? data.id : "",
              data,
            })),
            doc.settings,
          ) ?? doc.logs);
    const allLogs = [...subLogs, ...normalizedLegacy];
    const { logs, losers } = dedupeLogsById(allLogs);
    const setAsideOk = setAsideDuplicateCopies(this.shopId, losers);
    recordReviewedCopyConflicts(this.shopId, allLogs); // #212 office note
    const mergedDoc: ShopDocument = { ...doc, logs };
    this.stored = {
      doc: mergedDoc,
      subLogs: new Map(subLogs.map((l) => [l.id, l])),
      legacyLogs: normalizedLegacy,
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
    const snap = await fs.getDoc(fs.docRef);
    const logDocs = await fs.getLogs();
    const recheck = await fs.getDoc(fs.docRef);
    if (snapStamp(snap) !== snapStamp(recheck)) {
      return false;
    }
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
        let updatedAt = await fs.commitWithCas(doc.updatedAt, { ...doc, logs: unSavedLosers });
        if (nextLogs.length > 0) {
          updatedAt = await fs.commitWithCas(
            updatedAt,
            { ...doc, logs: unSavedLosers },
            nextLogs.map((log) => ({ id: log.id, data: log })),
          );
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
      const advanceLegacyScanIfNeeded = async (
        legacyArr: readonly unknown[],
        logId: string,
        allowUnreviewed: boolean,
      ): Promise<void> => {
        if (legacyArr.length <= 48 || !fs.putLegacyScanCursor) return;
        for (let start = 0; start < legacyArr.length; start += 48) {
          await fs.putLegacyScanCursor({
            logId,
            allowUnreviewed,
            start,
            cursor: start + 48,
            shopUpdatedAt: expected,
            legacySize: legacyArr.length,
          });
        }
      };

      // Step A: write unmigrated legacy winners to `shops/{shopId}/logs/{logId}` while they
      // are still present in `shops/{shopId}.logs` (satisfies `canCreateLog` in firestore.rules),
      // inside a CAS transaction so a stale cache never overwrites remote subcollection logs.
      const liveSubLogs = new Map(stored.subLogs);
      if (migration.winnersToCreate.length > 0) {
        const needsScan =
          stored.rawLegacyLogs.length > 48 &&
          migration.winnersToCreate.some(
            (item) => !liveSubLogs.has(item.id) && !item.log.reviewedAt,
          );
        if (!needsScan) {
          expected = await fs.commitWithCas(
            expected,
            { ...stored.doc, logs: stored.rawLegacyLogs as ApplicationLog[] },
            migration.winnersToCreate.map((item) => ({ id: item.id, data: item.raw })),
          );
          for (const item of migration.winnersToCreate) {
            liveSubLogs.set(item.id, item.log);
          }
        } else {
          const directItems = migration.winnersToCreate.filter(
            (item) => liveSubLogs.has(item.id) || Boolean(item.log.reviewedAt),
          );
          if (directItems.length > 0) {
            expected = await fs.commitWithCas(
              expected,
              { ...stored.doc, logs: stored.rawLegacyLogs as ApplicationLog[] },
              directItems.map((item) => ({ id: item.id, data: item.raw })),
            );
            for (const item of directItems) {
              liveSubLogs.set(item.id, item.log);
            }
          }
          const scanItems = migration.winnersToCreate
            .filter((item) => !liveSubLogs.has(item.id) && !item.log.reviewedAt)
            .slice(0, 8);
          for (const item of scanItems) {
            await advanceLegacyScanIfNeeded(stored.rawLegacyLogs, item.id, true);
            expected = await fs.commitWithCas(
              expected,
              { ...stored.doc, logs: stored.rawLegacyLogs as ApplicationLog[] },
              [{ id: item.id, data: item.raw }],
            );
            liveSubLogs.set(item.id, item.log);
          }
        }
      }

      // Step B: drain removable entries from `shops/{shopId}.logs` in <= 8-entry batches.
      for (const batchLogs of migration.drainBatches) {
        expected = await fs.commitWithCas(expected, { ...stored.doc, logs: batchLogs });
        this.cacheStored(
          { ...stored.doc, logs: batchLogs, updatedAt: expected },
          [...liveSubLogs.values()],
          batchLogs,
        );
      }

      // Step C + D: atomically verify `updatedAt`, write changed logs, delete removed logs,
      // and update `shops/{shopId}` inside the CAS transaction.
      const nextById = new Map(nextLogs.map((l) => [l.id, l]));
      const deferredLegacyIds = new Set(migration.remainingLegacy.map((l) => l.id));
      const storedById = new Map(stored.doc.logs.map((l) => [l.id, l]));
      const droppedEdit = nextLogs.find(
        (log) =>
          !liveSubLogs.has(log.id) &&
          deferredLegacyIds.has(log.id) &&
          stableJson(storedById.get(log.id)) !== stableJson(log),
      );
      if (droppedEdit) {
        return {
          ok: false,
          error: `Log ${droppedEdit.id} is still being migrated; try again.`,
        };
      }
      const changed = nextLogs.filter((log) => {
        const prev = liveSubLogs.get(log.id);
        if (!prev) {
          return !deferredLegacyIds.has(log.id);
        }
        if (stableJson(prev) === stableJson(log)) {
          return false;
        }
        // If this ID has a blocked legacy winner that was already present in stored.doc.logs
        // and the caller did not edit it, keep the existing subcollection doc untouched.
        if (migration.blockedWinnerIds.has(log.id)) {
          const storedMerged = stored.doc.logs.find((l) => l.id === log.id);
          if (storedMerged && stableJson(storedMerged) === stableJson(log)) {
            return false;
          }
        }
        return true;
      });
      const refused = changed.find((log) => {
        const prev = liveSubLogs.get(log.id);
        return prev && !canUpdateSubcollectionLog(prev, log);
      });
      if (refused) {
        throw new Error(`Log ${refused.id} can't be changed this way (review lock / retention hold).`);
      }
      const puts = changed.map((log) => ({ id: log.id, data: log }));
      const deletes = [...liveSubLogs.keys()].filter((id) => !nextById.has(id));

      if (migration.remainingLegacy.length > 48) {
        for (const p of puts) {
          if (!liveSubLogs.has(p.id)) {
            await advanceLegacyScanIfNeeded(migration.remainingLegacy, p.id, false);
            expected = await fs.commitWithCas(
              expected,
              { ...doc, logs: migration.remainingLegacy },
              [p],
            );
            liveSubLogs.set(p.id, p.data);
          }
        }
      }
      const remainingPuts = puts.filter((p) => {
        const prev = liveSubLogs.get(p.id);
        return !prev || stableJson(prev) !== stableJson(p.data);
      });

      const updatedAt = await fs.commitWithCas(
        expected,
        { ...doc, logs: migration.remainingLegacy },
        remainingPuts,
        deletes,
      );
      const writtenSubLogs = new Map(liveSubLogs);
      for (const p of remainingPuts) writtenSubLogs.set(p.id, p.data);
      for (const id of deletes) writtenSubLogs.delete(id);
      // The written state is cached for the next write (no re-read; #210 reuses it).
      this.cacheStored(
        { ...doc, logs: migration.remainingLegacy, updatedAt },
        [...writtenSubLogs.values()],
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
