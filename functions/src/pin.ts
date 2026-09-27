/**
 * Server-side PIN hashing/verify (cf1). Same format as src/shop/pinCrypto.ts
 * (PBKDF2-SHA-256, 100k iterations, 16-byte salt, 32-byte hash, base64) so
 * existing shop docs keep working. Compare is crypto.timingSafeEqual.
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const PIN_HASH_ALGORITHM = "PBKDF2-SHA256";
export const PIN_PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export type ShopRole = "office" | "tech";

export interface PinHashRecord {
  algorithm: typeof PIN_HASH_ALGORITHM;
  iterations: number;
  saltB64: string;
  hashB64: string;
}

export interface ShopPinAuth {
  version: 1;
  officePin: PinHashRecord;
  techPin: PinHashRecord;
}

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,8}$/.test(pin);
}

export function isShopRole(value: unknown): value is ShopRole {
  return value === "office" || value === "tech";
}

function b64(s: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  return Buffer.from(s, "base64");
}

export function isPinHashRecord(value: unknown): value is PinHashRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (
    r.algorithm !== PIN_HASH_ALGORITHM ||
    r.iterations !== PIN_PBKDF2_ITERATIONS ||
    typeof r.saltB64 !== "string" ||
    typeof r.hashB64 !== "string"
  ) {
    return false;
  }
  const salt = b64(r.saltB64);
  const hash = b64(r.hashB64);
  return Boolean(salt && hash && salt.length >= 8 && hash.length === HASH_BYTES);
}

export function parseShopPinAuth(raw: unknown): ShopPinAuth | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return undefined;
  if (!isPinHashRecord(o.officePin) || !isPinHashRecord(o.techPin)) return undefined;
  return { version: 1, officePin: o.officePin, techPin: o.techPin };
}

export function createPinHash(pin: string): PinHashRecord {
  if (!isValidPin(pin)) throw new Error("PIN must be 4–8 digits.");
  const salt = randomBytes(SALT_BYTES);
  const hash = pbkdf2Sync(pin, salt, PIN_PBKDF2_ITERATIONS, HASH_BYTES, "sha256");
  return {
    algorithm: PIN_HASH_ALGORITHM,
    iterations: PIN_PBKDF2_ITERATIONS,
    saltB64: salt.toString("base64"),
    hashB64: hash.toString("base64"),
  };
}

export function buildShopPinAuth(officePin: string, techPin: string): ShopPinAuth {
  return { version: 1, officePin: createPinHash(officePin), techPin: createPinHash(techPin) };
}

/** Constant-time verify against a stored record. Malformed records never match. */
export function verifyPin(pin: unknown, record: unknown): boolean {
  if (!isValidPin(pin) || !isPinHashRecord(record)) return false;
  const salt = b64(record.saltB64)!;
  const expected = b64(record.hashB64)!;
  const actual = pbkdf2Sync(pin, salt, record.iterations, HASH_BYTES, "sha256");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Same PIN pair rules as the client create/change forms. Returns an error or null. */
export function validatePinPair(officePin: unknown, techPin: unknown): string | null {
  if (!isValidPin(officePin)) return "Office PIN must be 4–8 digits.";
  if (!isValidPin(techPin)) return "Tech PIN must be 4–8 digits.";
  if (officePin === techPin) return "Office and tech PINs must be different.";
  return null;
}
