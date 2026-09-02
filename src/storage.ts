import type { ApplicationLog } from "./types";

const KEY = "jobber-pest-logger:logs:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isProduct(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && typeof value.method === "string";
}

function isPersonnel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.role === "string" && typeof value.name === "string";
}

function isLog(value: unknown): value is ApplicationLog {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.serviceAddress === "string" &&
    typeof value.dateUsed === "string" &&
    typeof value.customerBillingName === "string" &&
    Array.isArray(value.products) &&
    value.products.every(isProduct) &&
    Array.isArray(value.personnel) &&
    value.personnel.every(isPersonnel) &&
    isRecord(value.termite)
  );
}

export function loadLogs(): ApplicationLog[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLog);
  } catch {
    return [];
  }
}

export function saveLogs(logs: ApplicationLog[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(logs));
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
