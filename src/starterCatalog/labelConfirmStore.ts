/**
 * Durable set of shop product ids that still require label confirmation
 * before activate / unarchive (starter-catalog add flow).
 * Separate from ShopProduct — do not invent TDA fields on the catalog row.
 *
 * Reads fail closed: a storage/parse failure is an explicit `{ ok: false }`
 * so callers can block activation rather than treating pending ids as empty.
 */

export const STARTER_LABEL_CONFIRM_KEY = "jobber-pest-logger:starter-label-confirm:v1";

export type LabelConfirmReadResult =
  | { ok: true; ids: string[] }
  | { ok: false };

function readIds(): LabelConfirmReadResult {
  try {
    const raw = localStorage.getItem(STARTER_LABEL_CONFIRM_KEY);
    if (!raw) return { ok: true, ids: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { ok: true, ids: [] };
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return { ok: true, ids: out };
  } catch {
    return { ok: false };
  }
}

function writeIds(ids: string[]): boolean {
  try {
    localStorage.setItem(STARTER_LABEL_CONFIRM_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

/** True when this shop product id still needs label confirmation before activate. */
export function requiresLabelConfirm(
  productId: string,
): { ok: true; required: boolean } | { ok: false } {
  const id = productId.trim();
  if (!id) return { ok: true, required: false };
  const read = readIds();
  if (!read.ok) return { ok: false };
  return { ok: true, required: read.ids.includes(id) };
}

/** Snapshot of all product ids pending label confirmation (or explicit read failure). */
export function listPendingLabelConfirmIds(): LabelConfirmReadResult {
  return readIds();
}

/**
 * Mark a shop product as requiring label confirmation before activate.
 * Returns false when the id could not be persisted (caller must keep an in-memory guard).
 */
export function addPendingLabelConfirm(productId: string): boolean {
  const id = productId.trim();
  if (!id) return false;
  const read = readIds();
  if (!read.ok) return false;
  if (read.ids.includes(id)) return true;
  return writeIds([...read.ids, id]);
}

/**
 * Clear the label-confirmation requirement after confirm/activate or delete.
 * Returns false when the clear could not be persisted (caller must retain the guard).
 */
export function clearPendingLabelConfirm(productId: string): boolean {
  const id = productId.trim();
  if (!id) return false;
  const read = readIds();
  if (!read.ok) return false;
  if (!read.ids.includes(id)) return true;
  return writeIds(read.ids.filter((x) => x !== id));
}
