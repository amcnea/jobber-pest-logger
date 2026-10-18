/**
 * Sync-conflict resolution (correction history 3/4, conflict screen).
 *
 * A conflict is an outbox entry the shop refused (REMOTE_COPY_KEPT_ERROR): the shop's
 * copy is ahead, has a split change history, or is reviewed while this device's is not.
 *
 * - Take shop copy: this device's copy (the rejected upload, plus the saved local copy if
 *   it differs) goes to the set-aside store first, then the device adopts the shop copy
 *   and the rejected upload leaves the outbox. Nothing the tech entered is thrown away.
 * - Keep this device's copy: a normal correction on top of the shop copy (revision
 *   shop+1, roster changedBy, required reason, per-field diff), then synced. A reviewed
 *   shop copy keeps its review stamp and gains a history entry; it is never silently
 *   replaced. If this device's copy carries history the shop lacks, it is also set aside.
 *   If the shop no longer has the log, this device's copy is uploaded with a re-upload
 *   record (who, when, why) — not a correction, so no revision bump.
 * - A failure after the local save (upload queue / sync) still returns the saved logs with
 *   the error, so App never keeps the pre-resolution copy (#170).
 */
import {
  addSetAsideCopy,
  buildCorrection,
  buildReupload,
  isHistoryPrefix,
  loadLogs,
  saveResolvedLog,
} from "../storage";
import type { ApplicationLog, Person } from "../types";
import {
  outboxEntriesForShop,
  REMOTE_COPY_KEPT_ERROR,
  removeOutboxVersions,
  syncLogToRemote,
  type LogOutboxEntry,
} from "./logOutbox";
import type { RemoteShopStore } from "./RemoteShopStore";

/** Exact confirm text for "Take shop copy" (Lawgical). */
export const SET_ASIDE_CONFIRM =
  "This device's version will be set aside, not uploaded. It stays in the backup.";

export type ConflictResult =
  | { ok: true; logs: ApplicationLog[]; log: ApplicationLog }
  /** `logs` / `log` are set when the device copy was already saved before the failure. */
  | { ok: false; error: string; logs?: ApplicationLog[]; log?: ApplicationLog };

/** Outbox entries the shop refused because its copy was kept. */
export function listSyncConflicts(shopId: string): LogOutboxEntry[] {
  return outboxEntriesForShop(shopId).filter((e) => e.lastError === REMOTE_COPY_KEPT_ERROR);
}

async function fetchShopLog(
  remote: RemoteShopStore,
  logId: string,
): Promise<{ ok: true; log: ApplicationLog | null } | { ok: false; error: string }> {
  const got = await remote.getShop();
  if (!got.ok) return { ok: false, error: got.error };
  return { ok: true, log: got.value.logs.find((l) => l.id === logId) ?? null };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Take shop copy: set aside this device's copy, adopt the shop's, drop the rejected upload. */
export async function takeShopCopy(
  remote: RemoteShopStore,
  shopId: string,
  entry: LogOutboxEntry,
  options: { setAsideBy: string; people: Person[]; now?: Date },
): Promise<ConflictResult> {
  const shop = await fetchShopLog(remote, entry.log.id);
  if (!shop.ok) return shop;
  if (!shop.log) return { ok: false, error: "The shop no longer has this log. Keep this device's copy instead." };

  // Set aside first. If that fails, change nothing else.
  const local = loadLogs().find((l) => l.id === entry.log.id);
  const copies = [entry.log];
  if (local && !sameJson(local, entry.log)) copies.push(local);
  for (const copy of copies) {
    const added = addSetAsideCopy(copy, { ...options, shopId });
    if (!added.ok) return { ok: false, error: added.error };
  }

  const saved = saveResolvedLog(shop.log);
  if (!saved.saved) return { ok: false, error: "Could not save on this device." };
  const removed = await removeOutboxVersions(shopId.trim(), [entry.entryId], entry.log.id);
  if (!removed) {
    return {
      ok: false,
      error: "Saved the shop copy, but could not update the upload queue.",
      logs: saved.logs,
      log: shop.log,
    };
  }
  return { ok: true, logs: saved.logs, log: shop.log };
}

/** Keep this device's copy: correction on top of the shop copy, then sync it. */
export async function keepDeviceCopy(
  remote: RemoteShopStore,
  shopId: string,
  entry: LogOutboxEntry,
  options: { changedBy: string; reason: string; people: Person[]; now?: Date },
): Promise<ConflictResult> {
  const shop = await fetchShopLog(remote, entry.log.id);
  if (!shop.ok) return shop;

  let resolved: ApplicationLog;
  if (!shop.log) {
    // Shop no longer has it: upload this device's copy with a re-upload record
    // (roster person, reason, local time). Values, revision and history unchanged.
    const built = buildReupload(entry.log, {
      reuploadedBy: options.changedBy,
      reason: options.reason,
      people: options.people,
      now: options.now,
    });
    if (!built.ok) return built;
    resolved = built.log;
  } else {
    const built = buildCorrection(shop.log, entry.log, options);
    if (!built.ok) return built;
    resolved = built.log;
    // This device's own history entries that the shop lacks would not survive the
    // correction (only its values do) — keep the full device copy as a set-aside.
    if (!isHistoryPrefix(entry.log.history ?? [], shop.log.history ?? [])) {
      const added = addSetAsideCopy(entry.log, { setAsideBy: options.changedBy, people: options.people, shopId, now: options.now });
      if (!added.ok) return { ok: false, error: added.error };
    }
  }

  const saved = saveResolvedLog(resolved);
  if (!saved.saved) return { ok: false, error: "Could not save on this device." };
  const sync = await syncLogToRemote(remote, shopId, resolved);
  if (!sync.ok) return { ok: false, error: sync.error, logs: saved.logs, log: resolved };
  return { ok: true, logs: saved.logs, log: resolved };
}
