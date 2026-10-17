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
  /** Hidden from New log picker; kept on device for history / unarchive. */
  archived: boolean;
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

/** Office-managed tech roster (v1.1). Separate from application-log personnel rows. */
export interface Person {
  id: string;
  name: string;
  licenseNumber: string;
  /** Default role tags only (multi-select). Each log still has three separate picks. */
  roleTags: PersonnelRole[];
  /** License expiry as device-local YYYY-MM-DD. */
  licenseExpiry: string;
  /** CE due date as device-local YYYY-MM-DD; empty string when not set. */
  ceDueDate: string;
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
  /**
   * Correction-history model (not TDA fields). Optional on the type so older
   * literals still compile; normalizeLog always fills revision (0) and history ([]).
   * Revision starts at 0 for the original record; each applied correction adds 1.
   */
  revision?: number;
  /** One entry per applied correction, oldest first. */
  history?: CorrectionEntry[];
  /** When office marked this log reviewed (ISO with local offset). Reviewed logs are locked. */
  reviewedAt?: string;
  /** Roster person name chosen when marking reviewed. Present iff reviewedAt is. */
  reviewedBy?: string;
}

/** One changed field in a correction. Paths are stable keys, e.g. `products[<lineId>].rtuAmount`. */
export interface FieldChange {
  field: string;
  old: string | number | boolean | null;
  new: string | number | boolean | null;
}

/** Log as it stood before a correction, minus its own history array (kept once, on the log). */
export type LogSnapshot = Omit<ApplicationLog, "history">;

export interface CorrectionEntry {
  /** Revision this correction produced (priorSnapshot.revision + 1). */
  revision: number;
  /** Deep copy of the log before the change; frozen, never mutated. */
  priorSnapshot: Readonly<LogSnapshot>;
  /** ISO with local offset, e.g. 2026-10-17T17:05:00-05:00. */
  changedAt: string;
  /** Roster person name. */
  changedBy: string;
  /** Non-blank after trim. */
  reason: string;
  changes: FieldChange[];
}

export interface ShopSettings {
  shopName: string;
  shopTpclNumber: string;
  shopTpclLetter: string;
}

export type Screen =
  | "new"
  | "history"
  | "review"
  | "products"
  | "people"
  | "settings"
  | "export";
