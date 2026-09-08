/**
 * Offline log outbox (#6) — durable localStorage queue for shared-mode log puts.
 * Local upsert remains source of truth on device; this retries cloud merge without retyping.
 * Full ApplicationLog payloads keep § 7.144(a) fields intact through queue → sync.
 */

import type { ApplicationLog } from "../types";
import type { RemoteShopStore } from "./RemoteShopStore";

export const LOG_OUTBOX_KEY = "jobber-pest-logger:log-outbox:v1";

export interface LogOutboxEntry {
  shopId: string;
  queuedAt: string;
  /** Full application log — do not strip fields. */
  log: ApplicationLog;
  lastError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Light shape check: we wrote these; reject garbage without reimplementing normalizeLog. */
function coerceEntry(raw: unknown): LogOutboxEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.shopId !== "string" || !raw.shopId.trim()) return null;
  if (typeof raw.queuedAt !== "string" || !raw.queuedAt.trim()) return null;
  if (!isRecord(raw.log) || typeof raw.log.id !== "string" || !raw.log.id.trim()) return null;
  const entry: LogOutboxEntry = {
    shopId: raw.shopId.trim(),
    queuedAt: raw.queuedAt.trim(),
    log: raw.log as unknown as ApplicationLog,
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
  } catch (err) {
    console.error("jobber-pest-logger: could not save log outbox", err);
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
    log,
  };
  if (lastError?.trim()) entry.lastError = lastError.trim();
  return writeOutbox([entry, ...rest]);
}

/** Remove only exact shopId + log.id + queuedAt versions (preserve newer re-queues). */
export function removeOutboxVersions(
  shopId: string,
  versions: Array<{ logId: string; queuedAt: string }>,
): boolean {
  const id = shopId.trim();
  const drop = new Set(versions.map((v) => `${v.logId}\0${v.queuedAt}`));
  const next = loadLogOutbox().filter(
    (e) => !(e.shopId === id && drop.has(`${e.log.id}\0${e.queuedAt}`)),
  );
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
  const pending = outboxEntriesForShop(id);
  if (pending.length === 0) {
    return { ok: true, flushed: 0, remaining: 0 };
  }

  const attempt = async (): Promise<{
    ok: boolean;
    flushed: number;
    remaining: number;
    error?: string;
    conflict?: boolean;
  }> => {
    const got = await remote.getShop();
    if (!got.ok) {
      for (const e of pending) {
        enqueueLogOutbox(id, e.log, got.error);
      }
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
      for (const e of pending) {
        enqueueLogOutbox(id, e.log, put.error);
      }
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
      pending.map((e) => ({ logId: e.log.id, queuedAt: e.queuedAt })),
    );
    return { ok: true, flushed: pending.length, remaining: 0 };
  };

  const first = await attempt();
  if (first.ok || !first.conflict) return first;
  // One conflict retry with a fresh read.
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
  enqueueLogOutbox(id, log);
  const versionKey = outboxEntriesForShop(id).find((e) => e.log.id === log.id)?.queuedAt;
  const clearThisVersion = () => {
    if (!versionKey) return removeOutboxLogIds(id, [log.id]);
    return removeOutboxVersions(id, [{ logId: log.id, queuedAt: versionKey }]);
  };

  const got = await remote.getShop();
  if (!got.ok) {
    enqueueLogOutbox(id, log, got.error);
    return { ok: false, error: got.error, queued: true };
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
        const logs2 = [...again.value.logs];
        const i2 = logs2.findIndex((l) => l.id === log.id);
        if (i2 === -1) logs2.unshift(log);
        else logs2[i2] = log;
        const put2 = await remote.putShop({ ...again.value, logs: logs2 });
        if (put2.ok) {
          clearThisVersion();
          return { ok: true };
        }
        enqueueLogOutbox(id, log, put2.error);
        return { ok: false, error: put2.error, queued: true };
      }
    }
    enqueueLogOutbox(id, log, put.error);
    return { ok: false, error: put.error, queued: true };
  }

  clearThisVersion();
  return { ok: true };
}
