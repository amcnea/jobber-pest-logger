import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { test } from "node:test";
import { decideBootstrap, decideChangePins, decideJoin } from "./access";
import { buildShopPinAuth, verifyPin } from "./pin";

const auth = buildShopPinAuth("1234", "5678");

test("verifyPin: correct, wrong, malformed", () => {
  assert.equal(verifyPin("1234", auth.officePin), true);
  assert.equal(verifyPin("1235", auth.officePin), false);
  assert.equal(verifyPin("12a4", auth.officePin), false);
  assert.equal(verifyPin("1234", { ...auth.officePin, hashB64: "AAAA" }), false);
  assert.equal(verifyPin("1234", null), false);
});

test("verifyPin accepts client (Web Crypto PBKDF2) records", () => {
  const salt = Buffer.alloc(16, 7);
  const hash = pbkdf2Sync("4321", salt, 100_000, 32, "sha256");
  const rec = { algorithm: "PBKDF2-SHA256", iterations: 100_000, saltB64: salt.toString("base64"), hashB64: hash.toString("base64") };
  assert.equal(verifyPin("4321", rec), true);
});

test("decideJoin: wrong PIN denied, no grant", () => {
  const d = decideJoin({ auth, members: {} }, "u1", "tech", "1234");
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.code, "permission-denied");
});

test("decideJoin: tech PIN cannot grant office", () => {
  const d = decideJoin({ auth, ownerUid: "", members: {} }, "u1", "office", "5678");
  assert.equal(d.ok, false);
});

test("decideJoin: office PIN grants office + claims missing owner", () => {
  const d = decideJoin({ auth, members: { t: "tech" } }, "u1", "office", "1234");
  assert.ok(d.ok);
  assert.deepEqual(d.value.members, { t: "tech", u1: "office" });
  assert.equal(d.value.ownerUid, "u1");
});

test("decideJoin: tech join keeps existing owner, never claims", () => {
  const d = decideJoin({ auth, ownerUid: "o", members: { o: "office" } }, "u1", "tech", "5678");
  assert.ok(d.ok);
  assert.equal(d.value.ownerUid, "o");
  const d2 = decideJoin({ auth, members: {} }, "u2", "tech", "5678");
  assert.ok(d2.ok);
  assert.equal(d2.value.ownerUid, "");
});

test("decideJoin: missing / unreadable auth fails closed", () => {
  assert.equal(decideJoin({}, "u", "tech", "5678").ok, false);
  assert.equal(decideJoin({ auth: { version: 1 } }, "u", "tech", "5678").ok, false);
});

test("decideBootstrap: blocked when auth exists or caller not office on member shop", () => {
  assert.equal(decideBootstrap({ auth }, "u", "1111", "2222").ok, false);
  assert.equal(decideBootstrap({ ownerUid: "o", members: { o: "office" } }, "u", "1111", "2222").ok, false);
  const ok = decideBootstrap({}, "u", "1111", "2222");
  assert.ok(ok.ok);
  assert.equal(ok.value.ownerUid, "u");
  assert.equal(decideBootstrap({}, "u", "1111", "1111").ok, false);
});

test("decideChangePins: only owner/office member", () => {
  const doc = { auth, ownerUid: "o", members: { o: "office", f: "office", t: "tech" } };
  assert.equal(decideChangePins(doc, "o", "1111", "2222").ok, true);
  assert.equal(decideChangePins(doc, "f", "1111", "2222").ok, true);
  assert.equal(decideChangePins(doc, "t", "1111", "2222").ok, false);
  assert.equal(decideChangePins(doc, "x", "1111", "2222").ok, false);
  assert.equal(decideChangePins({ auth }, "x", "1111", "2222").ok, false);
});
