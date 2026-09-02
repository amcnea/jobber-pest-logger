# Jobber Pest Logger

Texas-only **mobile-web compliance sidecar** for pest shops that already use Jobber. After a stop, a tech logs a pesticide application. The office exports one audit-ready Texas TDA CSV and a simple PDF.

This is **not** a field-service app. It does not do scheduling, invoicing, routing, payments, inventory, login, Jobber OAuth/API, Stripe, weather APIs, CE tracking, or multi-state logic.

## v1 placeholder

v1 is a working UI on this device only (browser localStorage). Schema is locked. Catalog is **sample data**.

- New application log (locked section 7.144(a) fields)
- EPA number picker from a hardcoded SAMPLE catalog (never free-typed, not scraped from EPA)
- Optional Jobber job number / address paste-on (not a TDA field)
- Termite flag reveals section 7.144(b) extras (stub)
- Property-level history grouped by service address
- Office export: Texas TDA CSV and printable PDF, marked SAMPLE

Records are kept **2 years**. This app does not run a retention engine.

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

Termite-only extras from section 7.144(b) sit behind a termite flag, not on every stop: area treated (sq ft, except baits); physical-barrier measurement and diagram placeholder; commercial pretreat (not baits/wood/barriers): tank count, tank gallons, start and stop time.

Not TDA-required and not marked required: weather, time of day (except termite pretreat start/stop), Jobber job number, CE/license expiry.

## SAMPLE catalog disclaimer

The product picker is sample data only. It is not EPA data and is not scraped from EPA. Registration numbers are obvious placeholders (SAMPLE-0001, and so on). At least one 25(b) sample has no EPA number. Do not treat these names or numbers as real products.

## Run

See package.json scripts. Install dependencies, then start the Vite "dev" script. Open the local URL it prints.

Production: "build" then "preview". Requires Node ^20.19 or Node >=22.12 (Vite 7). Data stays in the browser; nothing is uploaded.

## Stack

React + Vite + TypeScript. CSV from the locked columns. PDF via jsPDF (print stylesheet as a fallback).

## Exact scripts

    npm install
    npm run dev
    npm run build
    npm run preview
