/**
 * Firestore security rules tests for the review lock on shared logs (#162, #208, #215).
 *
 * Run via: npm run test:rules (starts the Firestore emulator around this file).
 */
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from "firebase/firestore";

const SHOP = "SHOP1";
const OFFICE = "uid-office";
const TECH = "uid-tech";
const STRANGER = "uid-stranger";

let env;

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-review-lock",
    firestore: {
      host,
      port: Number(port),
      rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
    },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
});

after(async () => {
  await env?.cleanup();
});

// ---- fixtures (mirror src/types.ts + src/storage.ts buildCorrection) -------------------

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const RECENT = ymd(Date.now() - 10 * DAY);
const THREE_YEARS_AGO = ymd(Date.now() - 3 * 365 * DAY);
const IN_TWO_YEARS = ymd(Date.now() + 2 * 365 * DAY);
const IN_THREE_YEARS = ymd(Date.now() + 3 * 365 * DAY);
const IN_FOUR_YEARS = ymd(Date.now() + 4 * 365 * DAY);

function makeLog(id, extra = {}) {
  return {
    id,
    createdAt: `${RECENT}T15:00:00.000Z`,
    updatedAt: `${RECENT}T15:00:00.000Z`,
    dateUsed: RECENT,
    timeStarted: "09:00",
    timeFinished: "09:30",
    customerName: "Acme Holdings",
    serviceAddress: "100 Main St, Austin TX",
    applicatorName: "Taylor Tech",
    applicatorLicense: "CA-001",
    supervisedStatus: "licensed",
    epaRegNo: "53883-326",
    productName: "Bifen I/T",
    amountUsed: "1",
    unit: "fl_oz",
    targetPestOrPurpose: "Ants",
    method: "Perimeter spray",
    poleLocation: "Front perimeter",
    tempF: "78",
    windMph: "5",
    windDirection: "S",
    notes: "",
    ...extra,
  };
}

/** An unreviewed log whose 2-year hold is already over (#221). */
function oldLog(id, extra = {}) {
  return makeLog(id, {
    createdAt: `${THREE_YEARS_AGO}T15:00:00.000Z`,
    updatedAt: `${THREE_YEARS_AGO}T15:00:00.000Z`,
    dateUsed: THREE_YEARS_AGO,
    ...extra,
  });
}

function reviewed(log, extra = {}) {
  return {
    ...log,
    reviewedAt: "2026-10-01T18:00:00-05:00",
    reviewedBy: "Ana Office (TPCL #900001)",
    revision: 0,
    ...extra,
  };
}

/** Build a correction the way storage.buildCorrection does. */
function correct(prev, patch, opts = {}) {
  const { history, reuploads, retainUntil, ...priorSnapshot } = prev;
  const priorHistory = history ?? [];
  const revision = (prev.revision ?? priorHistory.length) + 1;
  const changes = opts.changes ?? Object.keys(patch).map((field) => ({
    field,
    label: field,
    before: String(prev[field] ?? ""),
    after: String(patch[field] ?? ""),
  }));
  const entry = {
    revision,
    changedAt: opts.changedAt ?? "2026-10-17T20:30:00-05:00",
    changedBy: opts.changedBy ?? "Taylor Tech (CA #001)",
    reason: opts.reason ?? "Wrong house number on work order",
    changes,
    priorSnapshot,
  };
  return {
    ...prev,
    ...patch,
    updatedAt: "2026-10-17T20:30:00-05:00",
    revision,
    history: [...priorHistory, entry],
  };
}

function shopDoc(logs = [], extra = {}) {
  return {
    version: 1,
    shopId: SHOP,
    updatedAt: "2026-10-01T15:00:00.000Z",
    logs,
    catalog: { products: [], equipment: [], methods: [], units: [], targetPests: [] },
    people: [],
    settings: { shopName: "Acme", shopTpclNumber: "900001", shopTpclLetter: "" },
    auth: { officePinHash: "h1", techPinHash: "h2" },
    ownerUid: OFFICE,
    members: { [OFFICE]: "office", [TECH]: "tech" },
    ...extra,
  };
}

/** Seed the shop doc (with `logs: []`) and each log at `shops/{shopId}/logs/{log.id}`. */
async function seed(logs, extra = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "shops", SHOP), shopDoc([], extra));
    for (const log of logs) {
      await setDoc(doc(db, "shops", SHOP, "logs", log.id), log);
    }
  });
}

