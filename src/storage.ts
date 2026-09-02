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
