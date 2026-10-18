// Firestore rules: review lock on shared logs (#162). Runs against the emulator:
//   cd rules-tests && npm ci && npm test   (Java 21+)
// Writes mirror the client: RemoteShopStore.putShop sets the whole shops/{shopId} doc,
// and logOutbox / mergeLogIntoSet replaces a log in place or prepends a new one.
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

const SHOP = "SHOP162";
const OFFICE = "uid-office";
const TECH = "uid-tech";
const STRANGER = "uid-stranger";

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-jpl-rules",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

// ---- fixtures (shapes as normalizeLog / buildCorrection / buildReupload write them) ----

function makeLog(id, extra = {}) {
  return {
    id,
    createdAt: "2026-10-01T15:00:00.000Z",
    sampleData: false,
    jobberJobNumber: "",
    jobberAddress: "",
    customerBillingName: "Pat Customer",
    customerBillingAddress: "1 Main St",
    serviceAddress: "1 Main St",
    poleLocation: "",
    products: [
      {
        lineId: "p1",
        catalogId: "cat-1",
        name: "Talstar P",
        epaRegNo: "279-3206",
        method: "spray",
        rtuAmount: "1 gal",
      },
    ],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-10-01",
    personnel: [{ role: "applying", name: "Ana Office", licenseNumber: "TX-9" }],
    shopTpclNumber: "1",
    shopTpclLetter: "",
    isTermite: false,
    termite: {
      areaTreatedSqFt: "",
      isBait: false,
      physicalBarrierMeasurement: "",
      diagramNote: "",
      isCommercialPretreat: false,
      tankCount: "",
      tankGallons: "",
      startTime: "",
      stopTime: "",
    },
    revision: 0,
    history: [],
    ...extra,
  };
}

function reviewed(log) {
  return { ...log, reviewedAt: "2026-10-02T09:00:00-05:00", reviewedBy: "Ana Office" };
}

/** Same as storage.buildCorrection: snapshot without history / reuploads / retainUntil. */
function correct(prev, fields, entryOverrides = {}) {
  const { history = [], reuploads, retainUntil, ...priorSnapshot } = prev;
  const revision = (prev.revision ?? history.length) + 1;
  const entry = {
    revision,
    priorSnapshot,
    changedAt: "2026-10-03T10:00:00-05:00",
    changedBy: "Ana Office",
    reason: "Wrong address",
    changes: Object.keys(fields).map((f) => ({ field: f, old: prev[f] ?? null, new: fields[f] })),
    ...entryOverrides,
  };
  return {
    ...prev,
    ...fields,
    revision,
    history: [...history, entry],
    ...(reuploads ? { reuploads } : {}),
    ...(retainUntil ? { retainUntil } : {}),
  };
}

function shopDoc(logs) {
  return {
    version: "1",
    updatedAt: "2026-10-17T12:00:00.000Z",
    logs,
    catalog: [],
    people: [{ id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" }],
    settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
    pinsConfigured: true,
    ownerUid: OFFICE,
    members: { [OFFICE]: "office", [TECH]: "tech" },
  };
}

async function seed(logs) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "shops", SHOP), shopDoc(logs));
  });
}

/** Client-style whole-doc put (RemoteShopStore.putWithCas → transaction.set). */
function put(uid, logs, extra = {}) {
  const db = env.authenticatedContext(uid).firestore();
  return setDoc(doc(db, "shops", SHOP), {
    ...shopDoc(logs),
    updatedAt: "2026-10-17T12:05:00.000Z",
    ...extra,
  });
}

const WRITERS = [
  ["tech", TECH],
  ["office", OFFICE],
];

// ---- tests ----

describe("reviewed log: overwrite and delete are denied", () => {
  for (const [who, uid] of WRITERS) {
    it(`${who}: plain overwrite of a reviewed log (same revision, changed value) is denied`, async () => {
      const r = reviewed(makeLog("R"));
      await seed([r, makeLog("U")]);
      await assertFails(put(uid, [{ ...r, serviceAddress: "9 Elm St" }, makeLog("U")]));
    });

    it(`${who}: deleting a reviewed log from the shop is denied`, async () => {
      const r = reviewed(makeLog("R"));
      await seed([r, makeLog("U")]);
      await assertFails(put(uid, [makeLog("U")]));
    });
  }

  it("removing the review stamp is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    const { reviewedAt, reviewedBy, ...unstamped } = r;
    await assertFails(put(TECH, [unstamped]));
  });

  it("replacing a reviewed log with a different id in its place is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    await assertFails(put(TECH, [makeLog("X")]));
  });

  it("dropping the logs field entirely is denied when a reviewed log exists", async () => {
    await seed([reviewed(makeLog("R"))]);
    const db = env.authenticatedContext(OFFICE).firestore();
    const { logs, ...rest } = shopDoc([]);
    await assertFails(setDoc(doc(db, "shops", SHOP), rest));
  });

  it("deleting the shop doc stays denied", async () => {
    await seed([reviewed(makeLog("R"))]);
    await assertFails(deleteDoc(doc(env.authenticatedContext(OFFICE).firestore(), "shops", SHOP)));
  });
});