/** Seed a legacy shop doc that still carries its logs in `shops/{shopId}.logs`. */
async function seedLegacy(logs, extra = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "shops", SHOP), shopDoc(logs, extra));
  });
}

function putLog(uid, log, docId = log.id) {
  const db = env.authenticatedContext(uid).firestore();
  return setDoc(doc(db, "shops", SHOP, "logs", docId), log);
}

function delLog(uid, logId) {
  const db = env.authenticatedContext(uid).firestore();
  return deleteDoc(doc(db, "shops", SHOP, "logs", logId));
}

function putShopDoc(uid, logs = [], extra = {}) {
  const db = env.authenticatedContext(uid).firestore();
  return setDoc(
    doc(db, "shops", SHOP),
    shopDoc(logs, { updatedAt: "2026-10-17T20:30:00.000Z", ...extra }),
  );
}

const WRITERS = [
  ["tech", TECH],
  ["office", OFFICE],
];

// ---- tests ----------------------------------------------------------------------------

describe("reviewed log: overwrite and delete are denied", () => {
  for (const [who, uid] of WRITERS) {
    it(`${who} plain overwrite of a reviewed log is denied`, async () => {
      const r = reviewed(makeLog("R"));
      await seed([r, makeLog("U")]);
      await assertFails(putLog(uid, { ...r, serviceAddress: "9 Elm St" }));
    });

    it(`${who} deleting a reviewed log is denied`, async () => {
      const r = reviewed(makeLog("R"));
      await seed([r, makeLog("U")]);
      await assertFails(delLog(uid, "R"));
    });
  }

  it("removing the review stamp from a reviewed log is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    const { reviewedAt, reviewedBy, revision, ...unstamped } = r;
    await assertFails(putLog(TECH, unstamped));
  });

  it("changing the id of a reviewed log or writing it under another doc key is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    await assertFails(putLog(TECH, { ...r, id: "X" }, "R"));
    await assertFails(putLog(TECH, r, "X"));
  });

  it("deleting the shop doc stays denied", async () => {
    await seed([reviewed(makeLog("R"))]);
    const db = env.authenticatedContext(OFFICE).firestore();
    await assertFails(deleteDoc(doc(db, "shops", SHOP)));
  });

  it("stuffing logs into the shop doc's legacy logs array is denied", async () => {
    await seed([]);
    await assertFails(putShopDoc(TECH, [makeLog("N")]));
    await assertFails(putShopDoc(OFFICE, [makeLog("N")]));
  });
});

describe("reviewed log: a proper correction is allowed", () => {
  for (const [who, uid] of WRITERS) {
    it(`${who} correction (revision + 1, priorSnapshot appended, reason and changedBy) passes`, async () => {
      const r = reviewed(makeLog("R"));
      await seed([r, makeLog("U")]);
      const fixed = correct(r, { serviceAddress: "9 Elm St" });
      await assertSucceeds(putLog(uid, fixed));
    });
  }

  it("a second correction on top of the first passes", async () => {
    const r0 = reviewed(makeLog("R"));
    const r1 = correct(r0, { serviceAddress: "9 Elm St" });
    await seed([r1]);
    const r2 = correct(r1, { targetPestOrPurpose: "Roaches" }, { reason: "Tech noted roaches too" });
    await assertSucceeds(putLog(OFFICE, r2));
  });

  it("keeps re-upload records and a stored hold (hold may move later)", async () => {
    const r = reviewed(
      makeLog("R", {
        reuploads: [{ reuploadedAt: "2026-10-02T08:00:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" }],
        retainUntil: "2028-10-01",
      }),
    );
    await seed([r]);
    await assertSucceeds(putLog(TECH, correct(r, { serviceAddress: "9 Elm St" })));
    await seed([r]);
    await assertSucceeds(putLog(TECH, { ...correct(r, { serviceAddress: "9 Elm St" }), retainUntil: "2029-01-01" }));
  });

  it("a reviewed log without a stored revision (revision = history length)", async () => {
    const { revision, ...noRev } = reviewed(makeLog("R"));
    await seed([noRev]);
    await assertSucceeds(putLog(TECH, correct(noRev, { serviceAddress: "9 Elm St" })));
  });
});

