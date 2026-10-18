// Deterministic uncorrected logs for export regression goldens (not imported by app code).
import type { ApplicationLog, AppliedProduct } from "../types";
import { makeApplied, makeLog } from "./fixtures";

const termite = (over: Partial<ApplicationLog["termite"]> = {}): ApplicationLog["termite"] => ({
  areaTreatedSqFt: "",
  isBait: false,
  physicalBarrierMeasurement: "",
  diagramNote: "",
  isCommercialPretreat: false,
  tankCount: "",
  tankGallons: "",
  startTime: "",
  stopTime: "",
  ...over,
});

const p = (over: Partial<AppliedProduct>) => makeApplied(over);

/** A spread of shapes: RTU, 25(b), mixed, devices, example seed, termite + pretreat, Jobber, formula-like text. */
export function uncorrectedExportLogs(): ApplicationLog[] {
  return [
    makeLog({ id: "u1", jobberJobNumber: "J-100", jobberAddress: "100 Main St, Austin" }),
    makeLog({
      id: "u2",
      dateUsed: "2026-09-02",
      serviceAddress: "=HYPERLINK(\"x\")",
      customerBillingName: "O'Brien, \"Pat\"",
      products: [
        p({ lineId: "a", name: "Bifen", epaRegNo: "279-3206", rtuAmount: "16", rtuUnit: "fl oz" }),
        p({ lineId: "b", name: "Cedar oil", epaRegNo: null, is25b: true, rtuAmount: "1", rtuUnit: "gal" }),
        p({
          lineId: "c",
          name: "Concentrate",
          method: "mixed",
          rtuAmount: "",
          mixingRate: "1 oz / gal",
          percentAi: "0.06",
          mixedTotal: "2",
          mixedUnit: "gal",
        }),
        p({ lineId: "d", name: "Monitor", method: "device", epaRegNo: null, rtuAmount: "", deviceCount: "4" }),
      ],
    }),
    makeLog({
      id: "u3",
      dateUsed: "2026-09-03",
      sampleData: true,
      products: [p({ lineId: "e", catalogId: "example-rtu-insecticide", name: "Example RTU insecticide", epaRegNo: null, isExample: true })],
    }),
    makeLog({
      id: "u4",
      dateUsed: "2026-09-04",
      poleLocation: "Pole 7",
      isTermite: true,
      termite: termite({
        areaTreatedSqFt: "1200",
        physicalBarrierMeasurement: "140 linear ft",
        diagramNote: "north wall\nand slab",
        isCommercialPretreat: true,
        tankCount: "2",
        tankGallons: "100",
        startTime: "08:00",
        stopTime: "10:30",
      }),
    }),
    makeLog({ id: "u5", dateUsed: "2026-09-05", isTermite: true, termite: termite({ isBait: true, diagramNote: "" }) }),
  ];
}
