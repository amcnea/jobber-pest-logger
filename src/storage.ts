import { EXAMPLE_SEEDS, inferIsExample, isExampleShopProduct, logHasExampleProducts } from "./catalog";
import { newId } from "./ids";
import type { ApplicationLog, AppliedProduct, Person, PersonnelRole, ShopProduct, ShopSettings } from "./types";

const LOGS_KEY = "jobber-pest-logger:logs:v1";
const CATALOG_KEY = "jobber-pest-logger:catalog:v1";
/** Raw log rows that failed normalizeLog. Included in backup JSON; surfaced by the Settings notice. */
export const LOGS_QUARANTINE_KEY = "jobber-pest-logger:logs-quarantine:v1";
/** Raw catalog rows that failed normalizeShopProduct. */
export const CATALOG_QUARANTINE_KEY = "jobber-pest-logger:catalog-quarantine:v1";
/** Raw person rows that failed normalizePerson. */
export const PEOPLE_QUARANTINE_KEY = "jobber-pest-logger:people-quarantine:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable JSON of a raw row. Key order does not matter; id is not a shortcut. */
function stableStringify(value: unknown): string {
  const stack = new WeakSet<object>();
  const encode = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      if (stack.has(v)) throw new TypeError("cycle");
      stack.add(v);
      const out = v.map(encode);
      stack.delete(v);
      return out;
    }
    if (isRecord(v)) {
      if (stack.has(v)) throw new TypeError("cycle");
      stack.add(v);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = encode(v[key]);
      stack.delete(v);
      return out;
    }
    return v;
  };
  return JSON.stringify(encode(value));
}

function quarantineIdentity(value: unknown): string {
  try {
    return `json:${stableStringify(value)}`;
  } catch {
    return "json:unserializable";
  }
}