describe("reviewed log: an improper correction is denied", () => {
  const base = () => reviewed(makeLog("R"));
  const fix = { serviceAddress: "9 Elm St" };
  const cases = [
    ["missing reason", (r) => {
      const c = correct(r, fix);
      const { reason, ...entry } = c.history[0];
      return { ...c, history: [entry] };
    }],
    ["blank reason", (r) => correct(r, fix, { reason: "   " })],
    ["missing changedBy", (r) => {
      const c = correct(r, fix);
      const { changedBy, ...entry } = c.history[0];
      return { ...c, history: [entry] };
    }],
    ["blank changedBy", (r) => correct(r, fix, { changedBy: "" })],
    ["missing prior snapshot", (r) => {
      const c = correct(r, fix);
      const { priorSnapshot, ...entry } = c.history[0];
      return { ...c, history: [entry] };
    }],
    ["prior snapshot that isn't the stored log", (r) => {
      const c = correct(r, fix);
      return { ...c, history: [{ ...c.history[0], priorSnapshot: { ...c.history[0].priorSnapshot, serviceAddress: "elsewhere" } }] };
    }],
    ["no history entry added", (r) => ({ ...r, ...fix, revision: 1 })],
    ["revision +2", (r) => {
      const c = correct(r, fix);
      return { ...c, revision: 2, history: [{ ...c.history[0], revision: 2 }] };
    }],
    ["revision unchanged", (r) => {
      const c = correct(r, fix);
      return { ...c, revision: 0, history: [{ ...c.history[0], revision: 0 }] };
    }],
    ["entry revision not matching the log", (r) => {
      const c = correct(r, fix);
      return { ...c, history: [{ ...c.history[0], revision: 5 }] };
    }],
    ["no changes listed", (r) => correct(r, fix, { changes: [] })],
    ["review stamp changed", (r) => ({ ...correct(r, fix), reviewedBy: "Someone Else" })],
    ["createdAt changed", (r) => ({ ...correct(r, fix), createdAt: "2020-01-01T00:00:00.000Z" })],
    ["hold shortened", (r) => ({ ...correct({ ...r, retainUntil: "2029-01-01" }, fix), retainUntil: "2028-01-01" })],
  ];
  for (const [name, build] of cases) {
    it(name, async () => {
      const r = name === "hold shortened" ? { ...base(), retainUntil: "2029-01-01" } : base();
      await seed([r]);
      await assertFails(putLog(TECH, build(base())));
    });
  }

  it("rewriting earlier history entries", async () => {
    const first = correct(base(), fix);
    await seed([first]);
    const second = correct(first, { targetPestOrPurpose: "Roaches" });
    second.history = [{ ...second.history[0], reason: "edited later" }, second.history[1]];
    await assertFails(putLog(TECH, second));
  });
});

describe("reviewed log: same-revision re-sends", () => {
  it("an unchanged re-send passes", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    await assertSucceeds(putLog(TECH, r));
  });

  it("a later retainUntil hold passes; an earlier or removed one is denied", async () => {
    const r = reviewed(makeLog("R", { retainUntil: "2028-10-01" }));
    await seed([r]);
    await assertSucceeds(putLog(TECH, { ...r, retainUntil: "2029-01-01" }));
    await seed([r]);
    await assertFails(putLog(TECH, { ...r, retainUntil: "2027-01-01" }));
    await seed([r]);
    const { retainUntil, ...noHold } = r;
    await assertFails(putLog(TECH, noHold));
  });

  it("an appended re-upload record passes; dropping one is denied", async () => {
    const rec = { reuploadedAt: "2026-10-02T08:00:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" };
    const r = reviewed(makeLog("R", { reuploads: [rec] }));
    await seed([r]);
    await assertSucceeds(putLog(TECH, { ...r, reuploads: [rec, { ...rec, reason: "Again" }] }));
    await seed([r]);
    await assertFails(putLog(TECH, { ...r, reuploads: [] }));
  });
});

describe("re-upload of a log the shop no longer has", () => {
  it("adding the missing log with its re-upload record is allowed", async () => {
    await seed([makeLog("U")]);
    const reup = reviewed(
      makeLog("R", {
        reuploads: [{ reuploadedAt: "2026-10-17T20:40:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" }],
      }),
    );
    await assertSucceeds(putLog(TECH, reup));
  });

  it("re-upload into a shop with no logs yet", async () => {
    await seed([]);
    const reup = makeLog("R", {
      reuploads: [{ reuploadedAt: "2026-10-17T20:40:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" }],
    });
    await assertSucceeds(putLog(TECH, reup));
  });
});

