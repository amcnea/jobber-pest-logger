import { useState } from "react";
import { LAWGICAL_DISCLAIMER } from "../disclaimer";
import { dismissPilotCard, loadPilotCardDismissed } from "../storage";

const LIVE_URL = "https://amcnea.github.io/jobber-pest-logger/";

/**
 * Soft onboarding card after a shop opens the live URL.
 * Not the outreach teaser attachment — that stays the redacted PDF/CSV in am's note.
 */
export function ShopPilotCard() {
  const [dismissed, setDismissed] = useState(() => loadPilotCardDismissed());
  if (dismissed) return null;

  function handleDismiss() {
    if (dismissPilotCard()) setDismissed(true);
  }

  return (
    <div className="banner banner-pilot" role="region" aria-label="Shop pilot — how we use this with Jobber">
      <strong>Shop pilot — how we use this with Jobber</strong>
      <p className="checklist-sub">
        Soft onboarding only — does not replace Jobber scheduling, invoicing, or routing.
      </p>
      <ol className="pilot-steps">
        <li>Finish the stop in Jobber as you already do.</li>
        <li>
          Open this log on the office desk (or phone):{" "}
          <a href={LIVE_URL} target="_blank" rel="noopener noreferrer">
            {LIVE_URL}
          </a>
        </li>
        <li>
          Paste the Jobber job # and/or address if you want a link back (optional — not a TDA
          field).
        </li>
        <li>
          Log the pesticide/device application from the shop product list, then Export CSV/PDF for
          Texas SPCS use records.
        </li>
        <li>
          Download a JSON backup from Settings when you can. Keep records on the business premises
          for at least two years (shop responsibility — this app does not enforce retention).
        </li>
      </ol>
      <p className="disclaimer">{LAWGICAL_DISCLAIMER}</p>
      <button type="button" className="btn btn-secondary" onClick={handleDismiss}>
        Got it — hide this card
      </button>
    </div>
  );
}