/** Read a quarantine array. Corrupt or missing storage yields []. Never throws. */
function readQuarantine(key: string): unknown[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Append raw failed rows to a quarantine key. Dedupe by full JSON of the raw row
 * (stable key order), never by id. Identical rows collapse; same id with different
 * content both stay.
 * Returns true when every failed row is in the quarantine store afterward (already
 * present counts, and that path does not rewrite). Returns false when setItem throws
 * or a needed row is not retained. Empty failed is success.
 */
function appendQuarantine(key: string, failed: unknown[]): boolean {
  if (failed.length === 0) return true;
  try {
    const existing = readQuarantine(key);
    const seen = new Set(existing.map(quarantineIdentity));
    const next = existing.slice();
    for (const row of failed) {
      const identity = quarantineIdentity(row);
      if (seen.has(identity)) continue;
      seen.add(identity);
      next.push(row);
    }
    if (next.length === existing.length) return true;
    localStorage.setItem(key, JSON.stringify(next));
    const stored = new Set(readQuarantine(key).map(quarantineIdentity));
    return failed.every((row) => stored.has(quarantineIdentity(row)));
  } catch {
    return false;
  }
}

/** Current main-key payload when it is a JSON array. Missing, corrupt, or non-array → null. */
function readStoredArray(key: string): unknown[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Before a main-key write that would drop raw rows, those rows must already be in quarantine.
 * False means do not write the main key — the raw row would otherwise be gone.
 */
function quarantineRawFailuresBeforeWrite<T>(
  mainKey: string,
  quarantineKey: string,
  normalize: (value: unknown) => T | null,
): boolean {
  const current = readStoredArray(mainKey);
  if (!current) return true;
  const failed: unknown[] = [];
  for (const row of current) {
    if (normalize(row) === null) failed.push(row);
  }
  return appendQuarantine(quarantineKey, failed);
}

function partitionNormalized<T>(
  rows: unknown[],
  normalize: (value: unknown) => T | null,
  quarantineKey: string,
): T[] {
  const ok: T[] = [];
  const failed: unknown[] = [];
  for (const row of rows) {
    const normalized = normalize(row);
    if (normalized === null) failed.push(row);
    else ok.push(normalized);
  }
  // Quarantine before returning so the next main-key save cannot drop these raw rows first.
  appendQuarantine(quarantineKey, failed);
  return ok;
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

export function normalizeLog(value: unknown): ApplicationLog | null {
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
    return partitionNormalized(parsed, normalizeLog, LOGS_QUARANTINE_KEY);
  } catch {
    return [];
  }
}

/** Raw log rows kept after normalizeLog rejected them. Read-only. */
export function loadLogsQuarantine(): unknown[] {
  return readQuarantine(LOGS_QUARANTINE_KEY);
}

/**
 * Persist logs. Raw main-key rows that fail normalizeLog are quarantined before
 * the main key is rewritten.
 * `skipQuarantine` is wipe-only (wipeAllDeviceData). A normal save must not set it.
 */
export function saveLogs(
  logs: ApplicationLog[],
  options?: { skipQuarantine?: boolean },
): boolean {
  if (
    !options?.skipQuarantine &&
    !quarantineRawFailuresBeforeWrite(LOGS_KEY, LOGS_QUARANTINE_KEY, normalizeLog)
  ) {
    console.error(
      "jobber-pest-logger: could not save logs",
      new Error("quarantine write failed; main key left unchanged"),
    );
    return false;
  }
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

/**
 * Persist the shop catalog. Raw main-key rows that fail normalizeShopProduct
 * are quarantined before the main key is rewritten.
 * `skipQuarantine` is wipe-only (wipeAllDeviceData). A normal save must not set it.
 */
export function saveCatalog(
  products: ShopProduct[],
  options?: { skipQuarantine?: boolean },
): boolean {
  if (
    !options?.skipQuarantine &&
    !quarantineRawFailuresBeforeWrite(CATALOG_KEY, CATALOG_QUARANTINE_KEY, normalizeShopProduct)
  ) {
    console.error(
      "jobber-pest-logger: could not save catalog",
      new Error("quarantine write failed; main key left unchanged"),
    );
    return false;
  }
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
    // Array (including empty or partly invalid): do not re-seed. Quarantine failed rows
    // before any later saveCatalog writes the main key. Missing/non-array/parse-fail paths
    // above and below seed without quarantining — there was no raw array to keep.
    return partitionNormalized(parsed, normalizeShopProduct, CATALOG_QUARANTINE_KEY);
  } catch {
    const seed = EXAMPLE_SEEDS.map((p) => ({ ...p }));
    saveCatalog(seed);
    return seed;
  }
}

/** Raw catalog rows kept after normalizeShopProduct rejected them. Read-only. */
export function loadCatalogQuarantine(): unknown[] {
  return readQuarantine(CATALOG_QUARANTINE_KEY);
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

/**
 * Persist people. Raw main-key rows that fail normalizePerson are quarantined
 * before the main key is rewritten.
 * `skipQuarantine` is wipe-only (wipeAllDeviceData). A normal save must not set it.
 */
export function savePeople(
  people: Person[],
  options?: { skipQuarantine?: boolean },
): boolean {
  if (
    !options?.skipQuarantine &&
    !quarantineRawFailuresBeforeWrite(PEOPLE_KEY, PEOPLE_QUARANTINE_KEY, normalizePerson)
  ) {
    console.error(
      "jobber-pest-logger: could not save people",
      new Error("quarantine write failed; main key left unchanged"),
    );
    return false;
  }
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
    return partitionNormalized(parsed, normalizePerson, PEOPLE_QUARANTINE_KEY);
  } catch {
    return [];
  }
}

/** Raw person rows kept after normalizePerson rejected them. Read-only. */
export function loadPeopleQuarantine(): unknown[] {
  return readQuarantine(PEOPLE_QUARANTINE_KEY);
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

/** Raw set-aside rows kept with a device backup (not normalized). */
export interface BackupQuarantine {
  logs: unknown[];
  catalog: unknown[];
  people: unknown[];
}

export interface DeviceBackup {
  version: string;
  exportedAt: string;
  logs: ApplicationLog[];
  catalog: ShopProduct[];
  people: Person[];
  settings: ShopSettings;
  /**
   * Raw rows that failed normalization on this device. Always present on backups
   * this app writes; older backups may omit it (parsed as empty arrays).
   */
  quarantine: BackupQuarantine;
  /**
   * Optional export provenance (#7). Informational only: parseBackup ignores
   * unknown/extra keys and rebuilds the backup from known fields on restore.
   */
  meta?: Record<string, unknown>;
}

/** Current device quarantine payload for backups and the Settings notice. */
export function loadBackupQuarantine(): BackupQuarantine {
  return {
    logs: loadLogsQuarantine(),
    catalog: loadCatalogQuarantine(),
    people: loadPeopleQuarantine(),
  };
}

/**
 * Backup download aborted because invalid main-key rows were not retained in
 * quarantine. Callers must not write or hand over a backup file.
 */
export class IncompleteBackupError extends Error {
  constructor() {
    super(
      "Incomplete backup: raw rows could not be set aside into quarantine, so the download was aborted.",
    );
    this.name = "IncompleteBackupError";
  }
}

/** Raw main-key rows that fail normalize. Missing or non-array storage yields []. */
function rawMainKeyFailures(
  mainKey: string,
  normalize: (value: unknown) => unknown,
): unknown[] {
  const current = readStoredArray(mainKey);
  if (!current) return [];
  const failed: unknown[] = [];
  for (const row of current) {
    if (normalize(row) === null) failed.push(row);
  }
  return failed;
}

/**
 * Set aside invalid main-key rows, then require every one of them to be in the
 * quarantine store. False means a backup would omit a raw row — abort instead.
 */
function quarantineRetainedForBackup(): boolean {
  const checks: Array<{
    mainKey: string;
    quarantineKey: string;
    normalize: (value: unknown) => unknown;
  }> = [
    { mainKey: LOGS_KEY, quarantineKey: LOGS_QUARANTINE_KEY, normalize: normalizeLog },
    { mainKey: CATALOG_KEY, quarantineKey: CATALOG_QUARANTINE_KEY, normalize: normalizeShopProduct },
    { mainKey: PEOPLE_KEY, quarantineKey: PEOPLE_QUARANTINE_KEY, normalize: normalizePerson },
  ];
  for (const check of checks) {
    const failed = rawMainKeyFailures(check.mainKey, check.normalize);
    if (failed.length === 0) continue;
    if (!appendQuarantine(check.quarantineKey, failed)) return false;
    const stored = new Set(readQuarantine(check.quarantineKey).map(quarantineIdentity));
    if (!failed.every((row) => stored.has(quarantineIdentity(row)))) return false;
  }
  return true;
}

export type QuarantineCounts = {
  logs: number;
  catalog: number;
  people: number;
  total: number;
};

/** Counts of set-aside raw rows (logs / catalog / people). */
export function quarantineCounts(q: BackupQuarantine = loadBackupQuarantine()): QuarantineCounts {
  const logs = q.logs.length;
  const catalog = q.catalog.length;
  const people = q.people.length;
  return { logs, catalog, people, total: logs + catalog + people };
}

/**
 * Non-blocking Settings notice when quarantine has rows.
 * Returns null when there is nothing set aside.
 */
export function quarantineNoticeMessage(
  counts: QuarantineCounts = quarantineCounts(),
): string | null {
  if (counts.total === 0) return null;
  const parts: string[] = [];
  if (counts.logs > 0) {
    parts.push(`${counts.logs} log${counts.logs === 1 ? "" : "s"}`);
  }
  if (counts.catalog > 0) {
    parts.push(`${counts.catalog} catalog`);
  }
  if (counts.people > 0) {
    parts.push(`${counts.people} people`);
  }
  const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const n = counts.total;
  return (
    `${n} saved record${n === 1 ? "" : "s"} couldn't be read${breakdown} and were set aside ` +
    `(not deleted). They are not included in the PDF or CSV use-record export. ` +
    `Download a backup JSON to keep those raw rows with the premises copy.`
  );
}

function emptyQuarantine(): BackupQuarantine {
  return { logs: [], catalog: [], people: [] };
}

/** Replace or clear one quarantine key. Empty array removes the key. */
function writeQuarantineKey(key: string, rows: unknown[]): boolean {
  try {
    if (rows.length === 0) {
      localStorage.removeItem(key);
      return true;
    }
    localStorage.setItem(key, JSON.stringify(rows));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not write quarantine key", key, err);
    return false;
  }
}

function writeBackupQuarantine(q: BackupQuarantine): boolean {
  return (
    writeQuarantineKey(LOGS_QUARANTINE_KEY, q.logs) &&
    writeQuarantineKey(CATALOG_QUARANTINE_KEY, q.catalog) &&
    writeQuarantineKey(PEOPLE_QUARANTINE_KEY, q.people)
  );
}

/**
 * Validate optional backup.quarantine. Missing ⇒ empty arrays (older backups).
 * Present ⇒ must be an object whose logs/catalog/people are arrays (raw, not normalized).
 */
function parseBackupQuarantine(raw: Record<string, unknown>): 
  | { ok: true; quarantine: BackupQuarantine }
  | { ok: false; error: string } {
  if (!("quarantine" in raw) || raw.quarantine === undefined) {
    return { ok: true, quarantine: emptyQuarantine() };
  }
  if (!isRecord(raw.quarantine)) {
    return { ok: false, error: "Backup quarantine must be an object." };
  }
  const q = raw.quarantine;
  if (!Array.isArray(q.logs)) {
    return { ok: false, error: "Backup quarantine logs must be an array." };
  }
  if (!Array.isArray(q.catalog)) {
    return { ok: false, error: "Backup quarantine catalog must be an array." };
  }
  if (!Array.isArray(q.people)) {
    return { ok: false, error: "Backup quarantine people must be an array." };
  }
  return {
    ok: true,
    quarantine: {
      logs: q.logs as unknown[],
      catalog: q.catalog as unknown[],
      people: q.people as unknown[],
    },
  };
}

export function buildBackup(): DeviceBackup {
  const logs = loadLogs();
  const catalog = loadCatalog();
  const people = loadPeople();
  const settings = loadSettings();
  // load* already tried to set aside rejected rows. If that write did not
  // retain them, refuse a backup that would leave the raw rows out.
  if (!quarantineRetainedForBackup()) {
    throw new IncompleteBackupError();
  }
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    logs,
    catalog,
    people,
    settings,
    quarantine: loadBackupQuarantine(),
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
 * Clears the logs, catalog, and people quarantine keys so raw set-aside rows do not remain.
 * An intentional wipe does not re-quarantine still-invalid main-key rows before deleting them.
 * Snapshots first (including those quarantine keys) and rolls back on any failed write
 * so saved:false means prior data, including quarantine, is intact.
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
    LOGS_QUARANTINE_KEY,
    CATALOG_QUARANTINE_KEY,
    PEOPLE_QUARANTINE_KEY,
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

  // loadLogs / loadCatalog / loadPeople quarantine raw failures as they read.
  // A failed wipe must not leave that side effect after rollback.
  const failedState = () => {
    const state = {
      saved: false as const,
      catalog: loadCatalog(),
      logs: loadLogs(),
      people: loadPeople(),
      settings: loadSettings(),
      lastBackupAt: loadLastBackupAt(),
    };
    const quarantineKeys = [LOGS_QUARANTINE_KEY, CATALOG_QUARANTINE_KEY, PEOPLE_QUARANTINE_KEY] as const;
    try {
      for (const key of quarantineKeys) {
        const prev = snapshot[key];
        if (prev === null) localStorage.removeItem(key);
        else localStorage.setItem(key, prev);
      }
    } catch (err) {
      console.error("jobber-pest-logger: could not restore quarantine after failed wipe", err);
    }
    return state;
  };

  try {
    localStorage.removeItem(LAST_BACKUP_KEY);
    localStorage.removeItem(PILOT_CARD_KEY);
    localStorage.removeItem(A2HS_TIP_KEY);
    // skipQuarantine: wiping those rows on purpose must not copy them into quarantine first.
    const catalogOk = saveCatalog(seed, { skipQuarantine: true });
    const logsOk = saveLogs([], { skipQuarantine: true });
    const peopleOk = savePeople([], { skipQuarantine: true });
    const settingsOk = saveSettings(clearedSettings);
    if (!(catalogOk && logsOk && peopleOk && settingsOk)) {
      rollback();
      return failedState();
    }
    localStorage.removeItem(LOGS_QUARANTINE_KEY);
    localStorage.removeItem(CATALOG_QUARANTINE_KEY);
    localStorage.removeItem(PEOPLE_QUARANTINE_KEY);
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
    return failedState();
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

/**
 * Download backup JSON. Optional `sections` override (shared-shop pull #7);
 * omitted ⇒ build from this device's localStorage (local-only path).
 */
export function downloadBackup(
  sections?: ShopSections,
  meta?: { fileSuffix: string; provenance: Record<string, unknown> },
): void {
  // Shared-shop pull overrides shop sections only. Device main-key rows that
  // failed normalize must already be retained in quarantine or this aborts
  // before any file is created.
  if (!quarantineRetainedForBackup()) {
    throw new IncompleteBackupError();
  }
  const deviceQuarantine = loadBackupQuarantine();
  const built: DeviceBackup = sections
    ? {
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        logs: sections.logs,
        catalog: sections.catalog,
        people: sections.people,
        settings: sections.settings,
        quarantine: deviceQuarantine,
      }
    : buildBackup();
  const backup: DeviceBackup = meta ? { ...built, meta: meta.provenance } : built;
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = backup.exportedAt.slice(0, 10);
  a.download = meta
    ? `jobber-pest-logger-backup-${meta.fileSuffix}.json`
    : `jobber-pest-logger-backup-${stamp}.json`;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  markLastBackupNow();
}


export type ShopSections = {
  logs: ApplicationLog[];
  catalog: ShopProduct[];
  people: Person[];
  settings: ShopSettings;
};

export type ShopSectionsParseResult =
  | { ok: true; sections: ShopSections }
  | { ok: false; error: string };

/**
 * Validate nested shop section payloads (logs/catalog/people/settings).
 * Shared by parseBackup and RemoteShopStore.getShop — reject, do not drop, bad rows.
 */
export function parseShopSections(raw: {
  logs: unknown;
  catalog: unknown;
  people: unknown;
  settings: unknown;
}): ShopSectionsParseResult {
  if (!Array.isArray(raw.logs)) {
    return { ok: false, error: "Shop logs must be an array." };
  }
  if (!Array.isArray(raw.catalog)) {
    return { ok: false, error: "Shop catalog must be an array." };
  }
  if (!Array.isArray(raw.people)) {
    return { ok: false, error: "Shop people must be an array." };
  }
  if (!isRecord(raw.settings)) {
    return { ok: false, error: "Shop settings must be an object." };
  }

  const logs = (raw.logs as unknown[])
    .map(normalizeLog)
    .filter((l): l is ApplicationLog => l !== null);
  if (logs.length !== (raw.logs as unknown[]).length) {
    return { ok: false, error: "Shop contains invalid application log(s)." };
  }

  const catalog = (raw.catalog as unknown[])
    .map(normalizeShopProduct)
    .filter((prod): prod is ShopProduct => prod !== null);
  if (catalog.length !== (raw.catalog as unknown[]).length) {
    return { ok: false, error: "Shop contains invalid catalog product(s)." };
  }

  const people = (raw.people as unknown[])
    .map(normalizePerson)
    .filter((person): person is Person => person !== null);
  if (people.length !== (raw.people as unknown[]).length) {
    return { ok: false, error: "Shop contains invalid people row(s)." };
  }

  const settings = normalizeSettings(raw.settings);
  if (!settings) {
    return { ok: false, error: "Shop settings are invalid." };
  }

  return { ok: true, sections: { logs, catalog, people, settings } };
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
  const sectionsResult = parseShopSections({
    logs: raw.logs,
    catalog: raw.catalog,
    people: raw.people,
    settings: raw.settings,
  });
  if (!sectionsResult.ok) {
    // Keep backup-flavored errors for the restore UI.
    const mapped = sectionsResult.error
      .replace(/^Shop /, "Backup ")
      .replace(/^Shop contains /, "Backup contains ")
      .replace(/^Shop settings /, "Backup settings ");
    return { ok: false, error: mapped };
  }

  const { logs, catalog, people, settings } = sectionsResult.sections;

  const quarantineResult = parseBackupQuarantine(raw);
  if (!quarantineResult.ok) {
    return { ok: false, error: quarantineResult.error };
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
      quarantine: quarantineResult.quarantine,
    },
  };
}

export type ApplyBackupResult =
  | { ok: true }
  | { ok: false; unrestoredKeys: string[]; message: string };

const RESTORE_STORAGE_LABELS: Record<string, string> = {
  [LOGS_KEY]: "logs",
  [CATALOG_KEY]: "catalog",
  [PEOPLE_KEY]: "people",
  [SETTINGS_KEY]: "settings",
  [LOGS_QUARANTINE_KEY]: "set-aside logs",
  [CATALOG_QUARANTINE_KEY]: "set-aside catalog",
  [PEOPLE_QUARANTINE_KEY]: "set-aside people",
};

function restoreFailureMessage(unrestoredKeys: readonly string[]): string {
  const keep = "Keep the backup file.";
  if (unrestoredKeys.length === 0) {
    return `Could not finish restoring this backup. Earlier rows on this device were left in place. ${keep}`;
  }
  const names = unrestoredKeys.map((id) => RESTORE_STORAGE_LABELS[id] ?? id);
  return (
    `Could not restore previous ${names.join(", ")}. ` +
    `Those rows were left as they were instead of being cleared. ${keep}`
  );
}

function applyBackupFailed(unrestoredKeys: string[], message?: string): ApplyBackupResult {
  return {
    ok: false,
    unrestoredKeys,
    message: message ?? restoreFailureMessage(unrestoredKeys),
  };
}

/** Replace all device localStorage keys with validated backup contents (including quarantine). */
export function applyBackup(backup: DeviceBackup): ApplyBackupResult {
  if (backup.version.trim() !== BACKUP_VERSION) {
    console.error(
      `jobber-pest-logger: applyBackup rejected unsupported version "${backup.version.trim()}" (expected ${BACKUP_VERSION})`,
    );
    return applyBackupFailed(
      [],
      "Unsupported backup version. Nothing on this device was changed. Keep the backup file.",
    );
  }
  const quarantine = backup.quarantine ?? emptyQuarantine();
  const keys = [
    LOGS_KEY,
    CATALOG_KEY,
    PEOPLE_KEY,
    SETTINGS_KEY,
    LOGS_QUARANTINE_KEY,
    CATALOG_QUARANTINE_KEY,
    PEOPLE_QUARANTINE_KEY,
  ] as const;
  const snapshot: Record<string, string | null> = {};
  try {
    for (const key of keys) {
      snapshot[key] = localStorage.getItem(key);
    }
  } catch (err) {
    console.error("jobber-pest-logger: could not snapshot storage before backup restore", err);
    return applyBackupFailed(
      [],
      "Could not read this device before restore, so nothing was replaced. Keep the backup file.",
    );
  }

  const matchesPrior = (storageId: string): boolean => {
    try {
      return localStorage.getItem(storageId) === snapshot[storageId];
    } catch (err) {
      console.error("jobber-pest-logger: could not read storage during restore rollback", err);
      return false;
    }
  };

  /**
   * Write the snapshot back in place. removeItem is allowed only when the
   * snapshot itself had no value. A key that already holds rows is never
   * deleted to make room, and a failed setItem leaves that key unchanged.
   */
  const writePriorInPlace = (storageId: string): boolean => {
    if (matchesPrior(storageId)) return true;
    const prev = snapshot[storageId];
    try {
      if (prev === null) localStorage.removeItem(storageId);
      else localStorage.setItem(storageId, prev);
    } catch (err) {
      console.error("jobber-pest-logger: could not roll back failed backup restore", err);
    }
    return matchesPrior(storageId);
  };

  const rollback = (): string[] => {
    // Second pass is still in-place. A prior write can succeed after a
    // neighbor has been written back to a smaller snapshot. It does not
    // remove a key, and it does not put an incoming backup value back.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const storageId of keys) writePriorInPlace(storageId);
    }
    const unrestored: string[] = [];
    for (const storageId of keys) {
      if (!matchesPrior(storageId)) unrestored.push(storageId);
    }
    return unrestored;
  };

  const logsOk = saveLogs(backup.logs);
  const catalogOk = saveCatalog(backup.catalog);
  const peopleOk = savePeople(backup.people);
  const settingsOk = saveSettings(backup.settings);
  if (!(logsOk && catalogOk && peopleOk && settingsOk)) {
    return applyBackupFailed(rollback());
  }

  if (!writeBackupQuarantine(quarantine)) {
    return applyBackupFailed(rollback());
  }
  return { ok: true };
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