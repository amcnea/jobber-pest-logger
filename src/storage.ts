import { EXAMPLE_SEEDS, inferIsExample } from "./catalog";
import { newId } from "./ids";
import type { ApplicationLog, AppliedProduct, Person, PersonnelRole, ShopProduct, ShopSettings } from "./types";

const LOGS_KEY = "jobber-pest-logger:logs:v1";
const CATALOG_KEY = "jobber-pest-logger:catalog:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProductShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.lineId === "string" &&
    typeof value.catalogId === "string" &&
    typeof value.name === "string" &&
    (typeof value.epaRegNo === "string" || value.epaRegNo === null) &&
    typeof value.is25b === "boolean" &&
    (value.method === "rtu" || value.method === "mixed" || value.method === "device") &&
    typeof value.rtuAmount === "string" &&
    typeof value.rtuUnit === "string" &&
    typeof value.mixingRate === "string" &&
    typeof value.percentAi === "string" &&
    typeof value.mixedTotal === "string" &&
    typeof value.mixedUnit === "string" &&
    typeof value.deviceCount === "string" &&
    (typeof value.isExample === "boolean" || value.isExample === undefined)
  );
}

function normalizeProduct(value: unknown): AppliedProduct | null {
  if (!isProductShape(value) || !isRecord(value)) return null;
  const isExample = inferIsExample({
    isExample: typeof value.isExample === "boolean" ? value.isExample : undefined,
    catalogId: typeof value.catalogId === "string" ? value.catalogId : undefined,
    epaRegNo: typeof value.epaRegNo === "string" || value.epaRegNo === null ? value.epaRegNo : undefined,
  });
  const method = value.method as AppliedProduct["method"];
  const is25b = value.is25b as boolean;
  const dropEpa = isExample || method === "device" || is25b;
  return {
    lineId: value.lineId as string,
    catalogId: value.catalogId as string,
    name: value.name as string,
    epaRegNo: dropEpa ? null : ((value.epaRegNo as string | null) ?? null),
    is25b,
    isExample,
    method,
    rtuAmount: value.rtuAmount as string,
    rtuUnit: value.rtuUnit as string,
    mixingRate: value.mixingRate as string,
    percentAi: value.percentAi as string,
    mixedTotal: value.mixedTotal as string,
    mixedUnit: value.mixedUnit as string,
    deviceCount: value.deviceCount as string,
  };
}

function isPersonnel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.role === "applying" ||
      value.role === "supervising" ||
      value.role === "receiving_training") &&
    typeof value.name === "string" &&
    typeof value.licenseNumber === "string"
  );
}

function isTermite(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.areaTreatedSqFt === "string" &&
    typeof value.physicalBarrierMeasurement === "string" &&
    typeof value.diagramNote === "string" &&
    typeof value.tankCount === "string" &&
    typeof value.tankGallons === "string" &&
    typeof value.startTime === "string" &&
    typeof value.stopTime === "string" &&
    typeof value.isBait === "boolean" &&
    typeof value.isCommercialPretreat === "boolean"
  );
}

function isLogShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.serviceAddress === "string" &&
    typeof value.dateUsed === "string" &&
    typeof value.customerBillingName === "string" &&
    typeof value.sampleData === "boolean" &&
    typeof value.isTermite === "boolean" &&
    typeof value.jobberJobNumber === "string" &&
    typeof value.jobberAddress === "string" &&
    typeof value.customerBillingAddress === "string" &&
    typeof value.poleLocation === "string" &&
    typeof value.targetPestOrPurpose === "string" &&
    typeof value.shopTpclNumber === "string" &&
    typeof value.shopTpclLetter === "string" &&
    Array.isArray(value.products) &&
    value.products.every(isProductShape) &&
    Array.isArray(value.personnel) &&
    value.personnel.every(isPersonnel) &&
    isTermite(value.termite)
  );
}

