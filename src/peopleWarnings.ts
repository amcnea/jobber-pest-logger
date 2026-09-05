import { ceDueStatus, formatCeDueLabel, formatLicenseDueLabel, licenseDueStatus } from "./dates";
import type { Person } from "./types";

export interface PersonWarning {
  personId: string;
  personName: string;
  messages: string[];
}

export function warningsForPerson(person: Person): string[] {
  const messages: string[] = [];
  const lic = formatLicenseDueLabel(person.licenseExpiry);
  if (lic) messages.push(lic);
  if (person.ceDueDate.trim()) {
    const ce = formatCeDueLabel(person.ceDueDate);
    if (ce) messages.push(ce);
  }
  return messages;
}

export function collectPeopleWarnings(people: Person[]): PersonWarning[] {
  return people
    .map((p) => ({
      personId: p.id,
      personName: p.name.trim() || "(unnamed)",
      messages: warningsForPerson(p),
    }))
    .filter((w) => w.messages.length > 0);
}

export function personHasWarning(person: Person): boolean {
  return warningsForPerson(person).length > 0;
}

export function personWarningTone(person: Person): "overdue" | "soon" | null {
  const lic = licenseDueStatus(person.licenseExpiry);
  const ce = person.ceDueDate.trim() ? ceDueStatus(person.ceDueDate) : "missing";
  if (lic === "overdue" || ce === "overdue") return "overdue";
  if (lic === "soon" || ce === "soon") return "soon";
  return null;
}