describe("reviewed log: a proper correction is allowed", () => {
  for (const [who, uid] of WRITERS) {
    it(`${who}: revision +1, prior snapshot appended, reason and changedBy`, async () => {
      const r = reviewed(makeLog("R"));
      await seed([makeLog("U"), r]);
      await assertSucceeds(put(uid, [makeLog("U"), correct(r, { serviceAddress: "9 Elm St" })]));
    });
  }

  it("a second correction on top of the first", async () => {
    const r = reviewed(makeLog("R"));
    const first = correct(r, { serviceAddress: "9 Elm St" });
    await seed([first]);
    await assertSucceeds(put(TECH, [correct(first, { targetPestOrPurpose: "Roaches" }, { reason: "Wrong pest" })]));
  });

  it("keeps re-upload records and a stored hold (hold may move later)", async () => {
    const r = reviewed(
      makeLog("R", {
        reuploads: [{ reuploadedAt: "2026-10-02T08:00:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" }],
        retainUntil: "2028-10-01",
      }),
    );
    await seed([r]);
    await assertSucceeds(put(TECH, [correct(r, { serviceAddress: "9 Elm St" })]));
    await seed([r]);
    await assertSucceeds(put(TECH, [{ ...correct(r, { serviceAddress: "9 Elm St" }), retainUntil: "2029-01-01" }]));
  });

  it("a reviewed log without a stored revision (revision = history length)", async () => {
    const { revision, ...noRev } = reviewed(makeLog("R"));
    await seed([noRev]);
    await assertSucceeds(put(TECH, [correct(noRev, { serviceAddress: "9 Elm St" })]));
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
      await assertFails(put(TECH, [build(base())]));
    });
  }

  it("rewriting earlier history entries", async () => {
    const first = correct(base(), fix);
    await seed([first]);
    const second = correct(first, { targetPestOrPurpose: "Roaches" });
    second.history = [{ ...second.history[0], reason: "edited later" }, second.history[1]];
    await assertFails(put(TECH, [second]));
  });
});

describe("reviewed log: same-revision re-sends", () => {
  it("an unchanged re-send passes", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    await assertSucceeds(put(TECH, [r]));
  });

  it("a later retainUntil hold passes; an earlier or removed one is denied", async () => {
    const r = reviewed(makeLog("R", { retainUntil: "2028-10-01" }));
    await seed([r]);
    await assertSucceeds(put(TECH, [{ ...r, retainUntil: "2029-01-01" }]));
    await seed([r]);
    await assertFails(put(TECH, [{ ...r, retainUntil: "2027-01-01" }]));
    await seed([r]);
    const { retainUntil, ...noHold } = r;
    await assertFails(put(TECH, [noHold]));
  });

  it("an appended re-upload record passes; dropping one is denied", async () => {
    const rec = { reuploadedAt: "2026-10-02T08:00:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" };
    const r = reviewed(makeLog("R", { reuploads: [rec] }));
    await seed([r]);
    await assertSucceeds(put(TECH, [{ ...r, reuploads: [rec, { ...rec, reason: "Again" }] }]));
    await seed([r]);
    await assertFails(put(TECH, [{ ...r, reuploads: [] }]));
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
    await assertSucceeds(put(TECH, [reup, makeLog("U")]));
  });

  it("re-upload into a shop doc with no logs yet", async () => {
    await seed([]);
    const reup = makeLog("R", {
      reuploads: [{ reuploadedAt: "2026-10-17T20:40:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" }],
    });
    await assertSucceeds(put(TECH, [reup]));
  });
});

