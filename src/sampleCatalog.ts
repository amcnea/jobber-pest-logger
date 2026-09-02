import type { SampleProduct } from "./types";

/**
 * SAMPLE catalog only. Not scraped from EPA. Not real registration numbers.
 * EPA # is always chosen from this list — never free-typed.
 */
export const SAMPLE_CATALOG: SampleProduct[] = [
  {
    id: "sample-rtu-residual",
    name: "Sample Residual RTU Spray",
    epaRegNo: "SAMPLE-0001",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "sample-granular-bait",
    name: "Sample Granular Bait",
    epaRegNo: "SAMPLE-0002",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "sample-concentrate",
    name: "Sample Mixable Concentrate",
    epaRegNo: "SAMPLE-0003",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "sample-25b",
    name: "Sample 25(b) Essential Oil Blend",
    epaRegNo: null,
    is25b: true,
    kind: "pesticide",
  },
  {
    id: "sample-ilt",
    name: "Sample Insect Light Trap",
    epaRegNo: null,
    is25b: false,
    kind: "device",
  },
  {
    id: "sample-rodent-station",
    name: "Sample Tamper-Resistant Bait Station",
    epaRegNo: null,
    is25b: false,
    kind: "device",
  },
];

export const AMOUNT_UNITS = ["fl oz", "gal", "oz", "lb", "each"] as const;
