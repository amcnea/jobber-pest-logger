import { ceDueStatus, formatCeDueLabel, formatLicenseDueLabel, licenseDueStatus } from "./dates";
import type { Person } from "./types";

export interface PersonWarning {
  personId: string;
  personName: string;
  messages: string[];
}

/** Shared-shop rows can omit ceDueDate; local storage already stores "". */
function ceDueDateText(person: Person): string {
  return typeof person.ceDueDate === "string" ? person.ceDueDate : "";
}

export function warningsForPerson(person: Person): string[] {
  const messages: string[] = [];
  const lic = formatLicenseDueLabel(person.licenseExpiry);
  if (lic) messages.push(lic);
  const ceDue = ceDueDateText(person);
  if (ceDue.trim()) {
    const ce = formatCeDueLabel(ceDue);
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
  const ceDue = ceDueDateText(person);
  const ce = ceDue.trim() ? ceDueStatus(ceDue) : "missing";
  if (lic === "overdue" || ce === "overdue") return "overdue";
  if (lic === "soon" || ce === "soon") return "soon";
  return null;
}
