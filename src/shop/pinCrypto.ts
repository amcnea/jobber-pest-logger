/**
 * Shop PIN hashing (#3) — Web Crypto PBKDF2-SHA-256.
 * Raw PINs never go into localStorage; only salted hashes live on the shop doc.
 */

export const PIN_HASH_ALGORITHM = "PBKDF2-SHA256" as const;
export const PIN_PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export interface PinHashRecord {
  algorithm: typeof PIN_HASH_ALGORITHM;
  iterations: number;
  saltB64: string;
  hashB64: string;
}

export type ShopRole = "office" | "tech";

export interface ShopPinAuth {
  /** Hash format version — bump if algorithm/params change. */
  version: 1;
  officePin: PinHashRecord;
  techPin: PinHashRecord;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto is unavailable; cannot hash or verify PINs.");
  }
  return subtle;
}

/** Office/tech device PIN: 4–8 digits (keypad-friendly). */
export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

export function isShopRole(value: unknown): value is ShopRole {
  return value === "office" || value === "tech";
}

async function deriveHash(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const subtle = requireSubtle();
  const keyMaterial = await subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations,
    },
    keyMaterial,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Create a salted PBKDF2 record for a new PIN. */
export async function createPinHash(pin: string): Promise<PinHashRecord> {
  if (!isValidPin(pin)) {
    throw new Error("PIN must be 4–8 digits.");
  }
  const c = globalThis.crypto;
  if (typeof c?.getRandomValues !== "function") {
    throw new Error("Secure random source is unavailable; cannot salt a PIN.");
  }
  const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveHash(pin, salt, PIN_PBKDF2_ITERATIONS);
  return {
    algorithm: PIN_HASH_ALGORITHM,
    iterations: PIN_PBKDF2_ITERATIONS,
    saltB64: bytesToB64(salt),
    hashB64: bytesToB64(hash),
  };
}

/** Constant-time-ish compare of two equal-length byte arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function verifyPin(pin: string, record: PinHashRecord): Promise<boolean> {
  if (!isValidPin(pin)) return false;
  if (record.algorithm !== PIN_HASH_ALGORITHM) return false;
  if (!Number.isFinite(record.iterations) || record.iterations < 10_000) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64ToBytes(record.saltB64);
    expected = b64ToBytes(record.hashB64);
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length === 0) return false;
  try {
    const actual = await deriveHash(pin, salt, record.iterations);
    return bytesEqual(actual, expected);
  } catch {
    return false;
  }
}

export function isPinHashRecord(value: unknown): value is PinHashRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.algorithm === PIN_HASH_ALGORITHM &&
    typeof r.iterations === "number" &&
    typeof r.saltB64 === "string" &&
    r.saltB64.length > 0 &&
    typeof r.hashB64 === "string" &&
    r.hashB64.length > 0
  );
}

export function parseShopPinAuth(raw: unknown): ShopPinAuth | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return undefined;
  if (!isPinHashRecord(o.officePin) || !isPinHashRecord(o.techPin)) return undefined;
  return {
    version: 1,
    officePin: o.officePin,
    techPin: o.techPin,
  };
}

export async function buildShopPinAuth(
  officePin: string,
  techPin: string,
): Promise<ShopPinAuth> {
  if (!isValidPin(officePin) || !isValidPin(techPin)) {
    throw new Error("Office and tech PINs must each be 4–8 digits.");
  }
  const [office, tech] = await Promise.all([
    createPinHash(officePin),
    createPinHash(techPin),
  ]);
  return { version: 1, officePin: office, techPin: tech };
}

export function pinRecordForRole(auth: ShopPinAuth, role: ShopRole): PinHashRecord {
  return role === "office" ? auth.officePin : auth.techPin;
}
