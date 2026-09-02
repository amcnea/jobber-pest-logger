import { logHasExampleProducts } from "./catalog";
import { newId } from "./ids";
import type { ApplicationLog, AppliedProduct, ShopProduct, TermiteExtras } from "./types";

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

function localDateYmd(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function emptyLog(): ApplicationLog {
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
    shopTpclNumber: "",
    shopTpclLetter: "",
    isTermite: false,
    termite: emptyTermite(),
  };
}

export interface FieldErrors {
  [key: string]: string;
}

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
  return errors;
}

export function withSaveFlags(log: ApplicationLog): ApplicationLog {
  return {
    ...log,
    createdAt: new Date().toISOString(),
    sampleData: logHasExampleProducts(log.products),
  };
}