describe("unreviewed logs behave as before", () => {
  for (const [who, uid] of WRITERS) {
    it(`${who}: overwrite, delete (past hold) and add are allowed`, async () => {
      await seed([oldLog("U1"), makeLog("U2")]);
      await assertSucceeds(putLog(uid, makeLog("N")));
      await assertSucceeds(putLog(uid, { ...oldLog("U1"), serviceAddress: "9 Elm St" }));
      await assertSucceeds(delLog(uid, "U1"));
    });
  }

  it("office review action (sets reviewedAt / reviewedBy) is allowed", async () => {
    await seed([makeLog("U")]);
    await assertSucceeds(putLog(OFFICE, reviewed(makeLog("U"))));
  });

  it("a reviewed log in the shop doesn't block edits or deletes of unreviewed ones", async () => {
    const r = reviewed(makeLog("R"));
    await seed([oldLog("U"), r]);
    await assertSucceeds(putLog(TECH, { ...oldLog("U"), serviceAddress: "9 Elm St" }));
    await assertSucceeds(delLog(TECH, "U"));
  });

  it("a stranger still can't create, update, or delete logs", async () => {
    await seed([oldLog("U")]);
    await assertFails(putLog(STRANGER, makeLog("N")));
    await assertFails(putLog(STRANGER, { ...oldLog("U"), serviceAddress: "9 Elm St" }));
    await assertFails(delLog(STRANGER, "U"));
  });
});

describe("#215: per-log documents prevent duplicate IDs and remove array expression limits", () => {
  it("a second copy reusing R's id cannot be created under R or under another document key", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    // Writing at logs/R hits `update` on the existing reviewed doc and is denied.
    await assertFails(putLog(TECH, makeLog("R", { serviceAddress: "Forged" }), "R"));
    await assertFails(putLog(OFFICE, { ...r, serviceAddress: "Forged" }, "R"));
    // Writing with id="R" under another document key logs/FAKE fails `request.resource.data.id == logId`.
    await assertFails(putLog(TECH, makeLog("R", { serviceAddress: "Forged" }), "FAKE"));
    await assertFails(putLog(OFFICE, { ...r, serviceAddress: "Forged" }, "FAKE"));
    // Writing a correction of R with id="X" fails under both logs/R and logs/X.
    await assertFails(putLog(TECH, { ...correct(r, { serviceAddress: "9 Elm St" }), id: "X" }, "R"));
  });

  it("large shop (200 logs): per-log writes succeed with no 40-log or expression-budget ceiling", async () => {
    const logs = [];
    for (let i = 0; i < 200; i++) {
      logs.push(i % 10 === 0 ? reviewed(makeLog(`L${i}`)) : makeLog(`L${i}`));
    }
    await seed(logs);
    await assertSucceeds(putLog(TECH, makeLog("N1")));
    await assertSucceeds(putLog(TECH, correct(logs[0], { serviceAddress: "9 Elm St" })));
    for (let i = 1; i <= 45; i++) {
      if (i % 10 !== 0) {
        await assertSucceeds(putLog(TECH, { ...logs[i], targetPestOrPurpose: "Roaches" }));
      }
    }
  });
});

describe("other shop writes still work with reviewed logs present", () => {
  it("join-self membership update", async () => {
    await seed([reviewed(makeLog("R"))]);
    const db = env.authenticatedContext("uid-new").firestore();
    await assertSucceeds(
      updateDoc(doc(db, "shops", SHOP), {
        members: { [OFFICE]: "office", [TECH]: "tech", "uid-new": "tech" },
        updatedAt: "2026-10-17T12:10:00.000Z",
      }),
    );
  });

  it("office settings change with logs untouched", async () => {
    await seed([reviewed(makeLog("R")), makeLog("U")]);
    await assertSucceeds(
      putShopDoc(OFFICE, [], { settings: { shopName: "Acme 2", shopTpclNumber: "1", shopTpclLetter: "" } }),
    );
  });

  it("signed-in callers can read shop and logs; unauthenticated callers cannot", async () => {
    await seed([reviewed(makeLog("R"))]);
    const techDb = env.authenticatedContext(TECH).firestore();
    await assertSucceeds(getDoc(doc(techDb, "shops", SHOP)));
    await assertSucceeds(getDoc(doc(techDb, "shops", SHOP, "logs", "R")));
    await assertSucceeds(getDocs(collection(techDb, "shops", SHOP, "logs")));

    const anonDb = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, "shops", SHOP)));
    await assertFails(getDoc(doc(anonDb, "shops", SHOP, "logs", "R")));
    await assertFails(getDocs(collection(anonDb, "shops", SHOP, "logs")));
  });
});

