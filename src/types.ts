/** Locked to 4 TAC § 7.144(a). Do not invent extra TDA-required fields. */

export type ProductKind = "pesticide" | "device";

export type ApplicationMethod = "rtu" | "mixed" | "device";

export interface ShopProduct {
  id: string;
  name: string;
  /** Real EPA # when registered. Null for 25(b), devices, and example seeds. */
  epaRegNo: string | null;
  is25b: boolean;
  kind: ProductKind;
  /** Example catalog seed — exports must not print this as a real EPA number. */
  isExample: boolean;
}

export interface AppliedProduct {
  lineId: string;
  catalogId: string;
  name: string;
  epaRegNo: string | null;
  is25b: boolean;
  isExample: boolean;
  method: ApplicationMethod;
  /** Total amount of RTU pesticide (AI % unchanged). */
  rtuAmount: string;
  rtuUnit: string;
  /** Mixing rate (e.g. oz/gal) when mixed. */
  mixingRate: string;
  /** Percent AI when mixed (alternative to mixing rate). */
  percentAi: string;
  /** Total material applied when mixed. */
  mixedTotal: string;
  mixedUnit: string;
  /** Count of this device. */
  deviceCount: string;
}

export type PersonnelRole = "applying" | "supervising" | "receiving_training";

export interface Personnel {
  role: PersonnelRole;
  name: string;
  licenseNumber: string;
}

export interface TermiteExtras {
  /** Area treated in sq ft. Not required for baits. */
  areaTreatedSqFt: string;
  isBait: boolean;
  /** Physical-barrier measurement. */
  physicalBarrierMeasurement: string;
  /** Text note standing in for a diagram — v1 does not capture a drawing. */
  diagramNote: string;
  isCommercialPretreat: boolean;
  tankCount: string;
  tankGallons: string;
  startTime: string;
  stopTime: string;
}

export interface ApplicationLog {
  id: string;
  createdAt: string;
  /** True when this log used example catalog seeds (not a global SAMPLE watermark). */
  sampleData: boolean;
  /** Optional paste-on to link the Jobber stop. Not a TDA field. */
  jobberJobNumber: string;
  jobberAddress: string;
  customerBillingName: string;
  customerBillingAddress: string;
  serviceAddress: string;
  /** Optional pole location if utility-pole retreatment. */
  poleLocation: string;
  products: AppliedProduct[];
  targetPestOrPurpose: string;
  dateUsed: string;
  personnel: Personnel[];
  shopTpclNumber: string;
  shopTpclLetter: string;
  isTermite: boolean;
  termite: TermiteExtras;
}

export type Screen = "new" | "history" | "products" | "export";
