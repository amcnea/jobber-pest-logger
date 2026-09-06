# Jobber Pest Logger

Texas-only **mobile-web compliance sidecar** for pest shops that already use Jobber. After a stop, a tech logs a pesticide application from the shop's own product list. The office exports one audit-ready Texas TDA CSV and a simple PDF.

This is **not** a field-service app. It does not do scheduling, invoicing, routing, payments, inventory, login, Jobber OAuth/API, Stripe, weather APIs, SMS reminders, or multi-state logic.

## v1

v1 is a working UI on this device only (browser localStorage). Schema is locked. The product list is **shop-owned** (office add/edit/delete), not a hardcoded SAMPLE catalog.

- New application log (locked section 7.144(a) fields)
- EPA number picker from the shop product list only (never free-typed, not scraped from EPA)
- Office-managed catalog: name, EPA #, 25(b) flag, pesticide vs device
- First-run example seeds (labeled as examples; they never print as real EPA numbers)
- Optional Jobber job number / address paste-on (not a TDA field)
- Termite flag reveals real section 7.144(b) extras (diagram is a text note, not a drawing)
- Property-level history grouped by service address
- Office export: Texas TDA CSV and printable PDF. Real shop products print their EPA numbers. Example seeds are labeled "example / not a real EPA number"

Records are kept **2 years**. This app does not run a retention engine.

## v1.1 People / roster

Office-managed tech roster stored under a **separate** localStorage key from logs and the product catalog (`jobber-pest-logger:people:v1`).

- People screen: add / edit / delete techs — name, license number, default role tags (applying | supervising | receiving_training; multi-select), license expiry date, optional CE due date
- New-log form: **three separate roster picks** (applying / supervising / receiving training) so they can diverge per stop. Role tags are **defaults only** (tagged names sort first; full roster still available). Picking fills name and license #; thin manual override remains
- In-app warnings (banner in the app shell + on the People list). Device-local calendar dates (not UTC-only, not Central-pinned). **No SMS**
  - **License:** past due or within **30 days** (shop convenience — not a TDA-required window)
  - **CE:** separate from the license window. CEUs are calendar-year, so a year-end reminder surfaces in **Nov/Dec** when a CE due date falls in the current local year; overdue CE always warns. Not a TDA-required window

Does not invent or change locked 4 TAC § 7.144 schema fields. Does not touch Jobber OAuth, Stripe, login, inventory, or multi-state.

## v1.2 Shop settings, export range, backup

Device-local shop settings under a **separate** localStorage key (`jobber-pest-logger:settings:v1`) from logs, catalog, and people.

- **Settings screen:** shop name, TPCL number, TPCL letter. New logs prefill `shopTpclNumber` / `shopTpclLetter` from settings (still editable per log). Shop name appears on PDF/print export headers when set; CSV keeps the TDA header on line 1 and puts the shop name in the download filename instead
- **Export screen:** date from / to filters on `dateUsed` (device-local YYYY-MM-DD string compare) plus a **This month** preset. CSV and PDF use the filtered set; count in range is shown
- **Backup:** download one JSON with logs, catalog, people, settings, and a version stamp. Restore from file after confirm replaces device data. Shape is validated (same style as existing storage validators); garbage is rejected

Does not add Jobber OAuth, SMS, Stripe, login, multi-state, or new TDA-required fields.

## v1.3 Property book / log again

Property book is **derived in memory** from saved logs (no separate localStorage key). Unique `serviceAddress` values are grouped with careful normalize (trim, collapse whitespace, case-fold). Each group keeps last-seen `customerBillingName`, `customerBillingAddress`, `poleLocation`, and `jobberAddress`.

On each History property group:

- **Log again here** — opens New log prefilled with those property fields only. `dateUsed` = today (device-local YYYY-MM-DD). New `id` / `createdAt`. Does **not** invent products, pest, or termite extras.
- **Duplicate last stop** — copies `products`, `targetPestOrPurpose`, and `isTermite` / termite extras from the most recent log at that address. Resets `id` / `createdAt` / `dateUsed` (today). Personnel come from roster role-tag defaults or empty picks (not invented from the prior stop). Clears `jobberJobNumber` so the tech re-attaches; may keep `jobberAddress`.

App lifts an optional draft into `NewLogForm` (remount via key) so History actions land on the New log tab with the same mobile-first tabs.

Does not add Jobber OAuth, SMS, Stripe, login, multi-state, or new TDA-required fields.

## Backup nag + Lawgical disclaimer

- **Last backup stamp:** after a successful backup JSON download, the app stores a device-local timestamp under its own localStorage key (`jobber-pest-logger:last-backup:v1`). Settings and Export show **Last backup: …** in a device-local friendly format (or **never**).
- **Soft nag:** if there is no backup yet, or the last backup is older than **7 days**, Settings and Export show a non-blocking reminder (banner/hint). Restore does not update the stamp — only a successful download does.
- **Lawgical disclaimer (short):** Texas SPCS structural use-record aid; shop/applicator responsible for accuracy and 2-year on-premises retention; not legal advice; not TDA-approved. Shown on the Export screen (and Settings) and on PDF header/footer.

Does not add Jobber OAuth, SMS, Stripe, login, sync, multi-state, GitHub Pages/workflow work, or new TDA-required fields.

## Shop product list

Stored in localStorage under a separate key from logs. The office adds the pesticides and devices this shop actually uses.

Seeded on first visit with three obvious examples:

- Example RTU insecticide
- Example 25(b) concentrate
- Example insect monitor (device)

Those seeds have **no EPA number**. They are flagged as examples. CSV and PDF print **example / not a real EPA number** instead of a fake registration number (never SAMPLE-0001-style placeholders). Delete or convert them when the shop list is ready. New products default to real (not example).

## Schema (locked)

Required on every application log, per 4 TAC section 7.144(a) for SPCS shops. Do not invent extra TDA/FIFRA required fields.

1. Customer billing name and address
2. Service address (optional pole location if utility-pole retreatment)
3. Pesticide names and EPA registration numbers if registered, or devices used. 25(b) products must still be recorded and may have no EPA number.
4. Total amount of each RTU pesticide (AI percent unchanged)
5. Devices used and count of each
6. If mixed: mixing rate and total material applied, or percent AI and total applied
7. Target pest or purpose
8. Date used
9. Name and license number of the person(s) receiving training, supervising, and applying, plus the shop TPCL number (and letter if any)

Termite-only extras from section 7.144(b) sit behind a termite flag, not on every stop: area treated (sq ft, except baits); physical-barrier measurement and diagram note (text, not a drawing); commercial pretreat (not baits/wood/barriers): tank count, tank gallons, start and stop time. Those fields are included in CSV/PDF when the stop is termite work.

Not TDA-required and not marked required: weather, time of day (except termite pretreat start/stop), Jobber job number, CE/license expiry reminder windows.

## Run

See package.json scripts. Install dependencies, then start the Vite "dev" script. Open the local URL it prints.

Production: "build" then "preview". Requires Node ^20.19 or Node >=22.12 (Vite 7). Data stays in the browser; nothing is uploaded.

## Stack

React + Vite + TypeScript. CSV from the locked columns. PDF via jsPDF (print stylesheet as a fallback).

## Exact scripts

See package.json: install, then the "dev", "build", and "preview" scripts.
