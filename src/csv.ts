import type { ApplicationLog } from "./types";

/** Texas TDA CSV columns matching 4 TAC § 7.144(a). Optional Jobber link is last and labeled not-TDA. */
export const TDA_CSV_COLUMNS = [
  "Customer billing name",
  "Customer billing address",
  "Service address",
  "Pole location (utility-pole retreatment)",
  "Pesticide names",
  "EPA registration numbers (blank if 25(b) / unregistered)",
  "25(b) or unregistered products",
  "Devices used",
  "Device counts",
  "RTU total amount (AI % unchanged)",
  "Mixing rate",
  "Percent AI",
  "Total material applied (mixed)",
  "Target pest or purpose",
  "Date used",
  "Person applying — name",
  "Person applying — license number",
  "Person supervising — name",
  "Person supervising — license number",
  "Person receiving training — name",
  "Person receiving training — license number",
  "Shop TPCL number",
  "Shop TPCL letter",
  "SAMPLE DATA FLAG",
  "Jobber job # (optional, not TDA-required)",
  "Jobber address paste (optional, not TDA-required)",
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function joinLines(values: string[]): string {
  return values.filter(Boolean).join("; ");
}

function person(log: ApplicationLog, role: ApplicationLog["personnel"][number]["role"]) {
  return log.personnel.find((p) => p.role === role);
}

export function logsToCsv(logs: ApplicationLog[]): string {
  const header = TDA_CSV_COLUMNS.map(csvEscape).join(",");
  const rows = logs.map((log) => {
    const pesticides = log.products.filter((p) => p.method !== "device");
    const devices = log.products.filter((p) => p.method === "device");
    const applying = person(log, "applying");
    const supervising = person(log, "supervising");
    const training = person(log, "receiving_training");
    const cells = [
      log.customerBillingName,
      log.customerBillingAddress,
      log.serviceAddress,
      log.poleLocation,
      joinLines(pesticides.map((p) => p.name)),
      joinLines(pesticides.map((p) => p.epaRegNo ?? "")),
      joinLines(pesticides.filter((p) => p.is25b || !p.epaRegNo).map((p) => p.name)),
      joinLines(devices.map((p) => p.name)),
      joinLines(devices.map((p) => (p.deviceCount ? `${p.name}: ${p.deviceCount}` : p.name))),
      joinLines(
        pesticides
          .filter((p) => p.method === "rtu" && p.rtuAmount)
          .map((p) => `${p.name}: ${p.rtuAmount} ${p.rtuUnit}`.trim()),
      ),
      joinLines(
        pesticides.filter((p) => p.method === "mixed" && p.mixingRate).map((p) => `${p.name}: ${p.mixingRate}`),
      ),
      joinLines(
        pesticides.filter((p) => p.method === "mixed" && p.percentAi).map((p) => `${p.name}: ${p.percentAi}%`),
      ),
      joinLines(
        pesticides
          .filter((p) => p.method === "mixed" && p.mixedTotal)
          .map((p) => `${p.name}: ${p.mixedTotal} ${p.mixedUnit}`.trim()),
      ),
      log.targetPestOrPurpose,
      log.dateUsed,
      applying?.name ?? "",
      applying?.licenseNumber ?? "",
      supervising?.name ?? "",
      supervising?.licenseNumber ?? "",
      training?.name ?? "",
      training?.licenseNumber ?? "",
      log.shopTpclNumber,
      log.shopTpclLetter,
      "SAMPLE — placeholder catalog, not EPA data",
      log.jobberJobNumber,
      log.jobberAddress,
    ];
    return cells.map(csvEscape).join(",");
  });
  return [header, ...rows].join("\r\n") + "\r\n";
}

export function downloadCsv(logs: ApplicationLog[]): void {
  const csv = logsToCsv(logs);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "texas-tda-application-logs-SAMPLE.csv";
  a.click();
  URL.revokeObjectURL(url);
}
