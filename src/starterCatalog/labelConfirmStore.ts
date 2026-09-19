/**
 * Durable set of shop product ids that still require label confirmation
 * before activate / unarchive (starter-catalog add flow).
 * Separate from ShopProduct — do not invent TDA fields on the catalog row.
 */

export const STARTER_LABEL_CONFIRM_KEY = "jobber-pest-logger:starter-label-confirm:v1";

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(STARTER_LABEL_CONFIRM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

function writeIds(ids: string[]): boolean {
  try {
    localStorage.setItem(STARTER_LABEL_CONFIRM_KEY, JSON.stringify(ids));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save starter label-confirm ids", err);
    return false;
  }
}

/** True when this shop product id still needs label confirmation before activate. */
export function requiresLabelConfirm(productId: string): boolean {
  const id = productId.trim();
  if (!id) return false;
  return readIds().includes(id);
}

/** Snapshot of all product ids pending label confirmation. */
export function listPendingLabelConfirmIds(): string[] {
  return readIds();
}

/** Mark a shop product as requiring label confirmation before activate. */
export function addPendingLabelConfirm(productId: string): boolean {
  const id = productId.trim();
  if (!id) return false;
  const ids = readIds();
  if (ids.includes(id)) return true;
  return writeIds([...ids, id]);
}

/** Clear the label-confirmation requirement after confirm/activate or delete. */
export function clearPendingLabelConfirm(productId: string): boolean {
  const id = productId.trim();
  if (!id) return false;
  const ids = readIds();
  if (!ids.includes(id)) return true;
  return writeIds(ids.filter((x) => x !== id));
}