describe("unreviewed logs behave as before", () => {
  for (const [who, uid] of WRITERS) {
    it(`${who}: overwrite, delete and add are allowed`, async () => {
      await seed([makeLog("U1"), makeLog("U2")]);
      await assertSucceeds(put(uid, [makeLog("N"), { ...makeLog("U1"), serviceAddress: "9 Elm St" }, makeLog("U2")]));
      await assertSucceeds(put(uid, [makeLog("N"), makeLog("U2")]));
    });
  }

  it("office review action (sets reviewedAt / reviewedBy) is allowed", async () => {
    await seed([makeLog("U")]);
    await assertSucceeds(put(OFFICE, [reviewed(makeLog("U"))]));
  });

  it("a reviewed log in the shop doesn't block edits to unreviewed ones", async () => {
    const r = reviewed(makeLog("R"));
    await seed([makeLog("U"), r]);
    await assertSucceeds(put(TECH, [{ ...makeLog("U"), serviceAddress: "9 Elm St" }, r]));
    await assertSucceeds(put(TECH, [r]));
  });

  it("a stranger still can't write", async () => {
    await seed([makeLog("U")]);
    await assertFails(put(STRANGER, [makeLog("U"), makeLog("N")]));
  });
});

describe("outbox flush (several logs in one write)", () => {
  it("new logs prepended + a correction + unreviewed edits pass", async () => {
    const r = reviewed(makeLog("R"));
    await seed([makeLog("U1"), r, makeLog("U2")]);
    await assertSucceeds(
      put(TECH, [
        makeLog("N1"),
        makeLog("N2"),
        { ...makeLog("U1"), targetPestOrPurpose: "Roaches" },
        correct(r, { serviceAddress: "9 Elm St" }),
        { ...makeLog("U2"), targetPestOrPurpose: "Fleas" },
      ]),
    );
  });

  it("new logs prepended + an overwrite of a reviewed log is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([makeLog("U1"), r]);
    await assertFails(put(TECH, [makeLog("N1"), makeLog("U1"), { ...r, serviceAddress: "9 Elm St" }]));
  });

  it("three corrections of reviewed logs in one write pass", async () => {
    const rs = ["R1", "R2", "R3"].map((id) => reviewed(makeLog(id)));
    await seed([...rs, makeLog("U")]);
    await assertSucceeds(put(TECH, [makeLog("N"), ...rs.map((r) => correct(r, { serviceAddress: "9 Elm St" })), makeLog("U")]));
  });

  it("large shop: a correction plus 20 unreviewed edits pass; more than 40 changed logs in one write is denied", async () => {
    const logs = [];
    for (let i = 0; i < 200; i++) logs.push(i % 10 === 0 ? reviewed(makeLog(`L${i}`)) : makeLog(`L${i}`));
    await seed(logs);
    let edits = 0;
    const next = logs.map((l, i) =>
      i === 0 ? correct(l, { serviceAddress: "9 Elm St" }) : i % 10 !== 0 && edits++ < 20 ? { ...l, targetPestOrPurpose: "Roaches" } : l,
    );
    await assertSucceeds(put(TECH, [makeLog("N1"), ...next]));
    await seed(logs);
    edits = 0;
    const tooMany = logs.map((l, i) => (i % 10 !== 0 && edits++ < 41 ? { ...l, targetPestOrPurpose: "Roaches" } : l));
    await assertFails(put(TECH, tooMany));
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
    const logs = [reviewed(makeLog("R")), makeLog("U")];
    await seed(logs);
    await assertSucceeds(put(OFFICE, logs, { settings: { shopName: "Acme 2", shopTpclNumber: "1", shopTpclLetter: "" } }));
  });

  it("members can still read", async () => {
    await seed([reviewed(makeLog("R"))]);
    await assertSucceeds(getDoc(doc(env.authenticatedContext(TECH).firestore(), "shops", SHOP)));
  });
});

// ---- #214: a new entry may not reuse a stored id (log id index) ------------------------

const ids = (logs) => logs.map((l) => l.id);

/** Doc that already carries the id index (`logIds`), as the client keeps it. */
async function seedIndexed(logs) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "shops", SHOP), { ...shopDoc(logs), logIds: ids(logs) });
  });
}

/** Put with the index the client would write (or a forged one). */
function putIndexed(uid, logs, logIds = ids(logs)) {
  return put(uid, logs, { logIds });
}

