/**
 * Offline log outbox (#6) — durable localStorage queue for shared-mode log puts.
 * Local upsert remains source of truth on device; this retries cloud merge without retyping.
 * Full ApplicationLog payloads keep § 7.144(a) fields intact through queue → sync.
 */

import type { ApplicationLog } from "../types";
import { normalizeLog } from "../storage";
import type { RemoteShopStore } from "./RemoteShopStore";

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

export function loadLogOutbox(): LogOutboxEntry[] {
  try {
    const raw = localStorage.getItem(LOG_OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceEntry).filter((e): e is LogOutboxEntry => e !== null);
  } catch {
    return [];
  }
}

function writeOutbox(entries: LogOutboxEntry[]): boolean {
  try {
    localStorage.setItem(LOG_OUTBOX_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/** Upsert by shopId + log.id (latest payload wins). */
export function enqueueLogOutbox(
  shopId: string,
  log: ApplicationLog,
  lastError?: string,
): boolean {
  const id = shopId.trim();
  if (!id || !log.id) return false;
  const rest = loadLogOutbox().filter((e) => !(e.shopId === id && e.log.id === log.id));
  const entry: LogOutboxEntry = {
    shopId: id,
    queuedAt: new Date().toISOString(),
    entryId: newEntryId(),
    log,
  };
  if (lastError?.trim()) entry.lastError = lastError.trim();
  return writeOutbox([entry, ...rest]);
}

/** Remove only exact entryId versions (preserve newer re-queues). */
export function removeOutboxVersions(shopId: string, entryIds: string[]): boolean {
  const id = shopId.trim();
  const drop = new Set(entryIds.filter(Boolean));
  const next = loadLogOutbox().filter((e) => !(e.shopId === id && drop.has(e.entryId)));
  return writeOutbox(next);
}

/** @deprecated Prefer removeOutboxVersions so a newer queued payload is not wiped. */
export function removeOutboxLogIds(shopId: string, logIds: string[]): boolean {
  const id = shopId.trim();
  const drop = new Set(logIds);
  const next = loadLogOutbox().filter((e) => !(e.shopId === id && drop.has(e.log.id)));
  return writeOutbox(next);
}

export function outboxEntriesForShop(shopId: string): LogOutboxEntry[] {
  const id = shopId.trim();
  return loadLogOutbox().filter((e) => e.shopId === id);
}

/** Attach lastError without changing queuedAt or the stored payload. */
function annotateOutboxErrors(
  shopId: string,
  logIds: string[],
  lastError?: string,
): boolean {
  const id = shopId.trim();
  const msg = lastError?.trim();
  if (!msg) return true;
  const drop = new Set(logIds);
  const next = loadLogOutbox().map((e) =>
    e.shopId === id && drop.has(e.log.id) ? { ...e, lastError: msg } : e,
  );
  return writeOutbox(next);
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
      annotateOutboxErrors(
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

    let logs = [...got.value.logs];
    for (const entry of pending) {
      const idx = logs.findIndex((l) => l.id === entry.log.id);
      if (idx === -1) logs = [entry.log, ...logs];
      else logs[idx] = entry.log;
    }

    const put = await remote.putShop({ ...got.value, logs });
    if (!put.ok) {
      annotateOutboxErrors(
        id,
        pending.map((e) => e.log.id),
        put.error,
      );
      return {
        ok: false,
        flushed: 0,
        remaining: pending.length,
        error: put.error,
        conflict: put.conflict,
      };
    }

    removeOutboxVersions(
      id,
      pending.map((e) => e.entryId),
    );
    return { ok: true, flushed: pending.length, remaining: 0 };
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
  const queued = enqueueLogOutbox(id, log);
  const entryId = outboxEntriesForShop(id).find((e) => e.log.id === log.id)?.entryId;
  const clearThisVersion = () => {
    // If enqueue failed, do not fall back to log.id — that can wipe a newer re-queue.
    if (!entryId) return true;
    return removeOutboxVersions(id, [entryId]);
  };

  const got = await remote.getShop();
  if (!got.ok) {
    if (queued) annotateOutboxErrors(id, [log.id], got.error);
    return { ok: false, error: got.error, queued };
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
          clearThisVersion();
          return { ok: true };
        }
        if (queued) annotateOutboxErrors(id, [log.id], put2.error);
        return { ok: false, error: put2.error, queued };
      }
    }
    if (queued) annotateOutboxErrors(id, [log.id], put.error);
    return { ok: false, error: put.error, queued };
  }

  clearThisVersion();
  return { ok: true };
}
