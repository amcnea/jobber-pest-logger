import { useState, type FormEvent } from "react";
import { personHasWarning, personWarningTone, warningsForPerson } from "../peopleWarnings";
import { emptyPerson } from "../storage";
import type { Person, PersonnelRole } from "../types";

interface Props {
  people: Person[];
  onUpsert: (person: Person) => boolean;
  onDelete: (id: string) => void;
}

interface DraftErrors {
  name?: string;
  licenseNumber?: string;
  roleTags?: string;
  licenseExpiry?: string;
}

const ROLE_OPTIONS: { value: PersonnelRole; label: string }[] = [
  { value: "applying", label: "Applying" },
  { value: "supervising", label: "Supervising" },
  { value: "receiving_training", label: "Receiving training" },
];

function roleLabel(role: PersonnelRole): string {
  return ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;
}

export function People({ people, onUpsert, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Person>(() => emptyPerson());
  const [errors, setErrors] = useState<DraftErrors>({});

  function startAdd() {
    setAdding(true);
    setEditingId(null);
    setDraft(emptyPerson());
    setErrors({});
  }

  function startEdit(person: Person) {
    setAdding(false);
    setEditingId(person.id);
    setDraft({ ...person, ceDueDate: person.ceDueDate ?? "" });
    setErrors({});
  }

  function cancel() {
    setAdding(false);
    setEditingId(null);
    setErrors({});
  }

  function toggleRole(role: PersonnelRole) {
    setErrors({});
    setDraft((d) => {
      const has = d.roleTags.includes(role);
      const roleTags = has ? d.roleTags.filter((r) => r !== role) : [...d.roleTags, role];
      return { ...d, roleTags };
    });
  }

  function validate(person: Person): DraftErrors {
    const next: DraftErrors = {};
    if (!person.name.trim()) next.name = "Name required";
    if (!person.licenseNumber.trim()) next.licenseNumber = "License number required";
    if (person.roleTags.length === 0) next.roleTags = "Pick at least one default role tag";
    if (!person.licenseExpiry.trim()) next.licenseExpiry = "License expiry date required";
    return next;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const nextErrors = validate(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const saved = onUpsert({
      ...draft,
      name: draft.name.trim(),
      licenseNumber: draft.licenseNumber.trim(),
      licenseExpiry: draft.licenseExpiry.trim(),
      ceDueDate: draft.ceDueDate.trim(),
      roleTags: [...new Set(draft.roleTags)],
    });
    if (!saved) return;
    cancel();
  }

  const form = (adding || editingId) && (
    <form className="card" onSubmit={submit} noValidate>
      <h3>{adding ? "Add tech" : "Edit tech"}</h3>
      <label className="field">
        Name <span className="req">*</span>
        <input
          value={draft.name}
          onChange={(e) => {
            setErrors({});
            setDraft((d) => ({ ...d, name: e.target.value }));
          }}
          required
          aria-required={true}
        />
        {errors.name && <span className="error">{errors.name}</span>}
      </label>
      <label className="field">
        License number <span className="req">*</span>
        <input
          value={draft.licenseNumber}
          onChange={(e) => {
            setErrors({});
            setDraft((d) => ({ ...d, licenseNumber: e.target.value }));
          }}
          required
          aria-required={true}
        />
        {errors.licenseNumber && <span className="error">{errors.licenseNumber}</span>}
      </label>
      <fieldset className="fieldset">
        <legend>
          Default role tags <span className="req">*</span>
        </legend>
        <p className="hint">
          Defaults only — each new log has three separate roster picks so applying / supervising /
          receiving training can diverge per stop.
        </p>
        {ROLE_OPTIONS.map((opt) => (
          <label className="toggle" key={opt.value}>
            <input
              type="checkbox"
              checked={draft.roleTags.includes(opt.value)}
              onChange={() => toggleRole(opt.value)}
            />
            {opt.label}
          </label>
        ))}
        {errors.roleTags && <span className="error">{errors.roleTags}</span>}
      </fieldset>
      <label className="field">
        License expiry <span className="req">*</span>
        <input
          type="date"
          value={draft.licenseExpiry}
          onChange={(e) => {
            setErrors({});
            setDraft((d) => ({ ...d, licenseExpiry: e.target.value }));
          }}
          required
          aria-required={true}
        />
        {errors.licenseExpiry && <span className="error">{errors.licenseExpiry}</span>}
        <span className="hint">In-app warning when past due or within 30 days (not TDA-required).</span>
      </label>
      <label className="field">
        CE due date (optional)
        <input
          type="date"
          value={draft.ceDueDate}
          onChange={(e) => {
            setErrors({});
            setDraft((d) => ({ ...d, ceDueDate: e.target.value }));
          }}
        />
        <span className="hint">
          Separate year-end reminder in Nov/Dec for calendar-year CEUs (not the license 30-day window;
          not TDA-required). No SMS.
        </span>
      </label>
      <div className="row">
        <button className="btn btn-primary" type="submit">
          Save tech
        </button>
        <button className="btn btn-secondary" type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <div>
      <h2>People / roster</h2>
      <p className="hint">
        Office-managed tech roster on this device (key separate from logs and catalog). New-log form
        uses three separate roster picks. License warns at 30 days; CE warns toward year-end
        (Nov/Dec). Device-local dates. No SMS.
      </p>
      {!adding && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={startAdd}
          style={{ marginBottom: "0.85rem" }}
        >
          Add tech
        </button>
      )}
      {adding && form}
      {people.length === 0 && !adding && (
        <p className="hint">No techs yet. Add people the office uses on application logs.</p>
      )}
      {people.map((person) => {
        const tone = personWarningTone(person);
        const warns = warningsForPerson(person);
        return (
          <article className={`card${tone ? ` card-warn-${tone}` : ""}`} key={person.id}>
            {editingId === person.id ? (
              form
            ) : (
              <div className="card-head">
                <div>
                  <strong>{person.name}</strong>
                  <div>
                    <span className="chip">{person.licenseNumber || "no license #"}</span>{" "}
                    {person.roleTags.map((r) => (
                      <span className="chip" key={r}>
                        {roleLabel(r)}
                      </span>
                    ))}
                  </div>
                  <div className="log-meta" style={{ marginTop: "0.35rem" }}>
                    License expires {person.licenseExpiry || "—"}
                    {person.ceDueDate ? ` · CE due ${person.ceDueDate}` : ""}
                  </div>
                  {personHasWarning(person) && (
                    <ul className="warn-list">
                      {warns.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <button type="button" className="btn btn-secondary" onClick={() => startEdit(person)}>
                    Edit
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      if (!confirm(`Delete ${person.name || "this tech"} from the roster?`)) return;
                      onDelete(person.id);
                      if (editingId === person.id) cancel();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
