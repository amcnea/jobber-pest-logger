/**
 * Shared Firebase app init (#5). Lazy-imported so local-only builds stay free of runtime Firebase.
 */
import type { FirebaseApp } from "firebase/app";
import type { FirebaseClientConfig } from "./firebaseConfig";

const APP_NAME = "jobber-pest-logger";

export async function getFirebaseApp(config: FirebaseClientConfig): Promise<FirebaseApp> {
  const { initializeApp, getApps } = await import("firebase/app");
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return existing;
  return initializeApp(
    {
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      appId: config.appId,
    },
    APP_NAME,
  );
}
