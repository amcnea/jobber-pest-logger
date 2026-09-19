/**
 * Minimal shared-shop sign-in / unlock gate (#3 + #5).
 * Anonymous Auth + PIN verify against remote hashes, then membership for this uid.
 * Role cannot be flipped locally alone.
 * #8: idle/TTL watcher clears auth and forces unlock without wiping local data.
 */
import { useEffect, useId, useRef, useState } from "react";
import {
  bootstrapShopPins,
  bumpSessionMutationEpoch,
  enforceSessionExpiry,
  hasJoinedShop,
  isSessionAuthenticated,
  loadShopSession,
  sessionAuthIdentityChanged,
  SHOP_SESSION_KEY,
  signInShop,
  touchSessionActivity,
  type ShopRole,
} from "../shop";

interface Props {
  /** Prefill shop code (remembered session). */
  initialShopCode?: string;
  onSessionChange: () => void;
  /** Compact banner style vs full card fields. */
  compact?: boolean;
}

/** Roles are app access only — not TDA / SPCS compliance status (#8). */
const ROLES_NOT_TDA =
  "Office and tech are app access roles only (which screens and PINs). They are not TDA or SPCS compliance status, license class, or certified-applicator standing.";

/**
 * Watches absolute TTL + idle activity. On expiry, clears auth (keeps shopId + local data)
 * and notifies App so the unlock gate appears.
 */
export function ShopSessionTimeoutWatcher({
  onSessionChange,
}: {
  onSessionChange: () => void;
}) {
  const lastTouchMs = useRef(0);

  useEffect(() => {
    const sessionFingerprint = () => {
      const s = loadShopSession();
      const authenticated = isSessionAuthenticated(s);
      return `${s.shopId.trim()}:${authenticated ? s.role : "locked"}`;
    };
    let lastFp = sessionFingerprint();

    const check = () => {
      enforceSessionExpiry();
      const fp = sessionFingerprint();
      // Notify on auth/shopId change (expiry clear, other-tab sign-out/leave, failed clear no-op).
      if (fp !== lastFp) {
        lastFp = fp;
        onSessionChange();
      }
    };

    const touch = () => {
      const session = loadShopSession();
      if (!isSessionAuthenticated(session)) {
        check();
        return;
      }
      const now = Date.now();
      // Throttle localStorage writes (~1/min while active).
      if (now - lastTouchMs.current < 60_000) return;
      lastTouchMs.current = now;
      if (!touchSessionActivity(now)) return;
      check();
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== SHOP_SESSION_KEY) return;
      // Other tab leave/sign-out only bumps that tab's in-memory epoch — invalidate here too.
      // Activity-only lastActiveAt rewrites must not bump (would abort in-flight signInShop).
      if (sessionAuthIdentityChanged(e.oldValue, e.newValue)) {
        bumpSessionMutationEpoch();
      }
      check();
    };

    check();
    touch();

    const onVis = () => {
      if (document.visibilityState === "visible") {
        check();
        touch();
      }
    };
    const onFocus = () => {
      check();
      touch();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("wheel", touch, { passive: true });
    window.addEventListener("keydown", touch);
    window.addEventListener("storage", onStorage);
    // Catch idle expiry while the tab stays open without interaction.
    const interval = window.setInterval(check, 60_000);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("wheel", touch);
      window.removeEventListener("keydown", touch);
      window.removeEventListener("storage", onStorage);
      window.clearInterval(interval);
    };
  }, [onSessionChange]);

  return null;
}

export function ShopSessionGate({
  initialShopCode = "",
  onSessionChange,
  compact = false,
}: Props) {
  const remembered = loadShopSession().shopId;
  const [shopCode, setShopCode] = useState(initialShopCode || remembered);
  const [role, setRole] = useState<ShopRole>("tech");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [officePin, setOfficePin] = useState("");
  const [officePinConfirm, setOfficePinConfirm] = useState("");
  const [techPin, setTechPin] = useState("");
  const [techPinConfirm, setTechPinConfirm] = useState("");
  const roleGroupName = `shop-role-gate-${useId()}`;

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const result = await signInShop(shopCode, { role, pin });
      if (!result.ok) {
        setError(result.error);
        if (result.reason === "pins-missing") {
          setShowBootstrap(true);
        }
        return;
      }
      setPin("");
      setMsg(result.message);
      onSessionChange();
    } finally {
      setBusy(false);
    }
  }

  async function handleBootstrap() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const result = await bootstrapShopPins(shopCode, {
        officePin,
        officePinConfirm,
        techPin,
        techPinConfirm,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOfficePin("");
      setOfficePinConfirm("");
      setTechPin("");
      setTechPinConfirm("");
      setShowBootstrap(false);
      setMsg(result.message);
      onSessionChange();
    } finally {
      setBusy(false);
    }
  }

  if (isSessionAuthenticated()) {
    return null;
  }

  const title = hasJoinedShop()
    ? "Unlock shared shop"
    : "Sign in to shared shop";

  return (
    <div className={compact ? "shop-gate shop-gate-compact" : "shop-gate card"}>
      <h3 className="shop-gate-title">{title}</h3>
      <p className="hint">
        Choose office or tech and enter the matching PIN. Role is stored only after remote PIN
        verify — editing localStorage alone is not enough. Idle or session TTL expiry signs you out
        and shows this unlock again; local logs and backups are not wiped.
      </p>
      <label className="field">
        Shop code
        <input
          value={shopCode}
          onChange={(e) => {
            setError(null);
            setShopCode(e.target.value);
          }}
          placeholder="e.g. ABCD2345"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-label="Shop code"
        />
      </label>
      <fieldset className="shop-role-fieldset" disabled={busy}>
        <legend>Role</legend>
        <label className="shop-role-option">
          <input
            type="radio"
            name={roleGroupName}
            checked={role === "office"}
            onChange={() => setRole("office")}
          />
          Office
        </label>
        <label className="shop-role-option">
          <input
            type="radio"
            name={roleGroupName}
            checked={role === "tech"}
            onChange={() => setRole("tech")}
          />
          Tech
        </label>
      </fieldset>
      <p className="hint roles-not-tda">{ROLES_NOT_TDA}</p>
      <label className="field">
        PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={pin}
          onChange={(e) => {
            setError(null);
            setPin(e.target.value);
          }}
          placeholder="4–8 digits"
          disabled={busy}
          aria-label="Role PIN"
        />
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || !shopCode.trim() || !pin.trim()}
        onClick={() => {
          void handleSignIn();
        }}
      >
        {busy ? "Working…" : "Unlock"}
      </button>

      {showBootstrap && (
        <div className="shop-bootstrap">
          <p className="hint">
            Pre-#3 shop with no PIN hashes yet. Set office + tech PINs once (anyone with the shop
            code can do this until hashes exist).
          </p>
          <label className="field">
            Office PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={officePin}
              onChange={(e) => setOfficePin(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            Confirm office PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={officePinConfirm}
              onChange={(e) => setOfficePinConfirm(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            Tech PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={techPin}
              onChange={(e) => setTechPin(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            Confirm tech PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={techPinConfirm}
              onChange={(e) => setTechPinConfirm(e.target.value)}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => {
              void handleBootstrap();
            }}
          >
            Set PINs &amp; sign in as office
          </button>
        </div>
      )}

      {msg && (
        <p className="hint" role="status">
          {msg}
        </p>
      )}
      {error && (
        <p className="hint" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
