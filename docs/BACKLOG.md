# Backlog

Security / architecture items deferred past shared-shop #5 (PR #27). Not required for slices #6–#8 unless we choose to pull them forward.

## Cloud Functions — PIN + membership (from CodeRabbit security review on #27)

Client Anonymous Auth + Firestore rules cannot prove a PIN check. Until a trusted backend exists:

1. **PIN verify + membership/owner grants in a Cloud Function (or equivalent)**  
   Today `isJoinSelfUpdate` / self-assignment of `members[uid]` (including `"office"`) and claiming missing `ownerUid` do not prove PIN verification. Move verify + grant off the client; rules should not let anonymous callers make `isOffice()` true without a server-side grant.

2. **Stop exposing PIN hashes on shop `get`**  
   Any signed-in caller who knows `shopId` can read office/tech PBKDF2 hashes and offline-guess short PINs. Verify server-side (rate-limited); return only the authorization result to the client.

3. **Deny direct client writes to `members` and `ownerUid`** once (1) exists — Functions own those fields.

## Notes

- Shop code + client PIN remain a UX gate; treat rules as incomplete ACL until the above ships.
- Refresh README pre-#5 “until Auth/membership” wording where still wrong; #6–#8 shipped (export pull on #7).

## Offline outbox — cross-tab atomicity (#6 follow-up)

`localStorage` outbox read-modify-write is not atomic across browser tabs. Two tabs can enqueue different logs and overwrite each other. Fix with IndexedDB transactions or a cross-tab lock (`navigator.locks`) when we harden multi-device desk use. Single-tab tech phones are the primary #6 path.

## Bundle #40 one-shot (2026-09-19) — deferred Minors / nitpicks

From CodeRabbit on PR #40 (`bundle-20260919-1210` @ `5861be7`). Majors are owner-backport only; these stay backlog unless Charles says fix now.

### Binder (#30 `feat/harden-timeout-premises` @ `d2bec3d`)
- ~~`src/components/ShopSessionGate.tsx` — activity-only `SHOP_SESSION_KEY` updates must not bump `sessionMutationEpoch`~~ **Done** on `#7` / `feat/shared-export-backup` (compare old/new identity fingerprint; ignore `lastActiveAt`).

### Catalog (#33 `feat/texas-starter-catalog` @ `4767bea`)
- `src/components/Products.tsx:63-64` — ref write in render / delete effect; use `clearPendingLabel` helper. https://github.com/amcnea/jobber-pest-logger/pull/40#discussion_r4053979434
- `src/starterCatalog/labelConfirmStore.ts:21-25` — recovery must preserve pending IDs on malformed array (fail closed, don’t wipe to `[]`). https://github.com/amcnea/jobber-pest-logger/pull/40#discussion_r4053979440

Note: Catalog Major EPA fix (`texasCommon.ts` Demand CS `100-1063` → `100-1066`) is **not** backlog — owner must backport on #33.