// ---- #220: a shop doc with no logs field ----------------------------------------------

describe("#220: join, legacy PIN setup, and per-log writes on a doc with no logs field", () => {
  async function seedRaw(data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "shops", SHOP), data);
    });
  }

  it("join-self membership update passes", async () => {
    const { logs, ...noLogs } = shopDoc([]);
    await seedRaw(noLogs);
    const db = env.authenticatedContext("uid-new").firestore();
    await assertSucceeds(
      updateDoc(doc(db, "shops", SHOP), {
        members: { [OFFICE]: "office", [TECH]: "tech", "uid-new": "tech" },
        updatedAt: "2026-10-17T12:10:00.000Z",
      }),
    );
  });

  it("legacy PIN bootstrap passes", async () => {
    const { logs, auth, ownerUid, members, ...legacy } = shopDoc([]);
    await seedRaw({ ...legacy, members: {} });
    const db = env.authenticatedContext(OFFICE).firestore();
    await assertSucceeds(
      updateDoc(doc(db, "shops", SHOP), {
        auth: { officePinHash: "h1", techPinHash: "h2" },
        ownerUid: OFFICE,
        members: { [OFFICE]: "office" },
        updatedAt: "2026-10-17T12:10:00.000Z",
      }),
    );
  });

  it("creating a shop doc without a logs field (or with logs: []) passes, and adding logs to subcollection works", async () => {
    const { logs, ...noLogs } = shopDoc([]);
    const officeDb = env.authenticatedContext(OFFICE).firestore();
    await assertSucceeds(setDoc(doc(officeDb, "shops", SHOP), noLogs));
    await assertSucceeds(putLog(TECH, makeLog("N")));
  });
});

// ---- #221: 2-year hold on removed logs ------------------------------------------------
// Hold date D runs to the end of D in UTC-12: removal needs request.time >= (D+1) 12:00 UTC.
// Dates are relative to now so the tests don't age (the boundary is the UTC date of
// now - 36 h: that D is released, the next day is still held).

const minusYears = (s, n) => `${Number(s.slice(0, 4)) - n}${s.slice(4)}`;
const GUARD = 10 * 60000;
const sinceNoon = (Date.now() % DAY) - DAY / 2;
if (Math.abs(sinceNoon) < GUARD) await new Promise((resolve) => setTimeout(resolve, GUARD - sinceNoon));
const NOW = Date.now();
const LAST_RELEASED = ymd(NOW - 1.5 * DAY);
const FIRST_HELD = ymd(NOW - 0.5 * DAY);

describe("#221: removing a log under its 2-year hold", () => {
  const removeOnly = async (log) => {
    const r = reviewed(makeLog("R"));
    await seed([log, r]);
    return delLog(TECH, log.id);
  };

  it("removing a held unreviewed log is denied (recent dates, or a later retainUntil)", async () => {
    await assertFails(removeOnly(makeLog("U")));
    await assertFails(removeOnly(oldLog("U", { retainUntil: IN_THREE_YEARS })));
  });

  it("removing a log past its hold is allowed (retainUntil, or no retainUntil and old dates)", async () => {
    await assertSucceeds(removeOnly(makeLog("U", { retainUntil: THREE_YEARS_AGO })));
    await assertSucceeds(removeOnly(oldLog("U")));
  });

  it("UTC-12 boundary: retainUntil D is released at (D+1) 12:00 UTC, not before", async () => {
    await assertSucceeds(removeOnly(makeLog("U", { retainUntil: LAST_RELEASED })));
    await assertFails(removeOnly(makeLog("U", { retainUntil: FIRST_HELD })));
  });

  it("no retainUntil: 2 years after dateUsed", async () => {
    const created = "2023-01-01T15:00:00.000Z";
    await assertSucceeds(removeOnly(makeLog("U", { dateUsed: minusYears(LAST_RELEASED, 2), createdAt: created })));
    await assertFails(removeOnly(makeLog("U", { dateUsed: minusYears(FIRST_HELD, 2), createdAt: created })));
  });

  it("no retainUntil: a later createdAt wins (its date counts one day later)", async () => {
    const at = (d) => `${d}T23:00:00.000Z`;
    const prevDay = (d) => ymd(Date.parse(`${d}T00:00:00Z`) - DAY);
    await assertFails(removeOnly(makeLog("U", { dateUsed: "2023-01-01", createdAt: new Date(Date.now() - 30 * DAY).toISOString() })));
    // createdAt date C holds until C + 1 day + 2 years.
    await assertSucceeds(removeOnly(makeLog("U", { dateUsed: "2023-01-01", createdAt: at(prevDay(minusYears(LAST_RELEASED, 2))) })));
    await assertFails(removeOnly(makeLog("U", { dateUsed: "2023-01-01", createdAt: at(minusYears(LAST_RELEASED, 2)) })));
  });

  it("no readable date: removal is denied", async () => {
    for (const extra of [
      { dateUsed: "", createdAt: "" },
      { dateUsed: "not a date", createdAt: "soon" },
      { dateUsed: "2024-13-01", createdAt: undefined },
    ]) {
      const log = makeLog("U", extra);
      if (extra.createdAt === undefined) delete log.createdAt;
      await assertFails(removeOnly(log));
    }
  });
});

