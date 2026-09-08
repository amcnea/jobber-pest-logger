/**
 * One-time local→remote migrate marker per shopId on this device (#2).
 * Keyed by shopId so leave + rejoin does not re-upload blindly.
 */

export const SHOP_MIGRATED_KEY = "jobber-pest-logger:shop-migrated:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMap(): Record<string, true> {
  try {
    const raw = localStorage.getItem(SHOP_MIGRATED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const out: Record<string, true> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === true && typeof k === "string" && k.trim()) {
        out[k.trim()] = true;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, true>): boolean {
  try {
    localStorage.setItem(SHOP_MIGRATED_KEY, JSON.stringify(map));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save shop migrate marker", err);
    return false;
  }
}

export function hasMigratedShop(shopId: string): boolean {
  const id = shopId.trim();
  if (!id) return false;
  return readMap()[id] === true;
}

/** Record that this device already migrated (or intentionally skipped overwrite) for shopId. */
export function markShopMigrated(shopId: string): boolean {
  const id = shopId.trim();
  if (!id) return false;
  const map = readMap();
  map[id] = true;
  return writeMap(map);
}
