import { logHasExampleProducts } from "./catalog";
import { localDateYmd } from "./dates";
import { newId } from "./ids";
import type {
  ApplicationLog,
  AppliedProduct,
  Person,
  Personnel,
  PersonnelRole,
  ShopProduct,
  ShopSettings,
  TermiteExtras,
} from "./types";

export function emptyTermite(): TermiteExtras {
  return {
    areaTreatedSqFt: "",
    isBait: false,
    physicalBarrierMeasurement: "",
    diagramNote: "",
    isCommercialPretreat: false,
    tankCount: "",
    tankGallons: "",
    startTime: "",
    stopTime: "",
  };
}

export function productFromCatalog(catalog: ShopProduct[], catalogId: string): AppliedProduct | null {
  const product = catalog.find((p) => p.id === catalogId);
  if (!product) return null;
  const method = product.kind === "device" ? "device" : "rtu";
  const isExample = product.isExample === true;
  return {
    lineId: newId(),
    catalogId: product.id,
    name: product.name,
    epaRegNo: isExample || product.is25b || product.kind === "device" ? null : product.epaRegNo,
    is25b: product.is25b,
    isExample,
    method,
    rtuAmount: "",
    rtuUnit: "fl oz",
    mixingRate: "",
    percentAi: "",
    mixedTotal: "",
    mixedUnit: "gal",
    deviceCount: product.kind === "device" ? "1" : "",
  };
}

