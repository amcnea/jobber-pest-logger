/**
 * Firebase Anonymous Auth for shared-shop devices (#5).
 * Each browser gets a stable uid (IndexedDB persistence). No email/password SaaS.
 */
import type { Auth, User } from "firebase/auth";
import type { FirebaseClientConfig } from "./firebaseConfig";
import { getFirebaseApp } from "./firebaseApp";

let authPromise: Promise<Auth> | null = null;

async function getAuth(config: FirebaseClientConfig): Promise<Auth> {
  if (!authPromise) {
    authPromise = (async () => {
      const app = await getFirebaseApp(config);
      const { getAuth: getFirebaseAuth } = await import("firebase/auth");
      return getFirebaseAuth(app);
    })();
  }
  return authPromise;
}

/**
 * Ensure this device has a Firebase Anonymous Auth uid.
 * Reuses an existing persisted anonymous session when present.
 */
export async function ensureAnonymousAuth(
  config: FirebaseClientConfig,
): Promise<{ uid: string; user: User }> {
  const auth = await getAuth(config);
  await auth.authStateReady();
  if (auth.currentUser) {
    return { uid: auth.currentUser.uid, user: auth.currentUser };
  }
  const { signInAnonymously } = await import("firebase/auth");
  const cred = await signInAnonymously(auth);
  if (!cred.user?.uid) {
    throw new Error("Anonymous sign-in did not return a uid.");
  }
  return { uid: cred.user.uid, user: cred.user };
}

/** Current Firebase uid if already signed in (may be null before ensureAnonymousAuth). */
export async function getCurrentUid(
  config: FirebaseClientConfig,
): Promise<string | null> {
  const auth = await getAuth(config);
  await auth.authStateReady();
  return auth.currentUser?.uid ?? null;
}

/**
 * Sign out of Firebase Auth on this device.
 * Used rarely — leave/sign-out of shop usually keeps the anon uid so re-join is stable.
 */
export async function signOutFirebaseAuth(
  config: FirebaseClientConfig,
): Promise<void> {
  const auth = await getAuth(config);
  if (!auth.currentUser) return;
  const { signOut } = await import("firebase/auth");
  await signOut(auth);
}