function normalizeLog(value: unknown): ApplicationLog | null {
  if (!isLogShape(value)) return null;
  const rawProducts = value.products as unknown[];
  const products = rawProducts.map(normalizeProduct).filter((p): p is AppliedProduct => p !== null);
  if (products.length !== rawProducts.length) return null;
  return {
    id: value.id as string,
    createdAt: value.createdAt as string,
    sampleData: products.some((p) => p.isExample),
    jobberJobNumber: value.jobberJobNumber as string,
    jobberAddress: value.jobberAddress as string,
    customerBillingName: value.customerBillingName as string,
    customerBillingAddress: value.customerBillingAddress as string,
    serviceAddress: value.serviceAddress as string,
    poleLocation: value.poleLocation as string,
    products,
    targetPestOrPurpose: value.targetPestOrPurpose as string,
    dateUsed: value.dateUsed as string,
    personnel: value.personnel as ApplicationLog["personnel"],
    shopTpclNumber: value.shopTpclNumber as string,
    shopTpclLetter: value.shopTpclLetter as string,
    isTermite: value.isTermite as boolean,
    termite: value.termite as ApplicationLog["termite"],
  };
}

export function loadLogs(): ApplicationLog[] {
  try {
    const raw = localStorage.getItem(LOGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeLog).filter((l): l is ApplicationLog => l !== null);
  } catch {
    return [];
  }
}

export function saveLogs(logs: ApplicationLog[]): boolean {
  try {
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save logs", err);
    return false;
  }
}

export function upsertLog(log: ApplicationLog): { logs: ApplicationLog[]; saved: boolean } {
  const logs = loadLogs();
  const idx = logs.findIndex((l) => l.id === log.id);
  const next = idx === -1 ? [log, ...logs] : logs.map((l) => (l.id === log.id ? log : l));
  const saved = saveLogs(next);
  return { logs: saved ? next : logs, saved };
}

export function deleteLog(id: string): { logs: ApplicationLog[]; saved: boolean } {
  const current = loadLogs();
  const next = current.filter((l) => l.id !== id);
  const saved = saveLogs(next);
  return { logs: saved ? next : current, saved };
}

export function groupLogsByServiceAddress(
  logs: ApplicationLog[],
): { address: string; logs: ApplicationLog[] }[] {
  const map = new Map<string, { address: string; logs: ApplicationLog[] }>();
  for (const log of logs) {
    const address = String(log.serviceAddress ?? "").trim();
    const key = address.toLowerCase() || "(no service address)";
    const existing = map.get(key);
    if (existing) {
      existing.logs.push(log);
    } else {
      map.set(key, {
        address: address || "(no service address)",
        logs: [log],
      });
    }
  }
  return [...map.values()].sort((a, b) => a.address.localeCompare(b.address));
}

function isShopProductShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (typeof value.epaRegNo === "string" || value.epaRegNo === null) &&
    typeof value.is25b === "boolean" &&
    (value.kind === "pesticide" || value.kind === "device") &&
    (typeof value.isExample === "boolean" || value.isExample === undefined)
  );
}

function normalizeShopProduct(value: unknown): ShopProduct | null {
  if (!isShopProductShape(value) || !isRecord(value)) return null;
  const isExample = inferIsExample({
    isExample: typeof value.isExample === "boolean" ? value.isExample : undefined,
    catalogId: typeof value.id === "string" ? value.id : undefined,
    epaRegNo:
      typeof value.epaRegNo === "string" || value.epaRegNo === null
        ? value.epaRegNo
        : undefined,
  });
  const isDevice = value.kind === "device";
  const is25b = isDevice ? false : (value.is25b as boolean);
  return {
    id: value.id as string,
    name: value.name as string,
    epaRegNo: isExample || isDevice || is25b ? null : ((value.epaRegNo as string | null) ?? null),
    is25b,
    kind: value.kind as ShopProduct["kind"],
    isExample,
  };
}

export function saveCatalog(products: ShopProduct[]): boolean {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify(products));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save catalog", err);
    return false;
  }
}

