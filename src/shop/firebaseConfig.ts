/**
 * Optional Vite Firebase env. When any required key is missing → local-only mode.
 * Do not require a Firebase project for build / dev / CI.
 */

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

export function readFirebaseEnv(): Partial<FirebaseClientConfig> {
  return {
    apiKey: (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined)?.trim() || undefined,
    authDomain:
      (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined)?.trim() || undefined,
    projectId:
      (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined)?.trim() || undefined,
    appId: (import.meta.env.VITE_FIREBASE_APP_ID as string | undefined)?.trim() || undefined,
  };
}

/** True only when all four required Vite Firebase keys are non-empty. */
export function isFirebaseConfigured(): boolean {
  const env = readFirebaseEnv();
  return Boolean(env.apiKey && env.authDomain && env.projectId && env.appId);
}

export function getFirebaseConfig(): FirebaseClientConfig | null {
  if (!isFirebaseConfigured()) return null;
  const env = readFirebaseEnv();
  return {
    apiKey: env.apiKey!,
    authDomain: env.authDomain!,
    projectId: env.projectId!,
    appId: env.appId!,
  };
}
