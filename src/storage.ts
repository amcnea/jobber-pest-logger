import { EXAMPLE_SEEDS, inferIsExample, isExampleShopProduct, logHasExampleProducts } from "./catalog";
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

/** Normalize service address for grouping: trim, collapse whitespace, case-fold. */
export function normalizeServiceAddressKey(address: string): string {
  const trimmed = String(address ?? "").trim().replace(/\s+/g, " ");
  return trimmed.toLowerCase() || "(no service address)";
}

export function displayServiceAddress(address: string): string {
  const trimmed = String(address ?? "").trim().replace(/\s+/g, " ");
  return trimmed || "(no service address)";
}

function compareLogRecency(a: ApplicationLog, b: ApplicationLog): number {
  return b.dateUsed.localeCompare(a.dateUsed) || b.createdAt.localeCompare(a.createdAt);
}

/** Property book entry derived in memory from saved logs (no separate storage). */
export interface PropertyBookEntry {
  /** Normalization key (trim + case-fold). */
  key: string;
  /** Last-seen display service address. */
  serviceAddress: string;
  customerBillingName: string;
  customerBillingAddress: string;
  poleLocation: string;
  jobberAddress: string;
  logs: ApplicationLog[];
  /** Most recent log at this address (dateUsed, then createdAt). */
  lastLog: ApplicationLog;
}

/**
 * Group logs into a property book by normalized serviceAddress.
 * Last-seen billing name/address, pole, and Jobber address come from the most recent log.
 */
export function groupLogsByServiceAddress(logs: ApplicationLog[]): PropertyBookEntry[] {
  const map = new Map<string, ApplicationLog[]>();
  for (const log of logs) {
    const key = normalizeServiceAddressKey(log.serviceAddress);
    const existing = map.get(key);
    if (existing) existing.push(log);
    else map.set(key, [log]);
  }
  const entries: PropertyBookEntry[] = [];
  for (const [key, groupLogs] of map) {
    const sorted = groupLogs.slice().sort(compareLogRecency);
    const last = sorted[0]!;
    entries.push({
      key,
      serviceAddress: displayServiceAddress(last.serviceAddress),
      customerBillingName: last.customerBillingName,
      customerBillingAddress: last.customerBillingAddress,
      poleLocation: last.poleLocation,
      jobberAddress: last.jobberAddress,
      logs: sorted,
      lastLog: last,
    });
  }
  return entries.sort((a, b) => a.serviceAddress.localeCompare(b.serviceAddress));
}

/** Alias: derive property book in memory from loadLogs() / current logs. */
export function derivePropertyBook(logs: ApplicationLog[]): PropertyBookEntry[] {
  return groupLogsByServiceAddress(logs);
}

function isShopProductShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (typeof value.epaRegNo === "string" || value.epaRegNo === null) &&
    typeof value.is25b === "boolean" &&
    (value.kind === "pesticide" || value.kind === "device") &&
    (typeof value.isExample === "boolean" || value.isExample === undefined) &&
    (typeof value.archived === "boolean" || value.archived === undefined)
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
  const archived = value.archived === true;
  return {
    id: value.id as string,
    name: value.name as string,
    epaRegNo: isExample || isDevice || is25b ? null : ((value.epaRegNo as string | null) ?? null),
    is25b,
    kind: value.kind as ShopProduct["kind"],
    isExample,
    archived,
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

/** Remove all example / SAMPLE seeds from the shop catalog (logs untouched). */
export function removeExampleProductsFromCatalog(): { catalog: ShopProduct[]; saved: boolean; removed: number } {
  const current = loadCatalog();
  const next = current.filter((p) => !isExampleShopProduct(p));
  const removed = current.length - next.length;
  if (removed === 0) return { catalog: current, saved: true, removed: 0 };
  const saved = saveCatalog(next);
  return { catalog: saved ? next : current, saved, removed: saved ? removed : 0 };
}


/**
 * Soft demo reset: remove example catalog seeds and strip/drop logs that used them.
 * Does not delete real (non-example) products, people, settings, or backup stamp.
 */
export function clearExampleDemoData(): {
  catalog: ShopProduct[];
  logs: ApplicationLog[];
  saved: boolean;
  removedCatalog: number;
  removedLogs: number;
  strippedLogs: number;
} {
  const cat = removeExampleProductsFromCatalog();
  const currentLogs = loadLogs();
  let removedLogs = 0;
  let strippedLogs = 0;
  const nextLogs: ApplicationLog[] = [];
  for (const log of currentLogs) {
    const hadExamples = log.sampleData === true || logHasExampleProducts(log.products);
    const kept = log.products.filter(
      (p) =>
        !inferIsExample({
          isExample: p.isExample,
          catalogId: p.catalogId,
          epaRegNo: p.epaRegNo,
        }),
    );
    if (hadExamples && kept.length === 0) {
      removedLogs += 1;
      continue;
    }
    if (kept.length !== log.products.length) {
      strippedLogs += 1;
      nextLogs.push({
        ...log,
        products: kept,
        sampleData: false,
      });
    } else {
      nextLogs.push(log);
    }
  }
  const logsSaved = saveLogs(nextLogs);
  // Return what each subsystem actually persisted; do not gate logs on catalog.
  return {
    catalog: cat.catalog,
    logs: logsSaved ? nextLogs : currentLogs,
    saved: cat.saved && logsSaved,
    removedCatalog: cat.removed,
    removedLogs: logsSaved ? removedLogs : 0,
    strippedLogs: logsSaved ? strippedLogs : 0,
  };
}

export function emptyShopProduct(): ShopProduct {
  return {
    id: newId(),
    name: "",
    epaRegNo: null,
    is25b: false,
    kind: "pesticide",
    isExample: false,
    archived: false,
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
const LAST_BACKUP_KEY = "jobber-pest-logger:last-backup:v1";
const PILOT_CARD_KEY = "jobber-pest-logger:pilot-card-dismissed:v1";
const A2HS_TIP_KEY = "jobber-pest-logger:a2hs-tip-dismissed:v1";

/** Soft nag when never backed up or last backup older than this many days. */
export const BACKUP_NAG_DAYS = 7;

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
    shopName: (value.shopName as string).trim(),
    shopTpclNumber: (value.shopTpclNumber as string).trim(),
    shopTpclLetter: (value.shopTpclLetter as string).trim(),
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

/** ISO timestamp of last successful backup download, or null if never. */
export function loadLastBackupAt(): string | null {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string" && parsed.trim() && !Number.isNaN(Date.parse(parsed.trim()))) {
      return parsed.trim();
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { at?: unknown }).at === "string"
    ) {
      const at = (parsed as { at: string }).at.trim();
      if (at && !Number.isNaN(Date.parse(at))) return at;
    }
    return null;
  } catch {
    return null;
  }
}


/** Whether the Add to Home Screen tip was dismissed on this device. */
export function loadA2hsTipDismissed(): boolean {
  try {
    return localStorage.getItem(A2HS_TIP_KEY) === "1";
  } catch {
    return false;
  }
}

/** Hide the Add to Home Screen tip on this device until storage is cleared. */
export function dismissA2hsTip(): boolean {
  try {
    localStorage.setItem(A2HS_TIP_KEY, "1");
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not dismiss A2HS tip", err);
    return false;
  }
}

/** Whether the shop pilot / Jobber how-to card was dismissed on this device. */
export function loadPilotCardDismissed(): boolean {
  try {
    return localStorage.getItem(PILOT_CARD_KEY) === "1";
  } catch {
    return false;
  }
}

/** Hide the shop pilot card on this device until storage is cleared. */
export function dismissPilotCard(): boolean {
  try {
    localStorage.setItem(PILOT_CARD_KEY, "1");
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not dismiss pilot card", err);
    return false;
  }
}

