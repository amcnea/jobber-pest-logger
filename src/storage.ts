import type { ApplicationLog } from "./types";

const KEY = "jobber-pest-logger:logs:v1";

export function loadLogs(): ApplicationLog[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ApplicationLog[];
  } catch {
    return [];
  }
}

export function saveLogs(logs: ApplicationLog[]): void {
  localStorage.setItem(KEY, JSON.stringify(logs));
}

export function upsertLog(log: ApplicationLog): ApplicationLog[] {
  const logs = loadLogs();
  const idx = logs.findIndex((l) => l.id === log.id);
  const next = idx === -1 ? [log, ...logs] : logs.map((l) => (l.id === log.id ? log : l));
  saveLogs(next);
  return next;
}

export function deleteLog(id: string): ApplicationLog[] {
  const next = loadLogs().filter((l) => l.id !== id);
  saveLogs(next);
  return next;
}

export function groupLogsByServiceAddress(
  logs: ApplicationLog[],
): { address: string; logs: ApplicationLog[] }[] {
  const map = new Map<string, { address: string; logs: ApplicationLog[] }>();
  for (const log of logs) {
    const key = log.serviceAddress.trim().toLowerCase() || "(no service address)";
    const existing = map.get(key);
    if (existing) {
      existing.logs.push(log);
    } else {
      map.set(key, {
        address: log.serviceAddress.trim() || "(no service address)",
        logs: [log],
      });
    }
  }
  return [...map.values()].sort((a, b) => a.address.localeCompare(b.address));
}
