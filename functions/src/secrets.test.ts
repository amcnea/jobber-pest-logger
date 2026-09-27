import assert from "node:assert/strict";
import { test } from "node:test";
import { decideBootstrap, decideJoin } from "./access";
import { buildShopPinAuth } from "./pin";
import { effectiveAccessDoc, shopDocExposesAuth } from "./secrets";

const auth = buildShopPinAuth("1234", "5678");

test("effectiveAccessDoc: secret auth wins over legacy shop auth", () => {
  const old = buildShopPinAuth("1111", "2222");
  const doc = effectiveAccessDoc({ auth: old, members: {} }, { auth });
  assert.ok(decideJoin(doc, "u", "office", "1234").ok);
  assert.equal(decideJoin(doc, "u", "office", "1111").ok, false);
});

test("effectiveAccessDoc: legacy shop doc auth still verifies when no secret exists", () => {
  const doc = effectiveAccessDoc({ auth, members: {} }, undefined);
  assert.ok(decideJoin(doc, "u", "tech", "5678").ok);
});

test("migrated shop (pinsConfigured, no auth on doc) verifies from the secret", () => {
  const doc = effectiveAccessDoc({ pinsConfigured: true, members: {} }, { auth });
  assert.ok(decideJoin(doc, "u", "tech", "5678").ok);
  assert.equal(decideBootstrap(doc, "stranger", "9999", "8888").ok, false);
});

test("pinsConfigured with no hashes anywhere fails closed and blocks bootstrap", () => {
  const doc = effectiveAccessDoc({ pinsConfigured: true }, undefined);
  const j = decideJoin(doc, "u", "tech", "5678");
  assert.equal(j.ok, false);
  assert.equal(!j.ok && j.code, "failed-precondition");
  assert.equal(decideBootstrap(doc, "stranger", "9999", "8888").ok, false);
});

test("a secret doc with an auth key set to null still blocks bootstrap", () => {
  assert.equal(decideBootstrap(effectiveAccessDoc({}, { auth: null }), "s", "9999", "8888").ok, false);
});

test("no auth anywhere and no pinsConfigured flag: bootstrap allowed", () => {
  assert.ok(decideBootstrap(effectiveAccessDoc({}, undefined), "u", "9999", "8888").ok);
  assert.ok(decideBootstrap(effectiveAccessDoc({}, {}), "u", "9999", "8888").ok);
});

test("effectiveAccessDoc never forwards pinsConfigured; shopDocExposesAuth checks key presence", () => {
  const doc = effectiveAccessDoc({ pinsConfigured: true, ownerUid: "o" }, { auth }) as Record<string, unknown>;
  assert.equal("pinsConfigured" in doc, false);
  assert.equal(doc.ownerUid, "o");
  assert.equal(shopDocExposesAuth({ auth: null }), true);
  assert.equal(shopDocExposesAuth({ pinsConfigured: true }), false);
});