/**
 * Wipe all Jobber Pest Logger keys on this device. Caller must confirm.
 * Re-seeds example catalog so first-run can start again. Does not touch other origins.
 * Snapshots first and rolls back on any failed write so saved:false means prior data is intact.
 */
export function wipeAllDeviceData(): {
  saved: boolean;
  catalog: ShopProduct[];
  logs: ApplicationLog[];
  people: Person[];
  settings: ShopSettings;
  lastBackupAt: string | null;
} {
  const clearedSettings = emptySettings();
  const seed = EXAMPLE_SEEDS.map((p) => ({ ...p }));
  const keys = [
    LOGS_KEY,
    CATALOG_KEY,
    PEOPLE_KEY,
    SETTINGS_KEY,
    LAST_BACKUP_KEY,
    PILOT_CARD_KEY,
    A2HS_TIP_KEY,
  ] as const;
  const snapshot: Record<string, string | null> = {};
  try {
    for (const key of keys) {
      snapshot[key] = localStorage.getItem(key);
    }
  } catch (err) {
    console.error("jobber-pest-logger: could not snapshot storage before wipe", err);
    return {
      saved: false,
      catalog: loadCatalog(),
      logs: loadLogs(),
      people: loadPeople(),
      settings: loadSettings(),
      lastBackupAt: loadLastBackupAt(),
    };
  }

  const rollback = () => {
    try {
      for (const key of keys) {
        const prev = snapshot[key];
        if (prev === null) localStorage.removeItem(key);
        else localStorage.setItem(key, prev);
      }
    } catch (err) {
      console.error("jobber-pest-logger: could not roll back failed wipe", err);
    }
  };

  try {
    localStorage.removeItem(LAST_BACKUP_KEY);
    localStorage.removeItem(PILOT_CARD_KEY);
    localStorage.removeItem(A2HS_TIP_KEY);
    const catalogOk = saveCatalog(seed);
    const logsOk = saveLogs([]);
    const peopleOk = savePeople([]);
    const settingsOk = saveSettings(clearedSettings);
    if (!(catalogOk && logsOk && peopleOk && settingsOk)) {
      rollback();
      return {
        saved: false,
        catalog: loadCatalog(),
        logs: loadLogs(),
        people: loadPeople(),
        settings: loadSettings(),
        lastBackupAt: loadLastBackupAt(),
      };
    }
    return {
      saved: true,
      catalog: seed,
      logs: [],
      people: [],
      settings: clearedSettings,
      lastBackupAt: null,
    };
  } catch (err) {
    console.error("jobber-pest-logger: wipeAllDeviceData failed", err);
    rollback();
    return {
      saved: false,
      catalog: loadCatalog(),
      logs: loadLogs(),
      people: loadPeople(),
      settings: loadSettings(),
      lastBackupAt: loadLastBackupAt(),
    };
  }
}


/** Record a successful backup download timestamp (device-local clock → ISO). */
export function markLastBackupNow(now = new Date()): boolean {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify({ at: now.toISOString() }));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save last-backup stamp", err);
    return false;
  }
}

