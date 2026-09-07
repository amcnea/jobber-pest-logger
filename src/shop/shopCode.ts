/**
 * Human-shareable shop codes for create/join (#2).
 * Uppercase alphanumeric, no ambiguous I/O/0/1; always passes isValidShopId.
 */

import { isValidShopId } from "./session";

/** Crockford-ish alphabet — excludes I, O, 0, 1. */
const SHOP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEFAULT_LENGTH = 8;

/**
 * Generate a short uppercase shop code suitable as a Firestore document id.
 * Uses crypto.getRandomValues when available.
 */
export function generateShopCode(length = DEFAULT_LENGTH): string {
  const n = Math.max(4, Math.min(32, Math.floor(length)));
  const alphabet = SHOP_CODE_ALPHABET;
  const out: string[] = [];

  const c = globalThis.crypto;
  if (typeof c?.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(n));
    for (let i = 0; i < n; i++) {
      out.push(alphabet[bytes[i]! % alphabet.length]!);
    }
  } else {
    for (let i = 0; i < n; i++) {
      out.push(alphabet[Math.floor(Math.random() * alphabet.length)]!);
    }
  }

  const code = out.join("");
  if (!isValidShopId(code)) {
    // Alphabet + length are chosen to always pass; belt-and-suspenders.
    throw new Error("Generated shop code failed isValidShopId");
  }
  return code;
}

/** Normalize user-entered join codes (trim + uppercase). */
export function normalizeShopCode(raw: string): string {
  return raw.trim().toUpperCase();
}
