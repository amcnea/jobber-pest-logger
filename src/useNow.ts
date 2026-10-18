import { useEffect, useState } from "react";

/** How often time-based UI (future-date flags) re-reads the device clock. */
export const NOW_REFRESH_MS = 60_000;

/**
 * Device clock that refreshes every `intervalMs`, when the tab becomes visible again,
 * and on window focus (#160). Timers and listeners are removed on unmount.
 * Pass `fixed` (tests) to pin the value and skip the timers.
 */
export function useNow(fixed?: Date, intervalMs = NOW_REFRESH_MS): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (fixed) return;
    const tick = () => setNow(new Date());
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    const id = window.setInterval(tick, intervalMs);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fixed, intervalMs]);
  return fixed ?? now;
}
