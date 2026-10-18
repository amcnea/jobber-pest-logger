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

// ---- #214: paired replacement must exist and keep the id -------------------------------
// (A new entry that reuses a stored id in front of R is a known rules gap, #215; the
// client handles it on read in #211 / #212.)

describe("#214: paired replacement of a reviewed log", () => {
  it("a valid-looking correction under another id is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    await assertFails(put(TECH, [{ ...correct(r, { serviceAddress: "9 Elm St" }), id: "X" }]));
  });

  it("a forged copy in R's slot is denied, even with a valid correction under another id in front", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r, makeLog("U")]);
    await assertFails(put(TECH, [{ ...correct(r, { serviceAddress: "9 Elm St" }), id: "N" }, { ...r, serviceAddress: "Forged" }, makeLog("U")]));
  });

  it("deleting a reviewed log (pair index out of range) is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([makeLog("U"), r]);
    await assertFails(put(TECH, [makeLog("U")]));
    await seed([r]);
    await assertFails(put(TECH, []));
  });

  it("fake behind R: R overwritten, its correction pushed to the front, is denied", async () => {
    const r = reviewed(makeLog("R"));
    await seed([r]);
    const fixed = correct(r, { serviceAddress: "9 Elm St" });
    await assertFails(put(TECH, [fixed, { ...r, serviceAddress: "Forged" }]));
  });

  it("the genuine correction (same id, in place) still passes", async () => {
    const r = reviewed(makeLog("R"));
    await seed([makeLog("U"), r]);
    await assertSucceeds(put(OFFICE, [makeLog("N"), makeLog("U"), correct(r, { serviceAddress: "9 Elm St" })]));
  });
});

// ---- Bundle #218: a `logIds` field is ignored -----------------------------------------

describe("a stray logIds field neither blocks nor is required", () => {
  it("normal saves without logIds, and with a stale one, pass on a doc that carries it", async () => {
    const r = reviewed(makeLog("R"));
    const logs = [r, makeLog("U")];
    const seedWithIds = () =>
      env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "shops", SHOP), { ...shopDoc(logs), logIds: ["R", "U"] });
      });
    await seedWithIds();
    await assertSucceeds(put(TECH, [makeLog("N"), ...logs])); // omits logIds
    await seedWithIds();
    await assertSucceeds(put(TECH, [makeLog("N"), ...logs], { logIds: ["R", "U"] })); // stale
    await seedWithIds();
    await assertSucceeds(put(OFFICE, [correct(r, { serviceAddress: "9 Elm St" }), makeLog("U")], { logIds: ["junk"] }));
    await seedWithIds();
    await assertSucceeds(put(TECH, logs, { logIds: ["X"] })); // logs untouched, index changed
  });

  it("the review lock still applies on a doc with logIds", async () => {
    const r = reviewed(makeLog("R"));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "shops", SHOP), { ...shopDoc([r]), logIds: ["R"] });
    });
    await assertFails(put(TECH, [{ ...r, serviceAddress: "Forged" }], { logIds: ["R"] }));
  });

  it("a member adding logIds doesn't block the next save", async () => {
    await seed([makeLog("U")]);
    await assertSucceeds(put(TECH, [makeLog("U")], { logIds: ["U"] }));
    await assertSucceeds(put(TECH, [makeLog("N"), makeLog("U")]));
  });
});

describe("per-write limits (measured)", () => {
  it("35 unreviewed edits, 3 corrections and 4 re-sends in one write pass on a 100-log doc", async () => {
    const rec = { reuploadedAt: "2026-10-02T08:00:00-05:00", reuploadedBy: "Ana Office", reason: "x" };
    const base = Array.from({ length: 100 }, (_, i) => (i < 10 ? reviewed(makeLog(`L${i}`, { reuploads: [rec] })) : makeLog(`L${i}`)));
    await seed(base);
    await assertSucceeds(put(TECH, base.map((l, i) => (i >= 10 && i < 45 ? { ...l, targetPestOrPurpose: "Roaches" } : l))));
    await seed(base);
    await assertSucceeds(put(TECH, base.map((l, i) => (i < 3 ? correct(l, { serviceAddress: "9 Elm St" }) : l))));
    await seed(base);
    await assertSucceeds(put(TECH, base.map((l, i) => (i < 4 ? { ...l, reuploads: [rec, rec] } : l))));
  });
});
