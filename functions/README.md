# Shop PIN + membership Cloud Functions (cf1)

Callable functions that move PIN verify and membership/owner grants off the client
(see `docs/BACKLOG.md`, Cloud Functions item 1). Every call requires Firebase Auth.

| Callable | Input | Server-side checks | Writes |
| --- | --- | --- | --- |
| `joinShopWithPin` | `shopId, role, pin` | auth; valid shopId/role; shop exists; PIN auth present + well-formed; PBKDF2 verify of the role PIN (`timingSafeEqual`); failed-attempt limits (5 per uid+shop, 25 per shop, per 15 min) | `members[uid]=role`; `ownerUid=uid` only when missing and role is office |
| `bootstrapShopPins` | `shopId, officePin, techPin` | auth; shop doc has no `auth` field at all (a `null` value counts as configured); if owner/members exist, caller must be owner or office; PIN pair rules | PIN hashes, `members[uid]=office`, `ownerUid` if missing |
| `changeShopPins` | `shopId, officePin, techPin` | auth; caller must be owner or office member on the doc; PIN pair rules | new PIN hashes |

All reads/writes run in a Firestore transaction via the Admin SDK. Hash format matches
`src/shop/pinCrypto.ts`, so existing shops keep working.

```sh
cd functions && npm ci && npm test   # typecheck/build + offline unit tests
```

The web client uses these only when built with `VITE_SHOP_PIN_FUNCTIONS=1`, so nothing
changes until the functions are deployed (`firebase deploy --only functions`, done by
the owner — not by CI). Tightening `firestore.rules` to deny client writes to
`members`/`ownerUid` is backlog item 3 (cf3).

Failed PIN attempts are counted in `pinAttempts/` (Admin SDK only; clients are denied by
the catch-all rule in `firestore.rules`). Once the caller or shop limit is hit, joins
return `resource-exhausted` until the 15-minute window ends. A successful join clears
that caller's counter. Keep `VITE_SHOP_PIN_FUNCTIONS` off in production until these
functions are deployed. The client-side PIN hash check still exists until cf2/cf3 land.

## PIN hashes are not on the shop doc (cf2)

`bootstrapShopPins`, `changeShopPins`, and every successful `joinShopWithPin` on a legacy
doc write the PIN hashes to `shopSecrets/{shopId}` and delete `auth` from `shops/{shopId}`,
leaving `pinsConfigured: true`. Clients can't read `shopSecrets/` (catch-all deny). The
functions read the secret first and fall back to a legacy `auth` field. A doc marked
`pinsConfigured` with no hashes anywhere fails closed, and bootstrap stays blocked.
With the flag on, `createShop` hands the hashes to `changeShopPins` right after the create
write. Legacy (flag-off) builds can't verify a migrated shop and show a reload message, so
existing shops only migrate once the functions are deployed and the flag is on.