export function loadCatalog(): ShopProduct[] {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (!raw) {
      const seed = EXAMPLE_SEEDS.map((p) => ({ ...p }));
      saveCatalog(seed);
      return seed;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      const seed = EXAMPLE_SEEDS.map((p) => ({ ...p }));
      saveCatalog(seed);
      return seed;
    }
    return parsed.map(normalizeShopProduct).filter((p): p is ShopProduct => p !== null);
  } catch {
    const seed = EXAMPLE_SEEDS.map((p) => ({ ...p }));
    saveCatalog(seed);
    return seed;
  }
}

export function upsertProduct(
  product: ShopProduct,
): { catalog: ShopProduct[]; saved: boolean } {
  const catalog = loadCatalog();
  const idx = catalog.findIndex((p) => p.id === product.id);
  const next = idx === -1 ? [product, ...catalog] : catalog.map((p) => (p.id === product.id ? product : p));
  const saved = saveCatalog(next);
  return { catalog: saved ? next : catalog, saved };
}

export function deleteProduct(id: string): { catalog: ShopProduct[]; saved: boolean } {
  const current = loadCatalog();
  const next = current.filter((p) => p.id !== id);
  const saved = saveCatalog(next);
  return { catalog: saved ? next : current, saved };
}

export function emptyShopProduct(): ShopProduct {
  return {
    id: newId(),
    name: "",
    epaRegNo: null,
    is25b: false,
    kind: "pesticide",
    isExample: false,
  };
}

const PEOPLE_KEY = "jobber-pest-logger:people:v1";

function isPersonnelRole(value: unknown): value is PersonnelRole {
  return value === "applying" || value === "supervising" || value === "receiving_training";
}

function isPersonShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.licenseNumber === "string" &&
    Array.isArray(value.roleTags) &&
    value.roleTags.every(isPersonnelRole) &&
    typeof value.licenseExpiry === "string" &&
    (typeof value.ceDueDate === "string" || value.ceDueDate === undefined || value.ceDueDate === null)
  );
}

function normalizePerson(value: unknown): Person | null {
  if (!isPersonShape(value) || !isRecord(value)) return null;
  const tags = (value.roleTags as unknown[]).filter(isPersonnelRole);
  const unique = [...new Set(tags)];
  return {
    id: value.id as string,
    name: value.name as string,
    licenseNumber: value.licenseNumber as string,
    roleTags: unique,
    licenseExpiry: value.licenseExpiry as string,
    ceDueDate: typeof value.ceDueDate === "string" ? value.ceDueDate : "",
  };
}

export function savePeople(people: Person[]): boolean {
  try {
    localStorage.setItem(PEOPLE_KEY, JSON.stringify(people));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save people", err);
    return false;
  }
}

export function loadPeople(): Person[] {
  try {
    const raw = localStorage.getItem(PEOPLE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePerson).filter((p): p is Person => p !== null);
  } catch {
    return [];
  }
}

export function upsertPerson(person: Person): { people: Person[]; saved: boolean } {
  const people = loadPeople();
  const idx = people.findIndex((p) => p.id === person.id);
  const next = idx === -1 ? [person, ...people] : people.map((p) => (p.id === person.id ? person : p));
  const saved = savePeople(next);
  return { people: saved ? next : people, saved };
}

export function deletePerson(id: string): { people: Person[]; saved: boolean } {
  const current = loadPeople();
  const next = current.filter((p) => p.id !== id);
  const saved = savePeople(next);
  return { people: saved ? next : current, saved };
}

export function emptyPerson(): Person {
  return {
    id: newId(),
    name: "",
    licenseNumber: "",
    roleTags: ["applying"],
    licenseExpiry: "",
    ceDueDate: "",
  };
}

/** Role tags are defaults only: tagged people first, then the rest (full roster). */
export function peopleForRole(people: Person[], role: PersonnelRole): Person[] {
  const tagged = people.filter((p) => p.roleTags.includes(role));
  const rest = people.filter((p) => !p.roleTags.includes(role));
  return [...tagged, ...rest];
}


const SETTINGS_KEY = "jobber-pest-logger:settings:v1";

export const BACKUP_VERSION = "1.2";

