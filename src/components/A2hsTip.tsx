import { useEffect, useMemo, useState } from "react";
import { dismissA2hsTip, loadA2hsTipDismissed } from "../storage";

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const mq = window.matchMedia?.("(display-mode: standalone)");
  if (mq?.matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return false;
}

function isLikelyMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Soft Add to Home Screen tip for phone browsers.
 * Thin PWA only — no service worker / no hosting rebuild.
 */
export function A2hsTip() {
  const [dismissed, setDismissed] = useState(() => loadA2hsTipDismissed());
  const [standalone, setStandalone] = useState(() => isStandaloneDisplay());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia?.("(display-mode: standalone)");
    const sync = () => setStandalone(isStandaloneDisplay());
    sync();
    mq?.addEventListener?.("change", sync);
    return () => mq?.removeEventListener?.("change", sync);
  }, []);

  const show = useMemo(() => {
    if (dismissed || standalone) return false;
    return isLikelyMobile();
  }, [dismissed, standalone]);

  if (!show) return null;

  const how = isIos()
    ? "On iPhone/iPad: Share → Add to Home Screen."
    : "On Android Chrome: browser menu → Install app / Add to Home screen.";

  return (
    <div className="banner banner-a2hs" role="status">
      <strong>Add to Home Screen</strong>
      <p className="checklist-sub">
        Optional. Puts Pest Logger on your phone like an app (office-desk URL, same device storage).{" "}
        {how} No extra download — this is still the hosted site.
      </p>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          if (dismissA2hsTip()) setDismissed(true);
        }}
      >
        Got it
      </button>
    </div>
  );
}