describe("#227: editing an unreviewed log may not move its 2-year hold earlier", () => {
  const plusYears = (s, n) => `${Number(s.slice(0, 4)) + n}${s.slice(4)}`;
  const nextDay = (d) => ymd(Date.parse(`${d}T00:00:00Z`) + DAY);
  const FALLBACK_HOLD = plusYears(nextDay(RECENT), 2);
  const DAY_BEFORE_HOLD = ymd(Date.parse(`${FALLBACK_HOLD}T00:00:00Z`) - DAY);

  it("moving a stored retainUntil earlier on an unreviewed log is denied", async () => {
    const u = makeLog("U", { retainUntil: IN_THREE_YEARS });
    await seed([u]);
    await assertFails(putLog(TECH, { ...u, retainUntil: IN_TWO_YEARS }));
    await seed([u]);
    await assertFails(putLog(OFFICE, { ...u, retainUntil: THREE_YEARS_AGO }));
  });

  it("backdating dateUsed and createdAt on a held unreviewed log without retainUntil is denied", async () => {
    const u = makeLog("U");
    await seed([u]);
    await assertFails(putLog(TECH, { ...u, dateUsed: THREE_YEARS_AGO, createdAt: `${THREE_YEARS_AGO}T15:00:00.000Z` }));
    await seed([u]);
    await assertFails(putLog(OFFICE, { ...u, createdAt: `${THREE_YEARS_AGO}T15:00:00.000Z` }));
  });

  it("stripping retainUntil and backdating dateUsed/createdAt is denied", async () => {
    const u = makeLog("U", { retainUntil: IN_THREE_YEARS });
    const { retainUntil, ...stripped } = u;
    await seed([u]);
    await assertFails(putLog(TECH, stripped));
    await seed([u]);
    await assertFails(putLog(TECH, { ...stripped, dateUsed: THREE_YEARS_AGO, createdAt: `${THREE_YEARS_AGO}T15:00:00.000Z` }));
  });

  it("two-write dodge (backdate in write 1, then remove in write 2) is blocked at write 1", async () => {
    const r = reviewed(makeLog("R"));
    const u = makeLog("U");
    await seed([u, r]);
    await assertFails(putLog(TECH, { ...u, dateUsed: THREE_YEARS_AGO, createdAt: `${THREE_YEARS_AGO}T15:00:00.000Z`, retainUntil: THREE_YEARS_AGO }));
    await assertFails(delLog(TECH, "U"));
  });

  it("editing non-date fields on a held unreviewed log (with or without retainUntil) passes", async () => {
    const u1 = makeLog("U");
    await seed([u1]);
    await assertSucceeds(putLog(TECH, { ...u1, targetPestOrPurpose: "Roaches", serviceAddress: "9 Elm St", poleLocation: "Rear" }));
    const u2 = makeLog("U", { retainUntil: IN_THREE_YEARS });
    await seed([u2]);
    await assertSucceeds(putLog(TECH, { ...u2, targetPestOrPurpose: "Roaches", serviceAddress: "9 Elm St" }));
  });

  it("moving dateUsed earlier while keeping or ratcheting retainUntil (stampRetainUntil) passes", async () => {
    const u1 = makeLog("U", { retainUntil: IN_THREE_YEARS });
    await seed([u1]);
    await assertSucceeds(putLog(TECH, { ...u1, dateUsed: THREE_YEARS_AGO }));
    const u2 = makeLog("U");
    await seed([u2]);
    await assertSucceeds(putLog(TECH, { ...u2, dateUsed: THREE_YEARS_AGO, retainUntil: FALLBACK_HOLD }));
  });

  it("moving dateUsed later and moving retainUntil later (or keeping no retainUntil) passes", async () => {
    const laterDate = nextDay(RECENT);
    const u1 = makeLog("U", { retainUntil: FALLBACK_HOLD });
    await seed([u1]);
    await assertSucceeds(putLog(TECH, { ...u1, dateUsed: laterDate, retainUntil: IN_THREE_YEARS }));
    const u2 = makeLog("U");
    await seed([u2]);
    await assertSucceeds(putLog(TECH, { ...u2, dateUsed: laterDate }));
  });

  it("adding retainUntil to a log that lacked it requires retainUntil >= its computed fallback hold", async () => {
    const u = makeLog("U");
    await seed([u]);
    await assertSucceeds(putLog(TECH, { ...u, retainUntil: FALLBACK_HOLD }));
    await seed([u]);
    await assertSucceeds(putLog(TECH, { ...u, retainUntil: IN_THREE_YEARS }));
    await seed([u]);
    await assertFails(putLog(TECH, { ...u, retainUntil: DAY_BEFORE_HOLD }));
  });
});

