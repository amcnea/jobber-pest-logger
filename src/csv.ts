import { epaExportText, EXAMPLE_EPA_LABEL } from "./catalog";
import type { ApplicationLog } from "./types";

/** Texas TDA CSV columns matching 4 TAC § 7.144(a)/(b). Optional Jobber link is last and labeled not-TDA. */
export const TDA_CSV_COLUMNS = [
  "Customer billing name",
  "Customer billing address",
  "Service address",
  "Pole location (utility-pole retreatment)",
  "Pesticide names",
  "EPA registration numbers (blank if 25(b) / unregistered; example seeds labeled)",
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
  "Termite work",
  "Area treated (sq ft; blank if bait)",
  "Termite bait",
  "Physical-barrier measurement",
  "Diagram note (text, not a drawing)",
  "Commercial pretreat (not baits/wood/barriers)",
  "Pretreat tank count",
  "Pretreat tank gallons",
  "Pretreat start time",
  "Pretreat stop time",
  "Example catalog items (not real EPA numbers)",
  "Jobber job # (optional, not TDA-required)",
  "Jobber address paste (optional, not TDA-required)",
] as const;

/** Prefix cells that Excel/Sheets would treat as formulas. */
function neutralizeCsvFormula(value: string): string {
  if (/^\s*[=+\-@]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function csvEscape(value: string): string {
  const safe = neutralizeCsvFormula(value);
  if (/[",\n\r]/.test(safe) || safe.startsWith("'")) {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return safe;
}

function joinLines(values: string[]): string {
  return values.filter(Boolean).join("; ");
}

function person(log: ApplicationLog, role: ApplicationLog["personnel"][number]["role"]) {
  return log.personnel.find((p) => p.role === role);
}

function yesBlank(flag: boolean): string {
  return flag ? "yes" : "";
}

export function logsToCsv(logs: ApplicationLog[]): string {
  const header = TDA_CSV_COLUMNS.map(csvEscape).join(",");
  const rows = logs.map((log) => {
    const pesticides = log.products.filter((p) => p.method !== "device");
    const devices = log.products.filter((p) => p.method === "device");
    const applying = person(log, "applying");
    const supervising = person(log, "supervising");
    const training = person(log, "receiving_training");
    const t = log.termite;
    const exampleNames = log.products.filter((p) => p.isExample).map((p) => p.name);
    const cells = [
      log.customerBillingName,
      log.customerBillingAddress,
      log.serviceAddress,
      log.poleLocation,
      joinLines(pesticides.map((p) => p.name)),
      joinLines(pesticides.map((p) => epaExportText(p))),
      joinLines(pesticides.filter((p) => p.is25b || !p.epaRegNo || p.isExample).map((p) => p.name)),
      joinLines(
        devices.map((p) => (p.isExample ? `${p.name} (${EXAMPLE_EPA_LABEL})` : p.name)),
      ),
      joinLines(
        devices.map((p) => {
          const count = p.deviceCount ? `${p.name}: ${p.deviceCount}` : p.name;
          return p.isExample ? `${count} (${EXAMPLE_EPA_LABEL})` : count;
        }),
      ),
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
      yesBlank(log.isTermite),
      log.isTermite && !t.isBait ? t.areaTreatedSqFt : "",
      log.isTermite ? yesBlank(t.isBait) : "",
      log.isTermite ? t.physicalBarrierMeasurement : "",
      log.isTermite ? t.diagramNote : "",
      log.isTermite ? yesBlank(t.isCommercialPretreat) : "",
      log.isTermite && t.isCommercialPretreat ? t.tankCount : "",
      log.isTermite && t.isCommercialPretreat ? t.tankGallons : "",
      log.isTermite && t.isCommercialPretreat ? t.startTime : "",
      log.isTermite && t.isCommercialPretreat ? t.stopTime : "",
      exampleNames.length > 0 ? joinLines(exampleNames.map((n) => `${n}: ${EXAMPLE_EPA_LABEL}`)) : "",
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
  a.download = "texas-tda-application-logs.csv";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