describe("#214: paired replacement must exist and keep the id", () => {
  it("a reviewed log replaced by a valid-looking correction under another id is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    await assertFails(put(TECH, [{ ...correct(r, { serviceAddress: "9 Elm St" }), id: "X" }]));
  });

  it("[Fake{id R}, R'] (correction paired with the fake's slot) is denied once indexed", async () => {
    const r = reviewed(makeLog("R"));
    await seedIndexed([r]);
    const fake = { ...makeLog("R"), serviceAddress: "Forged" };
    const fixed = correct(r, { serviceAddress: "9 Elm St" });
    for (const forged of [["R", "X"], ["X", "R"], ["R", "R"], ["R"]]) {
      await assertFails(putIndexed(TECH, [fake, fixed], forged));
      await assertFails(putIndexed(TECH, [fixed, fake], forged));
    }
  });
});

describe("#214: fake copy of a stored log id is denied (indexed doc)", () => {
  for (const [who, uid] of WRITERS) {
    it(`${who}: fake in front of R is denied, whatever logIds says`, async () => {
      const r = reviewed(makeLog("R"));
      await seedIndexed([r, makeLog("U")]);
      const fake = reviewed({ ...makeLog("R"), serviceAddress: "Forged", revision: 5 });
      const logs = [fake, r, makeLog("U")];
      for (const forged of [["R", "R", "U"], ["X", "R", "U"], ["R", "X", "U"], ["R", "U"], ["R", "U", "X"]]) {
        await assertFails(putIndexed(uid, logs, forged));
      }
      await assertFails(put(uid, logs)); // dropping the index is denied too
    });

    it(`${who}: fake behind R is denied`, async () => {
      const r = reviewed(makeLog("R"));
      await seedIndexed([r]);
      const fake = { ...makeLog("R"), serviceAddress: "Forged" };
      for (const forged of [["R", "R"], ["R", "X"], ["X", "R"], ["R"]]) {
        await assertFails(putIndexed(uid, [r, fake], forged));
      }
    });
  }

  it("an exact second copy of a stored log is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seedIndexed([r]);
    await assertFails(putIndexed(TECH, [r, r], ["R", "X"]));
  });

  it("a fake of an unreviewed stored log is denied too", async () => {
    await seedIndexed([makeLog("U")]);
    await assertFails(putIndexed(TECH, [{ ...makeLog("U"), serviceAddress: "Forged" }, makeLog("U")], ["X", "U"]));
  });
});

describe("#214: duplicate ids among new entries are denied", () => {
  it("indexed doc: two new entries with one id", async () => {
    await seedIndexed([makeLog("U")]);
    const a = makeLog("N");
    const b = { ...makeLog("N"), serviceAddress: "Other" };
    for (const forged of [["N", "X", "U"], ["N", "N", "U"], ["N", "U"]]) {
      await assertFails(putIndexed(TECH, [a, b, makeLog("U")], forged));
      await assertFails(putIndexed(TECH, [a, a, makeLog("U")], forged));
    }
  });

  it("first index write (bootstrap) with duplicate ids is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    const fake = { ...makeLog("R"), serviceAddress: "Forged" };
    await assertFails(putIndexed(TECH, [fake, r], ["R", "X"]));
    await assertFails(putIndexed(TECH, [fake, r], ["R", "R"]));
  });
});

