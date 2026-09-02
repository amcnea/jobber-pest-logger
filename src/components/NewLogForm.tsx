import { useMemo, useState, type FormEvent } from "react";
import { AMOUNT_UNITS, catalogPickerLabel, productEpaCaption } from "../catalog";
import { emptyLog, productFromCatalog, validateLog, withSaveFlags, type FieldErrors } from "../formDefaults";
import type { ApplicationLog, AppliedProduct, ShopProduct } from "../types";

interface Props {
  catalog: ShopProduct[];
  onSave: (log: ApplicationLog) => boolean;
}

export function NewLogForm({ catalog, onSave }: Props) {
  const [log, setLog] = useState<ApplicationLog>(() => emptyLog());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [picker, setPicker] = useState("");

  const pesticides = useMemo(() => catalog.filter((p) => p.kind === "pesticide"), [catalog]);
  const devices = useMemo(() => catalog.filter((p) => p.kind === "device"), [catalog]);

  function patch(partial: Partial<ApplicationLog>) {
    setErrors({});
    setLog((prev) => ({ ...prev, ...partial }));
  }

  function patchProduct(lineId: string, partial: Partial<AppliedProduct>) {
    setErrors({});
    setLog((prev) => ({
      ...prev,
      products: prev.products.map((p) => (p.lineId === lineId ? { ...p, ...partial } : p)),
    }));
  }

  function addFromCatalog(id: string) {
    const line = productFromCatalog(catalog, id);
    if (!line) return;
    setErrors({});
    setLog((prev) => ({ ...prev, products: [...prev.products, line] }));
    setPicker("");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const nextErrors = validateLog(log);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const savedOk = onSave(withSaveFlags(log));
    if (!savedOk) return;
    // App navigates to History on success and unmounts this form.
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
            required
            aria-required={true}
          />
          {errors.customerBillingName && <span className="error">{errors.customerBillingName}</span>}
        </label>
        <label className="field">
          Billing address <span className="req">*</span>
          <textarea
            value={log.customerBillingAddress}
            onChange={(e) => patch({ customerBillingAddress: e.target.value })}
            placeholder="Street, city, TX ZIP"
            required
            aria-required={true}
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
            required
            aria-required={true}
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
          <input
            type="date"
            value={log.dateUsed}
            onChange={(e) => patch({ dateUsed: e.target.value })}
            required
            aria-required={true}
          />
          {errors.dateUsed && <span className="error">{errors.dateUsed}</span>}
        </label>
        <label className="field">
          Target pest or purpose <span className="req">*</span>
          <input
            value={log.targetPestOrPurpose}
            onChange={(e) => patch({ targetPestOrPurpose: e.target.value })}
            placeholder="e.g. German cockroaches"
            required
            aria-required={true}
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
              required
              aria-required={true}
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
          Pick from the shop product list only — never type an EPA number on this form. Selecting a product
          fills the name and EPA # (blank for 25(b) and example seeds). Example seeds export as
          &quot;example / not a real EPA number&quot;.
        </p>
        {catalog.length === 0 && (
          <p className="error">The shop list is empty. Add products in the Products tab, then come back.</p>
        )}
        <label className="field">
          Add from shop list
          <select value={picker} onChange={(e) => setPicker(e.target.value)} disabled={catalog.length === 0}>
            <option value="">Select a product…</option>
            <optgroup label="Pesticides">
              {pesticides.map((p) => (
                <option key={p.id} value={p.id}>
                  {catalogPickerLabel(p)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Devices">
              {devices.map((p) => (
                <option key={p.id} value={p.id}>
                  {catalogPickerLabel(p)}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!picker}
          onClick={() => addFromCatalog(picker)}
          style={{ width: "100%", marginBottom: "0.75rem" }}
        >
          Add selected product
        </button>
        {errors.products && <p className="error">{errors.products}</p>}

        {log.products.map((p, i) => (
          <article className="card" key={p.lineId}>
            <div className="card-head">
              <div>
                <strong>{p.name}</strong>
                <div>
                  {p.isExample && <span className="chip sample">example</span>}{" "}
                  <span className="chip">{productEpaCaption(p)}</span>
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
                    required
                    aria-required={true}
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
                      required
                      aria-required={true}
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
                  required
                  aria-required={true}
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
                required={person.role === "applying"}
                aria-required={person.role === "applying"}
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
                required={person.role === "applying"}
                aria-required={person.role === "applying"}
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
        <p className="hint">
          § 7.144(b) fields stay hidden unless this stop is termite work. Diagram is a text note, not a
          drawing.
        </p>
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
                  patch({
                    termite: {
                      ...log.termite,
                      isBait: e.target.checked,
                      isCommercialPretreat: e.target.checked ? false : log.termite.isCommercialPretreat,
                    },
                  })
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
                placeholder="Linear feet or other measurement"
              />
            </label>
            <label className="field">
              Diagram note
              <textarea
                value={log.termite.diagramNote}
                onChange={(e) =>
                  patch({ termite: { ...log.termite, diagramNote: e.target.value } })
                }
                placeholder="Text note describing the diagram (no drawing capture)."
              />
            </label>
            {!log.termite.isBait && (
              <>
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
              </>
            )}
          </div>
        )}
      </section>

      <p className="hint">Records are kept 2 years. This app does not run a retention engine.</p>
      <div className="sticky-save">
        <button className="btn btn-primary" type="submit">
          Save application log
        </button>
      </div>
    </form>
  );
}
