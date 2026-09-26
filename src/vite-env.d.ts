/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  /** "1" → join/unlock/PIN bootstrap/change use the cf1 Cloud Functions. */
  readonly VITE_SHOP_PIN_FUNCTIONS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