/** Device-local friendly label, e.g. "Last backup: Sep 5, 2026, 3:45 PM". */
export function formatLastBackupLabel(iso: string | null): string {
  if (!iso) return "Last backup: never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Last backup: unknown";
  return `Last backup: ${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

/**
 * Soft nag copy when never backed up or older than BACKUP_NAG_DAYS.
 * Returns null when backup is recent enough (no nag).
 */
export function backupNagMessage(iso: string | null, now = new Date()): string | null {
  if (!iso) {
    return "No backup on this device yet. Download a backup JSON when you can — soft reminder only, not blocking.";
  }
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "Backup stamp looks invalid. Download a fresh backup when you can — soft reminder only.";
  }
  const ageDays = (now.getTime() - then.getTime()) / 86_400_000;
  if (ageDays > BACKUP_NAG_DAYS) {
    return `Last backup was more than ${BACKUP_NAG_DAYS} days ago. Consider downloading a fresh backup — soft reminder only, not blocking.`;
  }
  return null;
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
  markLastBackupNow();
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
  if (raw.version.trim() !== BACKUP_VERSION) {
    return {
      ok: false,
      error: `Unsupported backup version "${raw.version.trim()}". This app expects ${BACKUP_VERSION}.`,
    };
  }
  if (typeof raw.exportedAt !== "string" || !raw.exportedAt.trim()) {
    return { ok: false, error: "Backup is missing exportedAt." };
  }
  const exportedAt = raw.exportedAt.trim();
  if (Number.isNaN(Date.parse(exportedAt))) {
    return { ok: false, error: "Backup exportedAt is not a valid date." };
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
      version: raw.version.trim(),
      exportedAt,
      logs,
      catalog,
      people,
      settings,
    },
  };
}

/** Replace all device localStorage keys with validated backup contents. */
export function applyBackup(backup: DeviceBackup): boolean {
  if (backup.version.trim() !== BACKUP_VERSION) {
    console.error(
      `jobber-pest-logger: applyBackup rejected unsupported version "${backup.version.trim()}" (expected ${BACKUP_VERSION})`,
    );
    return false;
  }
  const keys = [LOGS_KEY, CATALOG_KEY, PEOPLE_KEY, SETTINGS_KEY] as const;
  const snapshot: Record<string, string | null> = {};
  try {
    for (const key of keys) {
      snapshot[key] = localStorage.getItem(key);
    }
  } catch (err) {
    console.error("jobber-pest-logger: could not snapshot storage before backup restore", err);
    return false;
  }

  const logsOk = saveLogs(backup.logs);
  const catalogOk = saveCatalog(backup.catalog);
  const peopleOk = savePeople(backup.people);
  const settingsOk = saveSettings(backup.settings);
  if (logsOk && catalogOk && peopleOk && settingsOk) return true;

  try {
    for (const key of keys) {
      const prev = snapshot[key];
      if (prev === null) localStorage.removeItem(key);
      else localStorage.setItem(key, prev);
    }
  } catch (err) {
    console.error("jobber-pest-logger: could not roll back failed backup restore", err);
  }
  return false;
}

/** Soft first-run setup steps (not a hard gate on logging). */
export interface FirstRunStep {
  id: "shop" | "people" | "products" | "backup";
  label: string;
  done: boolean;
  screen: "settings" | "people" | "products" | "settings";
}

/**
 * Mark first-run checklist steps from existing localStorage-backed state.
 * Shop: settings has name and/or TPCL. People: roster length > 0.
 * Products: at least one non-example catalog row. Backup: last-backup stamp present.
 */
export function getFirstRunSteps(input: {
  settings: ShopSettings;
  people: Person[];
  catalog: ShopProduct[];
  lastBackupAt: string | null;
}): FirstRunStep[] {
  const shopDone =
    input.settings.shopName.trim().length > 0 || input.settings.shopTpclNumber.trim().length > 0;
  const peopleDone = input.people.length > 0;
  const productsDone = input.catalog.some((p) => !isExampleShopProduct(p));
  const backupDone = typeof input.lastBackupAt === "string" && input.lastBackupAt.trim().length > 0;

  return [
    { id: "shop", label: "Set shop name / TPCL", done: shopDone, screen: "settings" },
    { id: "people", label: "Add people to the roster", done: peopleDone, screen: "people" },
    { id: "products", label: "Add real (non-example) products", done: productsDone, screen: "products" },
    { id: "backup", label: "Download a backup", done: backupDone, screen: "settings" },
  ];
}

export function firstRunIncomplete(steps: FirstRunStep[]): boolean {
  return steps.some((s) => !s.done);
}