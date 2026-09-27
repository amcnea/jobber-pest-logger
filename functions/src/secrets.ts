/**
 * cf2: PIN hashes live in `shopSecrets/{shopId}` (Admin SDK only; the catch-all
 * rule in firestore.rules denies clients), not on the readable shop doc. The
 * shop doc keeps only `pinsConfigured: true` so clients know PINs exist.
 *
 * Legacy shop docs that still carry `auth` keep working: the functions read the
 * secret first, fall back to the shop doc's `auth`, and move it into the secret
 * on the next successful join, bootstrap, or PIN change.
 */
import type { ShopAccessDoc } from "./access";

export interface ShopSecretDoc {
  auth?: unknown;
}

export interface ShopDocWithPins extends ShopAccessDoc {
  pinsConfigured?: unknown;
}

function has(obj: object | undefined, key: string): boolean {
  return obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key);
}

/** True when the shop doc still exposes a PIN hash field that should be moved out. */
export function shopDocExposesAuth(shop: ShopDocWithPins): boolean {
  return has(shop, "auth");
}

/**
 * The doc the access decisions should see. The secret's `auth` wins; the shop
 * doc's `auth` is the legacy fallback. If the shop says PINs are configured but
 * no hashes exist anywhere, `auth` is set to an unreadable value so join fails
 * closed and bootstrap stays blocked (it treats any `auth` key as configured).
 */
export function effectiveAccessDoc(shop: ShopDocWithPins, secret: ShopSecretDoc | undefined): ShopAccessDoc {
  const { pinsConfigured, auth: _shopAuth, ...rest } = shop;
  const out: ShopAccessDoc = { ...rest };
  if (secret && has(secret, "auth")) out.auth = secret.auth;
  else if (has(shop, "auth")) out.auth = shop.auth;
  else if (pinsConfigured === true) out.auth = { missing: true };
  return out;
}
