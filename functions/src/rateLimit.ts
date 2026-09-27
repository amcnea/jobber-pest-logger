/**
 * PIN attempt limiting for joinShopWithPin (Bundle #71 Major). Pure logic so it
 * can be unit-tested offline; index.ts stores the counters with the Admin SDK in
 * `pinAttempts/{key}` docs. Clients can't read or write that collection because
 * the catch-all rule in firestore.rules denies it.
 *
 * Two fixed windows are counted. The per-caller counter (uid + shop) stops one
 * signed-in device from guessing. The per-shop counter caps guessing spread
 * across many anonymous uids. Only failed attempts count. A successful join
 * clears that caller's counter, but not the shop counter.
 */

export const PIN_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILS_PER_CALLER = 5;
export const MAX_FAILS_PER_SHOP = 25;

export interface AttemptCounter {
  windowStartMs: number;
  fails: number;
}

export function parseCounter(raw: unknown): AttemptCounter | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.windowStartMs !== "number" || typeof r.fails !== "number") return null;
  if (!Number.isFinite(r.windowStartMs) || !Number.isFinite(r.fails) || r.fails < 0) return null;
  return { windowStartMs: r.windowStartMs, fails: Math.floor(r.fails) };
}

/** Counter as of `nowMs`: a missing, unreadable, or expired window starts fresh. */
export function currentCounter(raw: unknown, nowMs: number): AttemptCounter {
  const c = parseCounter(raw);
  if (!c || nowMs < c.windowStartMs || nowMs - c.windowStartMs >= PIN_WINDOW_MS) {
    return { windowStartMs: nowMs, fails: 0 };
  }
  return c;
}

export function isLocked(c: AttemptCounter, max: number): boolean {
  return c.fails >= max;
}

export function retryAfterMs(c: AttemptCounter, nowMs: number): number {
  return Math.max(0, c.windowStartMs + PIN_WINDOW_MS - nowMs);
}

export function recordFail(c: AttemptCounter): AttemptCounter {
  return { windowStartMs: c.windowStartMs, fails: c.fails + 1 };
}

/** Doc IDs under pinAttempts/. The uid and shopId never contain "/" (validated upstream). */
export function callerKey(shopId: string, uid: string): string {
  return `caller__${shopId}__${uid}`;
}
export function shopKey(shopId: string): string {
  return `shop__${shopId}`;
}

export function lockedMessage(c: AttemptCounter, nowMs: number): string {
  const mins = Math.max(1, Math.ceil(retryAfterMs(c, nowMs) / 60000));
  return `Too many incorrect PIN attempts. Try again in about ${mins} minute${mins === 1 ? "" : "s"}, or ask the office.`;
}
