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
- Refresh README pre-#5 “until Auth/membership” wording where still wrong; note #6 done / #7–#8 next if you touch the roadmap section.
