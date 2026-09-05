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