describe("#214: normal writes still pass on an indexed doc", () => {
  it("adding a new unique log", async () => {
    const r = reviewed(makeLog("R"));
    await seedIndexed([r, makeLog("U")]);
    await assertSucceeds(putIndexed(TECH, [makeLog("N"), r, makeLog("U")]));
  });

  it("a correction of a reviewed log (one log per write, #210)", async () => {
    const r = reviewed(makeLog("R"));
    await seedIndexed([makeLog("U"), r]);
    await assertSucceeds(putIndexed(OFFICE, [makeLog("U"), correct(r, { serviceAddress: "9 Elm St" })]));
  });

  it("a re-send (later hold + appended re-upload record) of a reviewed log", async () => {
    const rec = { reuploadedAt: "2026-10-02T08:00:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" };
    const r = reviewed(makeLog("R", { reuploads: [rec] }));
    await seedIndexed([r]);
    await assertSucceeds(putIndexed(TECH, [{ ...r, reuploads: [rec, { ...rec, reason: "Again" }], retainUntil: "2029-01-01" }]));
  });

  it("re-upload of a log the shop no longer has", async () => {
    await seedIndexed([makeLog("U")]);
    const reup = reviewed(
      makeLog("R", {
        reuploads: [{ reuploadedAt: "2026-10-17T20:40:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" }],
      }),
    );
    await assertSucceeds(putIndexed(TECH, [reup, makeLog("U")]));
  });

  it("unreviewed edit and delete; the index must follow the logs", async () => {
    await seedIndexed([makeLog("U1"), makeLog("U2")]);
    await assertSucceeds(putIndexed(TECH, [{ ...makeLog("U1"), serviceAddress: "9 Elm St" }, makeLog("U2")]));
    await assertSucceeds(putIndexed(TECH, [makeLog("U2")]));
    await assertFails(putIndexed(TECH, [makeLog("U1"), makeLog("U2")], ["U2", "X"]));
  });

  it("settings change with logs and index untouched; a forged index alone is denied", async () => {
    const logs = [reviewed(makeLog("R")), makeLog("U")];
    await seedIndexed(logs);
    await assertSucceeds(put(OFFICE, logs, { logIds: ids(logs), settings: { shopName: "Acme 2", shopTpclNumber: "1", shopTpclLetter: "" } }));
    await seedIndexed(logs);
    await assertFails(putIndexed(OFFICE, logs, ["R", "X"]));
  });

  it("large indexed doc (300 logs): one new log or one correction per write passes", async () => {
    const logs = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? reviewed(makeLog(`L${i}`)) : makeLog(`L${i}`)));
    await seedIndexed(logs);
    await assertSucceeds(putIndexed(TECH, [makeLog("N"), ...logs]));
    await seedIndexed(logs);
    await assertSucceeds(putIndexed(OFFICE, logs.map((l, i) => (i === 10 ? correct(l, { serviceAddress: "9 Elm St" }) : l))));
    await seedIndexed(logs);
    await assertFails(putIndexed(TECH, [{ ...makeLog("L20"), serviceAddress: "Forged" }, ...logs], ["X", ...ids(logs)]));
  });

  it("per-write limits on an indexed doc over 64 logs: 8 changed/added logs, 2 corrections, 3 re-sends", async () => {
    const rec = { reuploadedAt: "2026-10-02T08:00:00-05:00", reuploadedBy: "Ana Office", reason: "x" };
    const base = Array.from({ length: 100 }, (_, i) => (i < 10 ? reviewed(makeLog(`L${i}`, { reuploads: [rec] })) : makeLog(`L${i}`)));
    const news = (n) => Array.from({ length: n }, (_, i) => makeLog(`N${i}`));
    await seedIndexed(base);
    await assertSucceeds(putIndexed(TECH, [...news(8), ...base]));
    await seedIndexed(base);
    await assertFails(putIndexed(TECH, [...news(9), ...base]));
    await seedIndexed(base);
    await assertSucceeds(putIndexed(TECH, base.map((l, i) => (i < 2 ? correct(l, { serviceAddress: "9 Elm St" }) : l))));
    await seedIndexed(base);
    await assertSucceeds(putIndexed(TECH, base.map((l, i) => (i < 3 ? { ...l, reuploads: [rec, rec] } : l))));
  });
});

describe("#214: adding the index (first write / create)", () => {
  it("a doc without logIds keeps working without it (older clients)", async () => {
    await seed([makeLog("U")]);
    await assertSucceeds(put(TECH, [makeLog("N"), makeLog("U")]));
  });

  it("adding a matching index is allowed (up to 64 logs); a forged or oversized one is denied", async () => {
    const logs = Array.from({ length: 64 }, (_, i) => makeLog(`L${i}`));
    await seed(logs);
    await assertSucceeds(putIndexed(TECH, logs));
    await seed(logs);
    await assertFails(putIndexed(TECH, logs, [...ids(logs).slice(0, 63), "X"]));
    await seed(logs);
    await assertFails(putIndexed(TECH, logs, ids(logs).reverse()));
    const more = [makeLog("L64"), ...logs];
    await seed(more);
    await assertFails(putIndexed(TECH, more));
  });

  it("adding the index together with a new log", async () => {
    await seed([reviewed(makeLog("R"))]);
    await assertSucceeds(putIndexed(TECH, [makeLog("N"), reviewed(makeLog("R"))]));
  });

  it("create: a matching index is allowed, a forged one is denied", async () => {
    const db = env.authenticatedContext(OFFICE).firestore();
    const logs = [makeLog("A"), makeLog("B")];
    const body = (logIds) => ({ ...shopDoc(logs), auth: { office: "h" }, logIds });
    await assertFails(setDoc(doc(db, "shops", "SHOPNEW1"), body(["A", "A"])));
    await assertFails(setDoc(doc(db, "shops", "SHOPNEW2"), body(["A", "X"])));
    await assertSucceeds(setDoc(doc(db, "shops", "SHOPNEW3"), body(["A", "B"])));
  });
});