export function emptyLog(settings?: ShopSettings | null): ApplicationLog {
  const today = localDateYmd();
  return {
    id: newId(),
    createdAt: new Date().toISOString(),
    sampleData: false,
    jobberJobNumber: "",
    jobberAddress: "",
    customerBillingName: "",
    customerBillingAddress: "",
    serviceAddress: "",
    poleLocation: "",
    products: [],
    targetPestOrPurpose: "",
    dateUsed: today,
    personnel: [
      { role: "applying", name: "", licenseNumber: "" },
      { role: "supervising", name: "", licenseNumber: "" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ],
    shopTpclNumber: settings?.shopTpclNumber ?? "",
    shopTpclLetter: settings?.shopTpclLetter ?? "",
    isTermite: false,
    termite: emptyTermite(),
  };
}

export interface FieldErrors {
  [key: string]: string;
}

/** Human labels for export completeness UI (keys match validateLog). */
export const FIELD_LABELS: Record<string, string> = {
  customerBillingName: "Customer billing name",
  customerBillingAddress: "Customer billing address",
  serviceAddress: "Service address",
  targetPestOrPurpose: "Target pest or purpose",
  dateUsed: "Date used",
  shopTpclNumber: "Shop TPCL number",
  applyingName: "Person applying — name",
  applyingLicense: "Person applying — license number",
  products: "Pesticides / devices",
  termiteArea: "Termite area treated (sq ft)",
  termiteTankCount: "Pretreat tank count",
  termiteTankGallons: "Pretreat tank gallons",
  termiteStart: "Pretreat start time",
  termiteStop: "Pretreat stop time",
};

export function validateLog(log: ApplicationLog): FieldErrors {
  const errors: FieldErrors = {};
  if (!log.customerBillingName.trim()) errors.customerBillingName = "Required";
  if (!log.customerBillingAddress.trim()) errors.customerBillingAddress = "Required";
  if (!log.serviceAddress.trim()) errors.serviceAddress = "Required";
  if (!log.targetPestOrPurpose.trim()) errors.targetPestOrPurpose = "Required";
  if (!log.dateUsed.trim()) errors.dateUsed = "Required";
  if (!log.shopTpclNumber.trim()) errors.shopTpclNumber = "Required";
  const applying = log.personnel.find((p) => p.role === "applying");
  if (!applying?.name.trim()) errors.applyingName = "Required";
  if (!applying?.licenseNumber.trim()) errors.applyingLicense = "Required";
  if (log.products.length === 0) errors.products = "Add at least one pesticide or device from the shop list.";
  log.products.forEach((p, i) => {
    if (!p.name.trim()) {
      errors[`product-${i}-name`] = "Product name required";
    }
    if (p.method === "device" && !p.deviceCount.trim()) {
      errors[`product-${i}-device`] = "Device count required";
    }
    if (p.method === "rtu" && !p.rtuAmount.trim()) {
      errors[`product-${i}-rtu`] = "RTU amount required";
    }
    if (p.method === "mixed") {
      if (!p.mixingRate.trim() && !p.percentAi.trim()) {
        errors[`product-${i}-mix`] = "Enter mixing rate or % AI";
      }
      if (!p.mixedTotal.trim()) {
        errors[`product-${i}-total`] = "Total material applied required";
      }
    }
  });
  if (log.isTermite) {
    if (!log.termite.isBait && !log.termite.areaTreatedSqFt.trim()) {
      errors.termiteArea = "Required for non-bait termite work";
    }
    if (log.termite.isCommercialPretreat) {
      if (!log.termite.tankCount.trim()) errors.termiteTankCount = "Required";
      if (!log.termite.tankGallons.trim()) errors.termiteTankGallons = "Required";
      if (!log.termite.startTime.trim()) errors.termiteStart = "Required";
      if (!log.termite.stopTime.trim()) errors.termiteStop = "Required";
    }
  }
  return errors;
}

export interface ExportCompletenessIssue {
  logId: string;
  dateUsed: string;
  serviceAddress: string;
  fields: string[];
}

/** Empty required § 7.144(a) fields (and termite (b) when flagged) on logs in the export set. */
export function exportCompletenessIssues(logs: ApplicationLog[]): ExportCompletenessIssue[] {
  const issues: ExportCompletenessIssue[] = [];
  for (const log of logs) {
    const errors = validateLog(log);
    const keys = Object.keys(errors);
    if (keys.length === 0) continue;
    const fields = keys.map((k) => {
      if (FIELD_LABELS[k]) return FIELD_LABELS[k];
      if (k.startsWith("product-")) {
        const m = /^product-(\d+)-(.*)$/.exec(k);
        if (m) {
          const idx = Number(m[1]) + 1;
          const part = m[2];
          const partLabel =
            part === "name"
              ? "name"
              : part === "device"
                ? "device count"
                : part === "rtu"
                  ? "RTU amount"
                  : part === "mix"
                    ? "mix rate / % AI"
                    : part === "total"
                      ? "total material applied"
                      : part;
          return `Product line ${idx}: ${partLabel}`;
        }
      }
      return k;
    });
    issues.push({
      logId: log.id,
      dateUsed: log.dateUsed || "(no date)",
      serviceAddress: log.serviceAddress.trim() || "(no service address)",
      fields,
    });
  }
  return issues;
}

/** On edit, keep original createdAt; always refresh sampleData from products. */
export function withSaveFlags(
  log: ApplicationLog,
  options?: { preserveCreatedAt?: boolean },
): ApplicationLog {
  return {
    ...log,
    createdAt: options?.preserveCreatedAt ? log.createdAt : new Date().toISOString(),
    sampleData: logHasExampleProducts(log.products),
  };
}


/** First roster person tagged for each role; empty rows when no default. Does not invent people. */
export function personnelFromRosterDefaults(people: Person[]): Personnel[] {
  const roles: PersonnelRole[] = ["applying", "supervising", "receiving_training"];
  return roles.map((role) => {
    const tagged = people.find((p) => p.roleTags.includes(role));
    if (tagged) {
      return { role, name: tagged.name, licenseNumber: tagged.licenseNumber };
    }
    return { role, name: "", licenseNumber: "" };
  });
}

/** Match filled personnel rows back to roster ids for the New log pickers. */
export function rosterPicksForPersonnel(
  personnel: Personnel[],
  people: Person[],
): Record<PersonnelRole, string> {
  const picks: Record<PersonnelRole, string> = {
    applying: "",
    supervising: "",
    receiving_training: "",
  };
  for (const row of personnel) {
    if (!row.name.trim() && !row.licenseNumber.trim()) continue;
    const match = people.find(
      (p) =>
        p.name.trim() === row.name.trim() &&
        p.licenseNumber.trim() === row.licenseNumber.trim(),
    );
    if (match) picks[row.role] = match.id;
  }
  return picks;
}

/**
 * "Log again here" — property fields only. New id/createdAt, dateUsed = today.
 * Does not invent products, pest, termite, or people.
 */
export type PropertyPrefill = {
  serviceAddress: string;
  customerBillingName: string;
  customerBillingAddress: string;
  poleLocation: string;
  jobberAddress: string;
};

export function draftLogAgainHere(
  property: PropertyPrefill,
  settings?: ShopSettings | null,
): ApplicationLog {
  const base = emptyLog(settings);
  return {
    ...base,
    serviceAddress: property.serviceAddress === "(no service address)" ? "" : property.serviceAddress,
    customerBillingName: property.customerBillingName,
    customerBillingAddress: property.customerBillingAddress,
    poleLocation: property.poleLocation,
    jobberAddress: property.jobberAddress,
    jobberJobNumber: "",
    products: [],
    targetPestOrPurpose: "",
    isTermite: false,
    termite: emptyTermite(),
    personnel: [
      { role: "applying", name: "", licenseNumber: "" },
      { role: "supervising", name: "", licenseNumber: "" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ],
  };
}

/**
 * "Duplicate last stop" — copy products, pest, termite from most recent log at the address.
 * New id/createdAt/dateUsed (today). Personnel from roster defaults or empty.
 * Clears jobberJobNumber so the tech re-attaches; keeps jobberAddress when present.
 */
export function draftDuplicateLastStop(
  last: ApplicationLog,
  people: Person[],
  settings?: ShopSettings | null,
): ApplicationLog {
  const base = emptyLog(settings);
  const products = last.products.map((p) => ({ ...p, lineId: newId() }));
  return {
    ...base,
    serviceAddress: last.serviceAddress,
    customerBillingName: last.customerBillingName,
    customerBillingAddress: last.customerBillingAddress,
    poleLocation: last.poleLocation,
    jobberAddress: last.jobberAddress,
    jobberJobNumber: "",
    products,
    targetPestOrPurpose: last.targetPestOrPurpose,
    isTermite: last.isTermite,
    termite: { ...last.termite },
    personnel: personnelFromRosterDefaults(people),
    sampleData: logHasExampleProducts(products),
  };
}
