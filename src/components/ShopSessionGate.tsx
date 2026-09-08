/**
 * Minimal shared-shop sign-in / unlock gate (#3).
 * PIN is verified against remote hashes — role cannot be flipped locally alone.
 */
import { useState } from "react";
import {
  bootstrapShopPins,
  hasJoinedShop,
  isSessionAuthenticated,
  loadShopSession,
  signInShop,
  type ShopRole,
} from "../shop";

interface Props {
  /** Prefill shop code (remembered session). */
  initialShopCode?: string;
  onSessionChange: () => void;
  /** Compact banner style vs full card fields. */
  compact?: boolean;
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

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const result = await signInShop(shopCode, { role, pin });
      if (!result.ok) {
        setError(result.error);
        if (/no PINs yet/i.test(result.error)) {
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
        verify — editing localStorage alone is not enough.
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
            name="shop-role-gate"
            checked={role === "office"}
            onChange={() => setRole("office")}
          />
          Office
        </label>
        <label className="shop-role-option">
          <input
            type="radio"
            name="shop-role-gate"
            checked={role === "tech"}
            onChange={() => setRole("tech")}
          />
          Tech
        </label>
      </fieldset>
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
