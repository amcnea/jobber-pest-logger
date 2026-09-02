import { useMemo, useState, type FormEvent } from "react";
import { AMOUNT_UNITS, SAMPLE_CATALOG } from "../sampleCatalog";
import { emptyLog, productFromCatalog, validateLog, type FieldErrors } from "../formDefaults";
import type { ApplicationLog, AppliedProduct } from "../types";

interface Props {
  onSave: (log: ApplicationLog) => boolean;
}

export function NewLogForm({ onSave }: Props) {
  const [log, setLog] = useState<ApplicationLog>(() => emptyLog());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const [picker, setPicker] = useState("");

  const pesticides = useMemo(
    () => SAMPLE_CATALOG.filter((p) => p.kind === "pesticide"),
    [],
  );
  const devices = useMemo(() => SAMPLE_CATALOG.filter((p) => p.kind === "device"), []);

  function patch(partial: Partial<ApplicationLog>) {
    setSaved(false);
    setErrors({});
    setLog((prev) => ({ ...prev, ...partial }));
  }

  function patchProduct(lineId: string, partial: Partial<AppliedProduct>) {
    setSaved(false);
    setErrors({});
    setLog((prev) => ({
      ...prev,
      products: prev.products.map((p) => (p.lineId === lineId ? { ...p, ...partial } : p)),
    }));
  }

  function addFromCatalog(id: string) {
    const line = productFromCatalog(id);
    if (!line) return;
    setSaved(false);
    setErrors({});
    setLog((prev) => ({ ...prev, products: [...prev.products, line] }));
    setPicker("");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const nextErrors = validateLog(log);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const savedOk = onSave({ ...log, createdAt: new Date().toISOString(), sampleData: true });
    if (!savedOk) {
      setSaved(false);
      return;
    }
    setSaved(true);
    setLog(emptyLog());
    setErrors({});
  }

  return (
    <form onSubmit={submit} noValidate>
      <section className="section">
        <h2>Jobber link</h2>
        <p className="hint">Optional paste-on to tie this stop to Jobber. Not a TDA field.</p>
        <label className="field">
          Jobber job #
          <input
            value={log.jobberJobNumber}
            onChange={(e) => patch({ jobberJobNumber: e.target.value })}
            placeholder="e.g. 1042"
          />
        </label>
        <label className="field">
          Jobber address paste
          <input
            value={log.jobberAddress}
            onChange={(e) => patch({ jobberAddress: e.target.value })}
            placeholder="Copy from the Jobber job if useful"
          />
        </label>
      </section>

      <section className="section">
        <h2>Customer billing</h2>
        <p className="hint">§ 7.144(a) — customer billing name and address.</p>
        <label className="field">
          Billing name <span className="req">*</span>
          <input
            value={log.customerBillingName}
            onChange={(e) => patch({ customerBillingName: e.target.value })}
            autoComplete="organization"
          />
          {errors.customerBillingName && <span className="error">{errors.customerBillingName}</span>}
        </label>
        <label className="field">
          Billing address <span className="req">*</span>
          <textarea
            value={log.customerBillingAddress}
            onChange={(e) => patch({ customerBillingAddress: e.target.value })}
            placeholder="Street, city, TX ZIP"
          />
          {errors.customerBillingAddress && <span className="error">{errors.customerBillingAddress}</span>}
        </label>
      </section>

      <section className="section">
        <h2>Service location</h2>
        <label className="field">
          Service address <span className="req">*</span>
          <textarea
            value={log.serviceAddress}
            onChange={(e) => patch({ serviceAddress: e.target.value })}
            placeholder="Where the application was made"
          />
          {errors.serviceAddress && <span className="error">{errors.serviceAddress}</span>}
        </label>
        <label className="field">
          Pole location
          <input
            value={log.poleLocation}
            onChange={(e) => patch({ poleLocation: e.target.value })}
            placeholder="Only if utility-pole retreatment"
          />
        </label>
      </section>

      <section className="section">
        <h2>Date, pest, shop</h2>
        <label className="field">
          Date used <span className="req">*</span>
          <input type="date" value={log.dateUsed} onChange={(e) => patch({ dateUsed: e.target.value })} />
          {errors.dateUsed && <span className="error">{errors.dateUsed}</span>}
        </label>
        <label className="field">
          Target pest or purpose <span className="req">*</span>
          <input
            value={log.targetPestOrPurpose}
            onChange={(e) => patch({ targetPestOrPurpose: e.target.value })}
            placeholder="e.g. German cockroaches"
          />
          {errors.targetPestOrPurpose && <span className="error">{errors.targetPestOrPurpose}</span>}
        </label>
        <div className="row">
          <label className="field">
            Shop TPCL number <span className="req">*</span>
            <input
              value={log.shopTpclNumber}
              onChange={(e) => patch({ shopTpclNumber: e.target.value })}
              placeholder="TPCL"
            />
            {errors.shopTpclNumber && <span className="error">{errors.shopTpclNumber}</span>}
          </label>
          <label className="field">
            TPCL letter (if any)
            <input
              value={log.shopTpclLetter}
              onChange={(e) => patch({ shopTpclLetter: e.target.value })}
              maxLength={4}
            />
          </label>
        </div>
      </section>

      <section className="section">
        <h2>Pesticides and devices</h2>
        <p className="hint">
          EPA # is a picker from the <strong>SAMPLE</strong> catalog — never type a registration number.
          25(b) products are recorded even with no EPA #. Not EPA data.
        </p>
        <label className="field">
          Add from SAMPLE catalog
          <select value={picker} onChange={(e) => addFromCatalog(e.target.value)}>
            <option value="">Select a sample product…</option>
            <optgroup label="Sample pesticides">
              {pesticides.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.is25b ? "(25(b) — no EPA #)" : `(${p.epaRegNo})`}
                </option>
              ))}
            </optgroup>
            <optgroup label="Sample devices">
              {devices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (device)
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        {errors.products && <p className="error">{errors.products}</p>}

        {log.products.map((p, i) => (
          <article className="card" key={p.lineId}>
            <div className="card-head">
              <div>
                <strong>{p.name}</strong>
                <div>
                  <span className="chip sample">SAMPLE</span>{" "}
                  {p.is25b ? (
                    <span className="chip">25(b) · no EPA #</span>
                  ) : p.method === "device" ? (
                    <span className="chip">device</span>
                  ) : (
                    <span className="chip">EPA {p.epaRegNo}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() =>
                  patch({ products: log.products.filter((x) => x.lineId !== p.lineId) })
                }
              >
                Remove
              </button>
            </div>

            {p.method !== "device" && (
              <label className="field">
                How applied
                <select
                  value={p.method}
                  onChange={(e) =>
                    patchProduct(p.lineId, { method: e.target.value as AppliedProduct["method"] })
                  }
                >
                  <option value="rtu">RTU (AI % unchanged)</option>
                  <option value="mixed">Mixed on site</option>
                </select>
              </label>
            )}

            {p.method === "rtu" && (
              <div className="row">
                <label className="field">
                  Total RTU amount <span className="req">*</span>
                  <input
                    value={p.rtuAmount}
                    onChange={(e) => patchProduct(p.lineId, { rtuAmount: e.target.value })}
                    inputMode="decimal"
                  />
                  {errors[`product-${i}-rtu`] && <span className="error">{errors[`product-${i}-rtu`]}</span>}
                </label>
                <label className="field">
                  Unit
                  <select
                    value={p.rtuUnit}
                    onChange={(e) => patchProduct(p.lineId, { rtuUnit: e.target.value })}
                  >
                    {AMOUNT_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {p.method === "mixed" && (
              <>
                <p className="hint">Enter mixing rate and/or % AI, plus total material applied.</p>
                <label className="field">
                  Mixing rate
                  <input
                    value={p.mixingRate}
                    onChange={(e) => patchProduct(p.lineId, { mixingRate: e.target.value })}
                    placeholder="e.g. 1 oz / gal"
                  />
                </label>
                <label className="field">
                  % AI
                  <input
                    value={p.percentAi}
                    onChange={(e) => patchProduct(p.lineId, { percentAi: e.target.value })}
                    inputMode="decimal"
                    placeholder="e.g. 0.06"
                  />
                </label>
                {errors[`product-${i}-mix`] && <p className="error">{errors[`product-${i}-mix`]}</p>}
                <div className="row">
                  <label className="field">
                    Total material applied <span className="req">*</span>
                    <input
                      value={p.mixedTotal}
                      onChange={(e) => patchProduct(p.lineId, { mixedTotal: e.target.value })}
                      inputMode="decimal"
                    />
                    {errors[`product-${i}-total`] && (
                      <span className="error">{errors[`product-${i}-total`]}</span>
                    )}
                  </label>
                  <label className="field">
                    Unit
                    <select
                      value={p.mixedUnit}
                      onChange={(e) => patchProduct(p.lineId, { mixedUnit: e.target.value })}
                    >
                      {AMOUNT_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            )}

            {p.method === "device" && (
              <label className="field">
                Device count <span className="req">*</span>
                <input
                  value={p.deviceCount}
                  onChange={(e) => patchProduct(p.lineId, { deviceCount: e.target.value })}
                  inputMode="numeric"
                />
                {errors[`product-${i}-device`] && (
                  <span className="error">{errors[`product-${i}-device`]}</span>
                )}
              </label>
            )}
          </article>
        ))}
      </section>

      <section className="section">
        <h2>People and licenses</h2>
        <p className="hint">
          Name and license number of the person(s) applying, supervising, and receiving training.
        </p>
        {log.personnel.map((person, idx) => (
          <div className="card" key={person.role}>
            <strong>
              {person.role === "applying"
                ? "Applying"
                : person.role === "supervising"
                  ? "Supervising"
                  : "Receiving training"}
              {person.role === "applying" ? <span className="req"> *</span> : " (if any)"}
            </strong>
            <label className="field">
              Name
              <input
                value={person.name}
                onChange={(e) => {
                  const personnel = log.personnel.map((x, i) =>
                    i === idx ? { ...x, name: e.target.value } : x,
                  );
                  patch({ personnel });
                }}
              />
              {person.role === "applying" && errors.applyingName && (
                <span className="error">{errors.applyingName}</span>
              )}
            </label>
            <label className="field">
              License number
              <input
                value={person.licenseNumber}
                onChange={(e) => {
                  const personnel = log.personnel.map((x, i) =>
                    i === idx ? { ...x, licenseNumber: e.target.value } : x,
                  );
                  patch({ personnel });
                }}
              />
              {person.role === "applying" && errors.applyingLicense && (
                <span className="error">{errors.applyingLicense}</span>
              )}
            </label>
          </div>
        ))}
      </section>

      <section className="section">
        <h2>Termite extras</h2>
        <p className="hint">§ 7.144(b) fields stay hidden unless this stop is termite work. Stub is enough for v1.</p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={log.isTermite}
            onChange={(e) => patch({ isTermite: e.target.checked })}
          />
          This stop is termite work
        </label>
        {log.isTermite && (
          <div className="card">
            <label className="toggle">
              <input
                type="checkbox"
                checked={log.termite.isBait}
                onChange={(e) =>
                  patch({ termite: { ...log.termite, isBait: e.target.checked } })
                }
              />
              Bait system (area treated N/A)
            </label>
            {!log.termite.isBait && (
              <label className="field">
                Area treated (sq ft)
                <input
                  value={log.termite.areaTreatedSqFt}
                  onChange={(e) =>
                    patch({ termite: { ...log.termite, areaTreatedSqFt: e.target.value } })
                  }
                  inputMode="decimal"
                />
              </label>
            )}
            <label className="field">
              Physical-barrier measurement
              <input
                value={log.termite.physicalBarrierMeasurement}
                onChange={(e) =>
                  patch({
                    termite: { ...log.termite, physicalBarrierMeasurement: e.target.value },
                  })
                }
              />
            </label>
            <label className="field">
              Diagram placeholder
              <textarea
                value={log.termite.diagramNote}
                onChange={(e) =>
                  patch({ termite: { ...log.termite, diagramNote: e.target.value } })
                }
                placeholder="v1 stub — no drawing capture. Note where a diagram would attach."
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={log.termite.isCommercialPretreat}
                onChange={(e) =>
                  patch({
                    termite: { ...log.termite, isCommercialPretreat: e.target.checked },
                  })
                }
              />
              Commercial pretreat (not baits / wood / barriers)
            </label>
            {log.termite.isCommercialPretreat && (
              <>
                <div className="row">
                  <label className="field">
                    Tank count
                    <input
                      value={log.termite.tankCount}
                      onChange={(e) =>
                        patch({ termite: { ...log.termite, tankCount: e.target.value } })
                      }
                      inputMode="numeric"
                    />
                  </label>
                  <label className="field">
                    Tank gallons
                    <input
                      value={log.termite.tankGallons}
                      onChange={(e) =>
                        patch({ termite: { ...log.termite, tankGallons: e.target.value } })
                      }
                      inputMode="decimal"
                    />
                  </label>
                </div>
                <div className="row">
                  <label className="field">
                    Start time
                    <input
                      type="time"
                      value={log.termite.startTime}
                      onChange={(e) =>
                        patch({ termite: { ...log.termite, startTime: e.target.value } })
                      }
                    />
                  </label>
                  <label className="field">
                    Stop time
                    <input
                      type="time"
                      value={log.termite.stopTime}
                      onChange={(e) =>
                        patch({ termite: { ...log.termite, stopTime: e.target.value } })
                      }
                    />
                  </label>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <p className="hint">Records are kept 2 years. This placeholder does not run a retention engine.</p>
      {saved && <p className="ok">Saved on this device.</p>}
      <div className="sticky-save">
        <button className="btn btn-primary" type="submit">
          Save application log
        </button>
      </div>
    </form>
  );
}
