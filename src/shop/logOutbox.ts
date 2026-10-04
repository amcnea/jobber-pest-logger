/**
 * Offline log outbox (#6) — durable localStorage queue for shared-mode log puts.
 * Local upsert remains source of truth on device; this retries cloud merge without retyping.
 * Full ApplicationLog payloads keep § 7.144(a) fields intact through queue → sync.
 * Cross-tab writers take an exclusive Web Lock around the whole read-modify-write.
 * Enqueue returns the committed entryId so immediate sync cleans up only that version.
 * App keeps calling the async flush/sync entry points; the lock stays inside this module.
 */

import type { ApplicationLog } from "../types";
import { normalizeLog } from "../storage";
import type { RemoteShopStore } from "./RemoteShopStore";
import { isSessionAuthenticated, loadShopSession } from "./session";

export const LOG_OUTBOX_KEY = "jobber-pest-logger:log-outbox:v1";

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

/** Remove only exact entryId versions (preserve newer re-queues). */
export async function removeOutboxVersions(shopId: string, entryIds: string[]): Promise<boolean> {
  const id = shopId.trim();
  const drop = new Set(entryIds.filter(Boolean));
  return updateOutbox((entries) =>
    entries.filter((e) => !(e.shopId === id && drop.has(e.entryId))),
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

/**
 * Merge pending outbox logs into remote shop.logs by id (idempotent).
 * One CAS conflict retry. Leaves remaining entries in outbox on failure.
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

  const attempt = async (): Promise<{
    ok: boolean;
    flushed: number;
    remaining: number;
    error?: string;
    conflict?: boolean;
  }> => {
    // Re-read each attempt so a payload queued during the previous await is included.
    const pending = outboxEntriesForShop(id);
    if (pending.length === 0) return { ok: true, flushed: 0, remaining: 0 };

    const got = await remote.getShop();
    if (!got.ok) {
      await annotateOutboxErrors(
        id,
        pending.map((e) => e.log.id),
        got.error,
      );
      return {
        ok: false,
        flushed: 0,
        remaining: pending.length,
        error: got.error,
      };
    }

    // Drop entries superseded while getShop awaited.
    const currentIds = new Set(outboxEntriesForShop(id).map((e) => e.entryId));
    const live = pending.filter((e) => currentIds.has(e.entryId));
    if (live.length === 0) {
      return { ok: true, flushed: 0, remaining: 0 };
    }

    let logs = [...got.value.logs];
    // Outbox is newest-first; merge oldest-first so prepended new logs end up
    // newest-first on the remote (same order as upsertLog / syncLogToRemote).
    for (const entry of [...live].reverse()) {
      const idx = logs.findIndex((l) => l.id === entry.log.id);
      if (idx === -1) logs = [entry.log, ...logs];
      else logs[idx] = entry.log;
    }

    // Session may expire or switch shops while getShop awaited — do not put or clear outbox.
    const session = loadShopSession();
    if (!isSessionAuthenticated(session) || session.shopId.trim() !== id) {
      return {
        ok: false,
        flushed: 0,
        remaining: live.length,
        error: "Session expired or shop changed — unlock to sync queued logs.",
      };
    }

    const put = await remote.putShop({ ...got.value, logs });
    if (!put.ok) {
      await annotateOutboxErrors(
        id,
        live.map((e) => e.log.id),
        put.error,
      );
      return {
        ok: false,
        flushed: 0,
        remaining: live.length,
        error: put.error,
        conflict: put.conflict,
      };
    }

    const cleared = await removeOutboxVersions(
      id,
      live.map((e) => e.entryId),
    );
    const remaining = outboxEntriesForShop(id).length;
    if (!cleared) {
      return {
        ok: false,
        flushed: live.length,
        remaining,
        error: "Synced to shop but could not update the local outbox.",
      };
    }
    return { ok: true, flushed: live.length, remaining };
  };

  const first = await attempt();
  if (first.ok || !first.conflict) return first;
  // One conflict retry with a fresh read (and fresh pending/queuedAt).
  return attempt();
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
  // Carry the committed entryId from enqueue — never re-look up by shop+log.id after
  // an await (another tab may have replaced this log with a newer entryId).
  const entryId = await enqueueLogOutbox(id, log);
  const queued = entryId !== null;
  const clearThisVersion = () => {
    // Failed enqueue must not claim cleanup of an existing matching entry.
    if (!entryId) return true;
    return removeOutboxVersions(id, [entryId]);
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

  const logs = [...got.value.logs];
  const idx = logs.findIndex((l) => l.id === log.id);
  if (idx === -1) logs.unshift(log);
  else logs[idx] = log;

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
        const logs2 = [...again.value.logs];
        const i2 = logs2.findIndex((l) => l.id === log.id);
        if (i2 === -1) logs2.unshift(log);
        else logs2[i2] = log;
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
