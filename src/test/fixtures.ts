// Shared test-only fixtures for component tests (not imported by app code).
import type { AppliedProduct, ApplicationLog, ShopProduct } from "../types";

export function makeApplied(over: Partial<AppliedProduct> = {}): AppliedProduct {
  return {
    lineId: "l1",
    catalogId: "talstar",
    name: "Talstar P",
    epaRegNo: "279-3206",
    is25b: false,
    isExample: false,
    method: "rtu",
    rtuAmount: "1",
    rtuUnit: "gal",
    mixingRate: "",
    percentAi: "",
    mixedTotal: "",
    mixedUnit: "",
    deviceCount: "",
    ...over,
  };
}

/** A log that passes validateLog (complete § 7.144(a) record). */
export function makeLog(over: Partial<ApplicationLog> = {}): ApplicationLog {
  return {
    id: "log",
    createdAt: "2026-09-01T15:00:00.000Z",
    sampleData: false,
    jobberJobNumber: "",
    jobberAddress: "",
    customerBillingName: "Pat Customer",
    customerBillingAddress: "1 Billing Rd",
    serviceAddress: "100 Main St",
    poleLocation: "",
    products: [makeApplied()],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-01",
    personnel: [
      { role: "applying", name: "Alice Applicator", licenseNumber: "TX-111" },
      { role: "supervising", name: "", licenseNumber: "" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ],
    shopTpclNumber: "12345",
    shopTpclLetter: "B",
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
    ...over,
  };
}

export function makeShopProduct(over: Partial<ShopProduct> = {}): ShopProduct {
  return {
    id: "talstar",
    name: "Talstar P",
    epaRegNo: "279-3206",
    is25b: false,
    kind: "pesticide",
    isExample: false,
    archived: false,
    ...over,
  };
}
