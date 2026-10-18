/**
 * Offline log outbox (#6) — durable localStorage queue for shared-mode log puts.
 * Local upsert remains source of truth on device; this retries cloud merge without retyping.
 * Full ApplicationLog payloads keep § 7.144(a) fields intact through queue → sync.
 * Cross-tab writers take an exclusive Web Lock around the whole read-modify-write.
 * Enqueue returns the committed entryId so immediate sync cleans up only that version.
 * App keeps calling the async flush/sync entry points; the lock stays inside this module.
 */

import type { ApplicationLog } from "../types";
import { mergeLogIntoSet, normalizeLog } from "../storage";
import type { RemoteShopStore } from "./RemoteShopStore";
import type { ShopDocument } from "./types";
import { isSessionAuthenticated, loadShopSession } from "./session";

export const LOG_OUTBOX_KEY = "jobber-pest-logger:log-outbox:v1";

/**
 * Shown (as the entry's lastError / sync error) when the shop already has a copy of
 * this log that is ahead, has a split change history, or is reviewed while this
 * device's copy is not. The remote copy is kept; this device's copy stays queued.
 */
export const REMOTE_COPY_KEPT_ERROR =
  "Sync conflict: the shop's copy of this log has changes or a review this device's copy doesn't, so this device's copy was not uploaded. It stays saved here.";

export interface LogOutboxEntry {
  shopId: string;
  queuedAt: string;
  /** Stable per-enqueue id for versioned remove (queuedAt stays a timestamp only). */
  entryId: string;
  /** Full application log — do not strip fields. */
  log: ApplicationLog;
  lastError?: string;
}

function newEntryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate persisted outbox rows; reject garbage before remote merge. */
function coerceEntry(raw: unknown): LogOutboxEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.shopId !== "string" || !raw.shopId.trim()) return null;
  if (typeof raw.queuedAt !== "string" || !raw.queuedAt.trim()) return null;
  const log = normalizeLog(raw.log);
  if (!log) return null;
  const queuedAt = raw.queuedAt.trim();
  const entryId =
    typeof raw.entryId === "string" && raw.entryId.trim()
      ? raw.entryId.trim()
      : `legacy:${queuedAt}`;
  const entry: LogOutboxEntry = {
    shopId: raw.shopId.trim(),
    queuedAt,
    entryId,
    log,
  };
  if (typeof raw.lastError === "string" && raw.lastError.trim()) {
    entry.lastError = raw.lastError.trim();
  }
  return entry;
}

function parseOutboxRaw(raw: string | null): LogOutboxEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceEntry).filter((e): e is LogOutboxEntry => e !== null);
  } catch {
    return [];
  }
}

export function loadLogOutbox(): LogOutboxEntry[] {
  try {
    return parseOutboxRaw(localStorage.getItem(LOG_OUTBOX_KEY));
  } catch {
    return [];
  }
}

/**
 * Bounded retries for a writer that mutates storage without this lock.
 * Not the cross-tab atomicity mechanism — see `withOutboxLock`.
 */
const OUTBOX_CAS_ATTEMPTS = 8;

/**
 * Web Locks name (not a localStorage key). One exclusive holder per origin.
 */
export const OUTBOX_LOCK_NAME = "jobber-pest-logger:log-outbox:v1";

/**
 * Give up if another tab still holds the outbox lock. Fail closed: no write.
 * Long enough for a localStorage read-modify-write, short enough to not hang a save.
 */
export const OUTBOX_LOCK_WAIT_MS = 2_000;

function readOutboxRaw(): string | null | undefined {
  try {
    return localStorage.getItem(LOG_OUTBOX_KEY);
  } catch {
    return undefined;
  }
}

/**
 * In-process queue used only when `navigator.locks` is missing (node tests,
 * engines from before 2022). Serializes this agent; it does not exclude other tabs.
 */
let fallbackTail: Promise<void> = Promise.resolve();

/**
 * Run `body` while no other outbox writer in this origin can.
 *
 * localStorage setItem is atomic for one key, but the HTML spec does not lock
 * a read-modify-write across tabs. A confirming read can match and another tab
 * can still commit before setItem; a retry never sees that interleaving.
 * `navigator.locks` mode "exclusive" holds the lock from before the snapshot
 * read until setItem returns, so a cooperating tab cannot enter that window.
 *
 * The wait is bounded. If the lock is not granted, request rejects and
 * updateOutbox fails closed (no unlocked setItem).
 */
