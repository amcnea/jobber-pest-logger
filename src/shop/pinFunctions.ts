/**
 * Client side of the cf1 shop callables (functions/src/index.ts). Opt-in via
 * VITE_SHOP_PIN_FUNCTIONS=1 so builds keep the client-verify path until the
 * functions are deployed. Lazy-imports firebase/functions.
 */
import { getFirebaseApp } from "./firebaseApp";
import type { FirebaseClientConfig } from "./firebaseConfig";
import type { ShopMembers } from "./types";

export function shopPinFunctionsEnabled(): boolean {
  return (import.meta.env.VITE_SHOP_PIN_FUNCTIONS as string | undefined)?.trim() === "1";
}

export interface MembershipGrant {
  updatedAt: string;
  members: ShopMembers;
  ownerUid?: string;
}

type CallResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(
  config: FirebaseClientConfig,
  name: "joinShopWithPin" | "bootstrapShopPins" | "changeShopPins",
  data: Record<string, unknown>,
): Promise<CallResult<T>> {
  try {
    const { getFunctions, httpsCallable } = await import("firebase/functions");
    const fn = httpsCallable<Record<string, unknown>, T>(
      getFunctions(await getFirebaseApp(config)),
      name,
    );
    return { ok: true, value: (await fn(data)).data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Shop server check failed. Try again.",
    };
  }
}

function toGrant(v: { updatedAt: string; members: ShopMembers; ownerUid?: string | null }): MembershipGrant {
  return { updatedAt: v.updatedAt, members: v.members, ownerUid: v.ownerUid || undefined };
}

/** Server verifies role PIN, then grants members[uid] (and legacy owner claim). */
export async function joinShopWithPinFn(
  config: FirebaseClientConfig,
  shopId: string,
  role: string,
  pin: string,
): Promise<CallResult<MembershipGrant>> {
  const r = await call<{ updatedAt: string; members: ShopMembers; ownerUid?: string | null }>(
    config,
    "joinShopWithPin",
    { shopId, role, pin },
  );
  return r.ok ? { ok: true, value: toGrant(r.value) } : r;
}

export async function bootstrapShopPinsFn(
  config: FirebaseClientConfig,
  shopId: string,
  officePin: string,
  techPin: string,
): Promise<CallResult<MembershipGrant>> {
  const r = await call<{ updatedAt: string; members: ShopMembers; ownerUid?: string | null }>(
    config,
    "bootstrapShopPins",
    { shopId, officePin, techPin },
  );
  return r.ok ? { ok: true, value: toGrant(r.value) } : r;
}

export async function changeShopPinsFn(
  config: FirebaseClientConfig,
  shopId: string,
  officePin: string,
  techPin: string,
): Promise<CallResult<{ updatedAt: string }>> {
  return call<{ updatedAt: string }>(config, "changeShopPins", { shopId, officePin, techPin });
}