describe("#215: migrating legacy shop docs that still carry a logs array", () => {
  it("dropping a legacy reviewed or held unreviewed log from shops/{shopId}.logs without migrating it to logs/{logId} is denied", async () => {
    const r = reviewed(makeLog("R"));
    const u = makeLog("U");
    await seedLegacy([r, u]);
    await assertFails(putShopDoc(TECH, []));
    await assertFails(putShopDoc(OFFICE, [u]));
    await assertFails(putShopDoc(TECH, [r]));
  });

  it("planting a forged copy at logs/R while R is still in the legacy logs array is denied", async () => {
    const r = reviewed(makeLog("R"));
    const forged = makeLog("R", { serviceAddress: "Forged" });
    await seedLegacy([r]);
    await assertFails(putLog(TECH, forged));
    // Even if the legacy array already contained [forged, r], creating logs/R with the unreviewed forged copy is denied.
    await seedLegacy([forged, r]);
    await assertFails(putLog(TECH, forged));
    await assertSucceeds(putLog(TECH, r));
  });

  it("migrating legacy logs to shops/{shopId}/logs/{logId} and then clearing shops/{shopId}.logs passes", async () => {
    const r = reviewed(makeLog("R"));
    const u = makeLog("U");
    await seedLegacy([r, u]);
    await assertSucceeds(putLog(TECH, r));
    await assertSucceeds(putLog(TECH, u));
    await assertSucceeds(putShopDoc(TECH, []));
  });

  it("migrating a legacy array with duplicate losers (reviewed winner or unreviewed winner) and clearing shops/{shopId}.logs passes", async () => {
    const r = reviewed(makeLog("R"));
    const rLoser = makeLog("R", { serviceAddress: "Unreviewed duplicate" });
    const u = makeLog("U", { updatedAt: `${RECENT}T16:00:00.000Z` });
    const uLoser = makeLog("U", { serviceAddress: "Older duplicate", retainUntil: IN_FOUR_YEARS });
    await seedLegacy([rLoser, r, uLoser, u]);
    await assertSucceeds(putLog(TECH, r));
    await assertSucceeds(putLog(TECH, u));
    await assertSucceeds(putShopDoc(TECH, []));
  });

  it("#212: when a legacy array holds two conflicting reviewed copies of R, the losing reviewed copy cannot be dropped", async () => {
    const rEarly = reviewed(makeLog("R", { serviceAddress: "100 Main St" }), {
      reviewedAt: "2026-10-01T18:00:00-05:00",
      reviewedBy: "Ana Office",
    });
    const rLate = reviewed(makeLog("R", { serviceAddress: "200 Oak Ave" }), {
      reviewedAt: "2026-10-02T18:00:00-05:00",
      reviewedBy: "Ben Office",
    });
    const u = makeLog("U");
    await seedLegacy([rLate, rEarly, u]);
    await assertSucceeds(putLog(TECH, rLate));
    await assertSucceeds(putLog(TECH, u));
    // Dropping rEarly is denied because logs/R holds rLate (different review stamp, same revision 0).
    await assertFails(putShopDoc(TECH, []));
    // Draining rLate and u while keeping rEarly in shops/{shopId}.logs passes.
    await assertSucceeds(putShopDoc(TECH, [rEarly]));
  });

  it("draining a legacy array where stored entries omit history passes when kept entries preserve exact raw shape", async () => {
    const { history: _h1, ...rawLate } = reviewed(makeLog("R", { serviceAddress: "200 Oak Ave" }), {
      reviewedAt: "2026-10-02T18:00:00-05:00",
      reviewedBy: "Ben Office",
    });
    const { history: _h2, ...rawEarly } = reviewed(makeLog("R", { serviceAddress: "100 Main St" }), {
      reviewedAt: "2026-10-01T18:00:00-05:00",
      reviewedBy: "Ana Office",
    });
    const { history: _h3, ...rawU } = makeLog("U");
    await seedLegacy([rawLate, rawEarly, rawU]);
    await assertSucceeds(putLog(TECH, rawLate));
    await assertSucceeds(putLog(TECH, rawU));
    // Rewriting the kept rawEarly with normalized history: [] is denied because it does not match resource.data.logs[1].
    await assertFails(putShopDoc(TECH, [{ ...rawEarly, history: [] }]));
    // Preserving the exact raw shape of rawEarly passes.
    await assertSucceeds(putShopDoc(TECH, [rawEarly]));
  });

    it("removing an expired unreviewed log from shops/{shopId}.logs without creating a subcollection doc passes", async () => {
    const r = reviewed(makeLog("R"));
    const expired = oldLog("OLD");
    await seedLegacy([r, expired]);
    await assertSucceeds(putLog(TECH, r));
    await assertSucceeds(putShopDoc(TECH, []));
  });

  it("draining >8 legacy entries in one shops/{shopId} write is denied, but draining in 8-entry batches passes", async () => {
    const legacy = Array.from({ length: 20 }, (_, i) => (i < 5 ? reviewed(makeLog(`L${i}`)) : makeLog(`L${i}`)));
    await seedLegacy(legacy);
    for (const log of legacy) {
      await assertSucceeds(putLog(TECH, log));
    }
    // Removing all 20 in one write is denied (exceeds 8-entry per-write cap).
    await assertFails(putShopDoc(TECH, []));
    // Batch 1 removes L0..L7 (12 remain).
    await assertSucceeds(putShopDoc(TECH, legacy.slice(8)));
    // Batch 2 removes L8..L15 (4 remain).
    await assertSucceeds(putShopDoc(TECH, legacy.slice(16)));
    // Batch 3 removes L16..L19 (0 remain).
    await assertSucceeds(putShopDoc(TECH, []));
    // Once drained, creating a brand-new log in the subcollection passes.
    await assertSucceeds(putLog(TECH, makeLog("N")));
  });

  it("with >8 (e.g. 20) remaining legacy entries, creating a brand-new log passes while planting a forged copy of a reviewed legacy ID at index >= 8 is denied", async () => {
    const forgedR = makeLog("R15", { serviceAddress: "Forged unreviewed copy" });
    const legacy = Array.from({ length: 20 }, (_, i) =>
      i === 15 ? reviewed(makeLog("R15")) : reviewed(makeLog(`L${i}`)),
    );
    // Even if forgedR is also in legacy at index 0 while reviewed R15 is at index 15:
    await seedLegacy([forgedR, ...legacy]);
    // Creating a brand-new log ID not in legacy passes even with 21 legacy entries remaining!
    await assertSucceeds(putLog(TECH, makeLog("BRAND_NEW")));
    // Planting an unreviewed copy for R15 (whose reviewed copy is at index 16) is denied!
    await assertFails(putLog(TECH, forgedR));
    await assertFails(putLog(TECH, makeLog("R15", { serviceAddress: "Not in legacy" })));
    // Creating the reviewed copy R15 passes!
    await assertSucceeds(putLog(TECH, legacy[15]));
  });
});

describe("a stray logIds field neither blocks nor is required", () => {
  it("normal shop updates without logIds, and with a stale one, pass on a doc that carries it", async () => {
    const r = reviewed(makeLog("R"));
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "shops", SHOP), { ...shopDoc([]), logIds: ["R", "U"] });
      await setDoc(doc(db, "shops", SHOP, "logs", "R"), r);
    });
    await assertSucceeds(putShopDoc(TECH, [])); // omits logIds
    await assertSucceeds(putShopDoc(TECH, [], { logIds: ["R", "U"] })); // keeps logIds
    await assertSucceeds(putLog(OFFICE, correct(r, { serviceAddress: "9 Elm St" })));
  });
});