async function withOutboxLock<T>(body: () => T): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== "function") {
    const previous = fallbackTail;
    let release!: () => void;
    fallbackTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() => {
      try {
        return body();
      } finally {
        release();
      }
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOX_LOCK_WAIT_MS);
  try {
    return await locks.request(OUTBOX_LOCK_NAME, { mode: "exclusive", signal: controller.signal }, () => {
      // Granted. Aborting a held lock does not release it; don't time out the critical section.
      clearTimeout(timer);
      return body();
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read-modify-write under the cross-tab lock.
 * Quota (setItem throw) returns false, same as before.
 * `mutator` must be safe to run more than once (bypass retries).
 * Returns false when the lock is not acquired — storage is left unchanged.
 */
async function updateOutbox(
  mutator: (entries: LogOutboxEntry[]) => LogOutboxEntry[],
): Promise<boolean> {
  let entered = false;
  try {
    return await withOutboxLock(() => {
      entered = true;
      for (let attempt = 0; attempt < OUTBOX_CAS_ATTEMPTS; attempt++) {
        const snapshot = readOutboxRaw();
        if (snapshot === undefined) continue;
        const next = mutator(parseOutboxRaw(snapshot));
        const current = readOutboxRaw();
        if (current === undefined || current !== snapshot) continue;
        try {
          localStorage.setItem(LOG_OUTBOX_KEY, JSON.stringify(next));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    });
  } catch (err) {
    // Lock never granted (timeout, abort, or request rejection). Do not write
    // without the lock — that would reopen the confirm-read-to-setItem race.
    // A throw from the critical section itself still surfaces.
    if (!entered) return false;
    throw err;
  }
}

/**
 * Upsert by shopId + log.id (latest payload wins).
 * On success returns the committed entryId (use for supersession + cleanup).
 * On failure returns null — callers must not look up by log.id for cleanup,
 * or they may claim a concurrent replacement's retry path.
 */
export async function enqueueLogOutbox(
  shopId: string,
  log: ApplicationLog,
  lastError?: string,
): Promise<string | null> {
  const id = shopId.trim();
  if (!id || !log.id) return null;
  let committedId: string | null = null;
  const ok = await updateOutbox((entries) => {
    const rest = entries.filter((e) => !(e.shopId === id && e.log.id === log.id));
    const entryId = newEntryId();
    const entry: LogOutboxEntry = {
      shopId: id,
      queuedAt: new Date().toISOString(),
      entryId,
      log,
    };
    if (lastError?.trim()) entry.lastError = lastError.trim();
    committedId = entryId;
    return [entry, ...rest];
  });
  return ok ? committedId : null;
}

/** Remove only exact entryId versions (preserve newer re-queues).
 * When logId is set, also require e.log.id === logId so a shared legacy
 * entryId (legacy:queuedAt) cannot drop another log's retry entry.
 */
export async function removeOutboxVersions(
  shopId: string,
  entryIds: string[],
  logId?: string,
): Promise<boolean> {
  const id = shopId.trim();
  const drop = new Set(entryIds.filter(Boolean));
  return updateOutbox((entries) =>
    entries.filter(
      (e) =>
        !(
          e.shopId === id &&
          drop.has(e.entryId) &&
          (logId === undefined || e.log.id === logId)
        ),
    ),
  );
}

/** @deprecated Prefer removeOutboxVersions so a newer queued payload is not wiped. */
export async function removeOutboxLogIds(shopId: string, logIds: string[]): Promise<boolean> {
  const id = shopId.trim();
  const drop = new Set(logIds);
  return updateOutbox((entries) =>
    entries.filter((e) => !(e.shopId === id && drop.has(e.log.id))),
  );
}

export function outboxEntriesForShop(shopId: string): LogOutboxEntry[] {
  const id = shopId.trim();
  return loadLogOutbox().filter((e) => e.shopId === id);
}

/** Attach lastError without changing queuedAt or the stored payload. */
async function annotateOutboxErrors(
  shopId: string,
  logIds: string[],
  lastError?: string,
): Promise<boolean> {
  const id = shopId.trim();
  const msg = lastError?.trim();
  if (!msg) return true;
  const drop = new Set(logIds);
  return updateOutbox((entries) =>
    entries.map((e) => (e.shopId === id && drop.has(e.log.id) ? { ...e, lastError: msg } : e)),
  );
}

/** Session may expire or switch shops while a remote call awaits. */
const SESSION_CHANGED_ERROR = "Session expired or shop changed — unlock to sync queued logs.";
const OUTBOX_CLEAR_FAILED_ERROR = "Synced to shop but could not update the local outbox.";

function isLiveEntry(shopId: string, entryId: string): boolean {
  return outboxEntriesForShop(shopId).some((e) => e.entryId === entryId);
}

/**
 * Merge pending outbox logs into remote shop.logs by id (idempotent), ONE LOG PER WRITE.
 *
 * Each queued log is its own putShop, so a write only ever changes one log. That keeps
 * every write far under the Firestore rules' per-request expression limit (#208), so a
 * large offline backlog drains in many small writes instead of one write the rules
 * refuse. Entries go oldest-first, so new logs end up newest-first on the remote (same
 * order as upsertLog / syncLogToRemote). The last committed doc is reused as the base
 * for the next write (CAS on its updatedAt); a CAS conflict re-reads once, as before.
 *
 * A refused entry never blocks the ones behind it:
 * - remote copy kept (ahead / split / reviewed): annotated REMOTE_COPY_KEPT_ERROR and left
 *   queued for the conflict screen (#166/#167); the flush moves on.
 * - a put the shop refuses (e.g. rules) or a second CAS conflict: that entry is
 *   annotated with the error and left queued; the flush moves on.
 * Stops (nothing more is put) when the shop can't be read, the session expired or
 * switched shops, or the local outbox can't be updated after a successful put.
 * Entries queued during the flush are left for the next one, except that a CAS
 * conflict re-reads the queue (so a payload queued meanwhile joins this flush).
 */
export async function flushLogOutbox(
  remote: RemoteShopStore,
  shopId: string,
): Promise<{
  ok: boolean;
  flushed: number;
  remaining: number;
  error?: string;
  conflict?: boolean;
}> {
  const id = shopId.trim();
  if (outboxEntriesForShop(id).length === 0) {
    return { ok: true, flushed: 0, remaining: 0 };
  }

  // Outbox is newest-first; push oldest-first.
  const work: LogOutboxEntry[] = [...outboxEntriesForShop(id)].reverse();
  const seen = new Set(work.map((e) => e.entryId));
  let base: ShopDocument | null = null;
  let flushed = 0;
  let refused = 0;
  let superseded = 0;
  let putError: string | undefined;
  let putConflict: boolean | undefined;

  const stop = (error: string) => ({
    ok: false,
    flushed,
    remaining: outboxEntriesForShop(id).length,
    error,
  });

  /** Read the shop; on failure annotate every entry still waiting in `work`. */
  const read = async (from: number): Promise<ShopDocument | { error: string }> => {
    const got = await remote.getShop();
    if (got.ok) return got.value;
    await annotateOutboxErrors(
      id,
      work.slice(from).map((e) => e.log.id),
      got.error,
    );
    return { error: got.error };
  };

  /** Pull in entries queued since the flush started (used after a CAS conflict). */
  const addNewlyQueued = () => {
    for (const e of [...outboxEntriesForShop(id)].reverse()) {
      if (!seen.has(e.entryId)) {
        seen.add(e.entryId);
        work.push(e);
      }
    }
  };

  for (let i = 0; i < work.length; i++) {
    const entry = work[i];
    let conflictRetried = false;
    for (;;) {
      // Superseded (or removed) while a remote call awaited: the newer version stays queued.
      if (!isLiveEntry(id, entry.entryId)) {
        superseded += 1;
        break;
      }
      if (!base) {
        const doc = await read(i);
        if ("error" in doc) return stop(doc.error);
        base = doc;
        if (!isLiveEntry(id, entry.entryId)) {
          superseded += 1;
          break;
        }
      }

      const merged = mergeLogIntoSet(base.logs, entry.log);
      if (merged.kept) {
        // Remote copy kept: flag it for the conflict screen; don't block the rest.
        await annotateOutboxErrors(id, [entry.log.id], REMOTE_COPY_KEPT_ERROR);
        refused += 1;
        break;
      }

      const session = loadShopSession();
      if (!isSessionAuthenticated(session) || session.shopId.trim() !== id) {
        return stop(SESSION_CHANGED_ERROR);
      }

      const nextDoc: ShopDocument = { ...base, logs: merged.logs };
      const put = await remote.putShop(nextDoc);
      if (put.ok) {
        base = { ...nextDoc, updatedAt: put.value.updatedAt };
        flushed += 1;
        if (!(await removeOutboxVersions(id, [entry.entryId]))) {
          return stop(OUTBOX_CLEAR_FAILED_ERROR);
        }
        break;
      }
      if (put.conflict && !conflictRetried) {
        // One conflict retry with a fresh read (and anything queued meanwhile).
        conflictRetried = true;
        base = null;
        addNewlyQueued();
        continue;
      }
      // Refused or still conflicting: keep this entry queued with its error; move on.
      await annotateOutboxErrors(id, [entry.log.id], put.error);
      putError = put.error;
      putConflict = put.conflict;
      if (put.conflict) base = null;
      break;
    }
  }

  // Every entry was superseded or cleared elsewhere: nothing of ours is left to report.
  if (superseded === work.length) return { ok: true, flushed: 0, remaining: 0 };
  const remaining = outboxEntriesForShop(id).length;
  if (putError !== undefined) {
    return { ok: false, flushed, remaining, error: putError, conflict: putConflict };
  }
  if (refused > 0) {
    return { ok: false, flushed, remaining, error: REMOTE_COPY_KEPT_ERROR };
  }
  return { ok: true, flushed, remaining };
}

/**
 * Try to push one log to remote immediately; enqueue on failure.
 * Local device save is the caller's responsibility (already done).
 */
export async function syncLogToRemote(
  remote: RemoteShopStore,
  shopId: string,
  log: ApplicationLog,
): Promise<{ ok: true } | { ok: false; error: string; queued: boolean }> {
  const id = shopId.trim();
  // Queue before the network round-trip so a discarded tab cannot lose the cloud copy.
  // Remember the id already queued for this log, then carry enqueue's committed id.
  // Never re-look up by shop+log.id after an await — another tab may have replaced it.
  const priorEntryId = outboxEntriesForShop(id).find((entry) => entry.log.id === log.id)?.entryId;
  const entryId = await enqueueLogOutbox(id, log);
  const queued = entryId !== null;
  const clearThisVersion = () => {
    // Success: drop the id enqueue just committed. Null enqueue: drop only the id
    // captured before the call, so a stale older payload cannot flush over a fresher
    // remote log. A concurrent replacement has a different entryId and stays queued.
    // Pass log.id on the null-enqueue path so a shared legacy:queuedAt id cannot
    // wipe another log's retry entry.
    const idToClear = entryId ?? priorEntryId;
    if (!idToClear) return true;
    return removeOutboxVersions(id, [idToClear], entryId === null ? log.id : undefined);
  };

  const got = await remote.getShop();
  if (!got.ok) {
    if (queued) await annotateOutboxErrors(id, [log.id], got.error);
    return { ok: false, error: got.error, queued };
  }

  // Newer save may have superseded this attempt while getShop awaited.
  const isCurrentBeforePut =
    !!entryId && outboxEntriesForShop(id).some((entry) => entry.entryId === entryId);
  if (queued && !isCurrentBeforePut) {
    return { ok: true };
  }

  // Remote copy ahead / split / reviewed: keep it, leave this version queued.
  const refuse = async () => {
    if (queued) await annotateOutboxErrors(id, [log.id], REMOTE_COPY_KEPT_ERROR);
    return { ok: false as const, error: REMOTE_COPY_KEPT_ERROR, queued };
  };

  const first = mergeLogIntoSet(got.value.logs, log);
  if (first.kept) return refuse();
  const logs = first.logs;

  const put = await remote.putShop({ ...got.value, logs });
  if (!put.ok) {
    if (put.conflict) {
      // One conflict retry.
      const again = await remote.getShop();
      if (again.ok) {
        // Newer save for same log.id may have superseded this attempt's outbox entry.
        const isCurrent =
          !!entryId &&
          outboxEntriesForShop(id).some((entry) => entry.entryId === entryId);
        if (queued && !isCurrent) {
          return { ok: true };
        }
        const second = mergeLogIntoSet(again.value.logs, log);
        if (second.kept) return refuse();
        const logs2 = second.logs;
        const put2 = await remote.putShop({ ...again.value, logs: logs2 });
        if (put2.ok) {
          if (!(await clearThisVersion())) {
            return {
              ok: false,
              error: "Synced to shop but could not update the local outbox.",
              queued: true,
            };
          }
          return { ok: true };
        }
        if (queued) await annotateOutboxErrors(id, [log.id], put2.error);
        return { ok: false, error: put2.error, queued };
      }
    }
    if (queued) await annotateOutboxErrors(id, [log.id], put.error);
    return { ok: false, error: put.error, queued };
  }

  if (!(await clearThisVersion())) {
    return {
      ok: false,
      error: "Synced to shop but could not update the local outbox.",
      queued: true,
    };
  }
  return { ok: true };
}
