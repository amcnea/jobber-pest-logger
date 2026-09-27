import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_FAILS_PER_CALLER,
  MAX_FAILS_PER_SHOP,
  PIN_WINDOW_MS,
  callerKey,
  currentCounter,
  isLocked,
  lockedMessage,
  recordFail,
  retryAfterMs,
  shopKey,
} from "./rateLimit";

const T0 = 1_800_000_000_000;

test("currentCounter: missing, corrupt, expired, or future windows start fresh", () => {
  assert.deepEqual(currentCounter(undefined, T0), { windowStartMs: T0, fails: 0 });
  assert.deepEqual(currentCounter({ fails: "x" }, T0), { windowStartMs: T0, fails: 0 });
  assert.deepEqual(currentCounter({ windowStartMs: T0 - PIN_WINDOW_MS, fails: 9 }, T0), { windowStartMs: T0, fails: 0 });
  assert.deepEqual(currentCounter({ windowStartMs: T0 + 1000, fails: 9 }, T0), { windowStartMs: T0, fails: 0 });
  assert.deepEqual(currentCounter({ windowStartMs: T0 - 1000, fails: 3 }, T0), { windowStartMs: T0 - 1000, fails: 3 });
});

test("caller locks after MAX_FAILS_PER_CALLER failures inside one window", () => {
  let c = currentCounter(undefined, T0);
  for (let i = 0; i < MAX_FAILS_PER_CALLER; i++) {
    assert.equal(isLocked(c, MAX_FAILS_PER_CALLER), false);
    c = recordFail(c);
  }
  assert.equal(isLocked(c, MAX_FAILS_PER_CALLER), true);
  // Still locked a minute later, unlocked once the window has passed.
  assert.equal(isLocked(currentCounter(c, T0 + 60_000), MAX_FAILS_PER_CALLER), true);
  assert.equal(isLocked(currentCounter(c, T0 + PIN_WINDOW_MS), MAX_FAILS_PER_CALLER), false);
});

test("shop cap is higher than the caller cap", () => {
  assert.ok(MAX_FAILS_PER_SHOP > MAX_FAILS_PER_CALLER);
  assert.equal(isLocked({ windowStartMs: T0, fails: MAX_FAILS_PER_SHOP }, MAX_FAILS_PER_SHOP), true);
});

test("retry message and keys", () => {
  const c = { windowStartMs: T0, fails: MAX_FAILS_PER_CALLER };
  assert.equal(retryAfterMs(c, T0 + 60_000), PIN_WINDOW_MS - 60_000);
  assert.match(lockedMessage(c, T0 + 60_000), /14 minutes/);
  assert.match(lockedMessage(c, T0 + PIN_WINDOW_MS - 1), /1 minute\b/);
  assert.equal(callerKey("ABC", "u1"), "caller__ABC__u1");
  assert.equal(shopKey("ABC"), "shop__ABC");
  assert.notEqual(callerKey("A", "B__C"), shopKey("A"));
});