export function emptySettings(): ShopSettings {
  return {
    shopName: "",
    shopTpclNumber: "",
    shopTpclLetter: "",
  };
}

function isShopSettingsShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.shopName === "string" &&
    typeof value.shopTpclNumber === "string" &&
    typeof value.shopTpclLetter === "string"
  );
}

function normalizeSettings(value: unknown): ShopSettings | null {
  if (!isShopSettingsShape(value) || !isRecord(value)) return null;
  return {
    shopName: value.shopName as string,
    shopTpclNumber: value.shopTpclNumber as string,
    shopTpclLetter: value.shopTpclLetter as string,
  };
}

export function loadSettings(): ShopSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return emptySettings();
    const parsed = JSON.parse(raw) as unknown;
    return normalizeSettings(parsed) ?? emptySettings();
  } catch {
    return emptySettings();
  }
}

export function saveSettings(settings: ShopSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save settings", err);
    return false;
  }
}

export interface DeviceBackup {
  version: string;
  exportedAt: string;
  logs: ApplicationLog[];
  catalog: ShopProduct[];
  people: Person[];
  settings: ShopSettings;
}

export function buildBackup(): DeviceBackup {
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    logs: loadLogs(),
    catalog: loadCatalog(),
    people: loadPeople(),
    settings: loadSettings(),
  };
}

export function downloadBackup(): void {
  const backup = buildBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = backup.exportedAt.slice(0, 10);
  a.download = `jobber-pest-logger-backup-${stamp}.json`;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type RestoreResult =
  | { ok: true; backup: DeviceBackup }
  | { ok: false; error: string };

/** Validate backup JSON shape; reject garbage. Does not write storage. */
export function parseBackup(raw: unknown): RestoreResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "Backup must be a JSON object." };
  }
  if (typeof raw.version !== "string" || !raw.version.trim()) {
    return { ok: false, error: "Backup is missing a version stamp." };
  }
  if (typeof raw.exportedAt !== "string") {
    return { ok: false, error: "Backup is missing exportedAt." };
  }
  if (!Array.isArray(raw.logs)) {
    return { ok: false, error: "Backup logs must be an array." };
  }
  if (!Array.isArray(raw.catalog)) {
    return { ok: false, error: "Backup catalog must be an array." };
  }
  if (!Array.isArray(raw.people)) {
    return { ok: false, error: "Backup people must be an array." };
  }
  if (!isRecord(raw.settings)) {
    return { ok: false, error: "Backup settings must be an object." };
  }

  const logs = (raw.logs as unknown[])
    .map(normalizeLog)
    .filter((l): l is ApplicationLog => l !== null);
  if (logs.length !== (raw.logs as unknown[]).length) {
    return { ok: false, error: "Backup contains invalid application log(s)." };
  }

  const catalog = (raw.catalog as unknown[])
    .map(normalizeShopProduct)
    .filter((p): p is ShopProduct => p !== null);
  if (catalog.length !== (raw.catalog as unknown[]).length) {
    return { ok: false, error: "Backup contains invalid catalog product(s)." };
  }

  const people = (raw.people as unknown[])
    .map(normalizePerson)
    .filter((p): p is Person => p !== null);
  if (people.length !== (raw.people as unknown[]).length) {
    return { ok: false, error: "Backup contains invalid people row(s)." };
  }

  const settings = normalizeSettings(raw.settings);
  if (!settings) {
    return { ok: false, error: "Backup settings are invalid." };
  }

  return {
    ok: true,
    backup: {
      version: raw.version as string,
      exportedAt: raw.exportedAt as string,
      logs,
      catalog,
      people,
      settings,
    },
  };
}

/** Replace all device localStorage keys with validated backup contents. */
export function applyBackup(backup: DeviceBackup): boolean {
  const logsOk = saveLogs(backup.logs);
  const catalogOk = saveCatalog(backup.catalog);
  const peopleOk = savePeople(backup.people);
  const settingsOk = saveSettings(backup.settings);
  return logsOk && catalogOk && peopleOk && settingsOk;
}
