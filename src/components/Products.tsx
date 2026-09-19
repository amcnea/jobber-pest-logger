import { useMemo, useState, type FormEvent } from "react";
import {
  EXAMPLE_EPA_LABEL,
  catalogHasExampleProducts,
  countExampleCatalogProducts,
  looksLikeSampleEpa,
  productEpaCaption,
} from "../catalog";
import { newId } from "../ids";
import { emptyShopProduct } from "../storage";
import {
  STARTER_CATALOG_DISCLAIMER,
  TEXAS_STARTER_CATALOG_VERSION,
  findShopMatchForStarter,
  searchTexasStarterCatalog,
  starterEpaCaption,
  starterToPendingShopProduct,
  type StarterProduct,
} from "../starterCatalog";
import type { ShopProduct } from "../types";

interface Props {
  catalog: ShopProduct[];
  onUpsert: (product: ShopProduct) => boolean;
  onDelete: (id: string) => void;
  onRemoveExamples: () => boolean;
}

interface DraftErrors {
  name?: string;
  epaRegNo?: string;
}

type ListFilter = "active" | "archived" | "all";
type KindFilter = "all" | "pesticide" | "device";

function toDraft(product: ShopProduct): ShopProduct {
  return {
    ...product,
    epaRegNo: product.epaRegNo ?? "",
    archived: product.archived === true,
  };
}

export function Products({ catalog, onUpsert, onDelete, onRemoveExamples }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ShopProduct>(() => emptyShopProduct());
  const [errors, setErrors] = useState<DraftErrors>({});
  const [query, setQuery] = useState("");
  const [listFilter, setListFilter] = useState<ListFilter>("active");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [starterQuery, setStarterQuery] = useState("");
  const [labelConfirmId, setLabelConfirmId] = useState<string | null>(null);
  const [labelConfirmed, setLabelConfirmed] = useState(false);
  const [pendingLabelIds, setPendingLabelIds] = useState<string[]>([]);

  function startAdd() {
    setAdding(true);
    setEditingId(null);
    setDraft(emptyShopProduct());
    setErrors({});
  }

  function startEdit(product: ShopProduct) {
    setAdding(false);
    setEditingId(product.id);
    setDraft(toDraft(product));
    setErrors({});
  }

  function cancel() {
    setAdding(false);
    setEditingId(null);
    setErrors({});
  }

  function validate(product: ShopProduct): DraftErrors {
    const next: DraftErrors = {};
    if (!product.name.trim()) next.name = "Name required";
    if (
      product.kind === "pesticide" &&
      !product.is25b &&
      !product.isExample &&
      !String(product.epaRegNo ?? "").trim()
    ) {
      next.epaRegNo = "EPA # required for registered pesticides (leave blank for 25(b) or examples)";
    }
    if (looksLikeSampleEpa(product.epaRegNo)) {
      next.epaRegNo =
        "SAMPLE-* looks like a placeholder; mark as Example seed or enter a real EPA #";
    }
    return next;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const nextErrors = validate(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const isExample = draft.isExample === true;
    const isDevice = draft.kind === "device";
    const epa = isExample || isDevice || draft.is25b ? null : String(draft.epaRegNo ?? "").trim() || null;
    const saved = onUpsert({
      ...draft,
      name: draft.name.trim(),
      epaRegNo: epa,
      is25b: isDevice ? false : draft.is25b,
      isExample,
      archived: draft.archived === true,
    });
    if (!saved) return;
    cancel();
  }

  function setArchived(product: ShopProduct, archived: boolean) {
    const saved = onUpsert({ ...product, archived });
    if (!saved) return;
    if (editingId === product.id) cancel();
  }

  function beginLabelConfirm(productId: string) {
    setLabelConfirmId(productId);
    setLabelConfirmed(false);
    setAdding(false);
    setEditingId(null);
  }

  function cancelLabelConfirm() {
    setLabelConfirmId(null);
    setLabelConfirmed(false);
  }

  function addStarterToCatalog(starter: StarterProduct) {
    const existing = findShopMatchForStarter(catalog, starter);
    if (existing) {
      if (existing.archived) {
        beginLabelConfirm(existing.id);
        setPendingLabelIds((ids) => (ids.includes(existing.id) ? ids : [...ids, existing.id]));
      } else {
        alert(`${existing.name} is already on your shop list.`);
      }
      return;
    }
    const pending = starterToPendingShopProduct(starter, newId());
    const saved = onUpsert(pending);
    if (!saved) return;
    setPendingLabelIds((ids) => [...ids, pending.id]);
    beginLabelConfirm(pending.id);
    // Show pending rows even when the Active filter is on.
    setListFilter("all");
  }

  function activateAfterLabelConfirm(product: ShopProduct) {
    if (!labelConfirmed) return;
    const saved = onUpsert({ ...product, archived: false });
    if (!saved) return;
    setPendingLabelIds((ids) => ids.filter((id) => id !== product.id));
    cancelLabelConfirm();
  }

  const form = (adding || editingId) && (
    <form className="card" onSubmit={submit} noValidate>
      <h3>{adding ? "Add product" : "Edit product"}</h3>
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
        Kind
        <select
          value={draft.kind}
          onChange={(e) => {
            const kind = e.target.value as ShopProduct["kind"];
            setErrors({});
            setDraft((d) => ({
              ...d,
              kind,
              is25b: kind === "device" ? false : d.is25b,
              epaRegNo: kind === "device" ? null : d.epaRegNo,
            }));
          }}
        >
          <option value="pesticide">Pesticide</option>
          <option value="device">Device</option>
        </select>
      </label>
      {draft.kind === "pesticide" && (
        <>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.is25b}
              onChange={(e) => {
                setErrors({});
                setDraft((d) => ({ ...d, is25b: e.target.checked }));
              }}
            />
            25(b) product (no EPA # required)
          </label>
          <label className="field">
            EPA registration number
            <input
              value={draft.epaRegNo ?? ""}
              onChange={(e) => {
                setErrors({});
                setDraft((d) => ({ ...d, epaRegNo: e.target.value }));
              }}
              placeholder={draft.isExample || draft.is25b ? "Leave blank" : "e.g. 12345-67"}
              disabled={draft.isExample}
            />
            {errors.epaRegNo && <span className="error">{errors.epaRegNo}</span>}
          </label>
        </>
      )}
      <label className="toggle">
        <input
          type="checkbox"
          checked={draft.isExample}
          onChange={(e) => {
            setErrors({});
            setDraft((d) => ({
              ...d,
              isExample: e.target.checked,
              epaRegNo: e.target.checked ? null : d.epaRegNo,
            }));
          }}
        />
        Example seed (exports as &quot;{EXAMPLE_EPA_LABEL}&quot;)
      </label>
      {draft.isExample && (
        <p className="hint">Example items never print a registration number in CSV or PDF.</p>
      )}
      <div className="sticky-save sticky-actions row">
        <button className="btn btn-primary" type="submit">
          Save product
        </button>
        <button className="btn btn-secondary" type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  );

  const exampleCount = countExampleCatalogProducts(catalog);
  const hasExamples = catalogHasExampleProducts(catalog);
  const archivedCount = catalog.filter((p) => p.archived).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((p) => {
      // Keep the product being edited / label-confirmed visible even if filters would hide it.
      if (editingId && p.id === editingId) return true;
      if (labelConfirmId && p.id === labelConfirmId) return true;
      if (pendingLabelIds.includes(p.id)) return true;
      if (listFilter === "active" && p.archived) return false;
      if (listFilter === "archived" && !p.archived) return false;
      if (kindFilter !== "all" && p.kind !== kindFilter) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.epaRegNo ?? ""} ${p.kind} ${p.is25b ? "25b" : ""} ${
        p.isExample ? "example" : ""
      }`.toLowerCase();
      return hay.includes(q);
    });
  }, [catalog, query, listFilter, kindFilter, editingId, labelConfirmId, pendingLabelIds]);

  const starterResults = useMemo(() => searchTexasStarterCatalog(starterQuery), [starterQuery]);

  return (
    <div>
      <h2>Shop product list</h2>
      <p className="hint">
        Office-managed list stored on this device (separate from logs). Techs can only pick from this
        list. Archive hides a product from New log without deleting it. Seeded examples are labeled as
        examples. Real CSV/PDF export stays disabled until examples are removed from the catalog and
        from any saved logs that still reference them.
      </p>

      {!adding && editingId === null && (
        <div className="card catalog-filters">
          <h3>Texas starter catalog</h3>
          <p className="hint" role="note">
            {STARTER_CATALOG_DISCLAIMER} Version {TEXAS_STARTER_CATALOG_VERSION}.
          </p>
          <label className="field">
            Search starter list
            <input
              type="search"
              value={starterQuery}
              onChange={(e) => setStarterQuery(e.target.value)}
              placeholder="Name or EPA #"
              autoComplete="off"
              disabled={labelConfirmId !== null}
            />
          </label>
          <p className="hint" role="status">
            Showing {starterResults.length} starter row{starterResults.length === 1 ? "" : "s"}. Add
            copies into your shop list; techs still only pick shop-owned active rows.
          </p>
          <div className="starter-results">
            {starterResults.map((starter) => {
              const match = findShopMatchForStarter(catalog, starter);
              const alreadyActive = match && !match.archived;
              const alreadyPending = match && match.archived;
              return (
                <div className="card-head" key={starter.id} style={{ marginBottom: "0.65rem" }}>
                  <div>
                    <strong>{starter.name}</strong>
                    <div>
                      <span className="chip">{starter.kind}</span>{" "}
                      <span className="chip">{starterEpaCaption(starter)}</span>
                      {alreadyActive && <span className="chip">on shop list</span>}
                      {alreadyPending && <span className="chip">pending label confirm</span>}
                    </div>
                  </div>
                  <div className="card-actions">
                    {alreadyActive ? (
                      <span className="hint">Already in catalog</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={labelConfirmId !== null}
                        onClick={() => addStarterToCatalog(starter)}
                      >
                        {alreadyPending ? "Confirm label…" : "Add to my catalog"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {hasExamples && !adding && (
        <div className="nag" role="status">
          <p>
            {exampleCount} example product{exampleCount === 1 ? "" : "s"} on this list. Remove them
            before a real office export.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              if (
                !confirm(
                  `Remove ${exampleCount} example product${exampleCount === 1 ? "" : "s"} from the shop catalog? Saved logs are not changed.`,
                )
              ) {
                return;
              }
              onRemoveExamples();
            }}
          >
            Remove example products from catalog
          </button>
        </div>
      )}
      {!adding && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={startAdd}
          style={{ marginBottom: "0.85rem" }}
          disabled={labelConfirmId !== null}
        >
          Add product
        </button>
      )}
      {adding && form}

      {!adding && catalog.length > 0 && (
        <div className="card catalog-filters">
          <label className="field">
            Search
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or EPA #"
              autoComplete="off"
              disabled={editingId !== null}
            />
          </label>
          <div className="row">
            <label className="field">
              Show
              <select
                value={listFilter}
                onChange={(e) => setListFilter(e.target.value as ListFilter)}
                disabled={editingId !== null}
              >
                <option value="active">Active</option>
                <option value="archived">Archived ({archivedCount})</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="field">
              Kind
              <select
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value as KindFilter)}
                disabled={editingId !== null}
              >
                <option value="all">All kinds</option>
                <option value="pesticide">Pesticide</option>
                <option value="device">Device</option>
              </select>
            </label>
          </div>
          <p className="hint" role="status">
            Showing {visible.length} of {catalog.length}
            {listFilter === "active" ? " (active)" : listFilter === "archived" ? " (archived)" : ""}.
          </p>
        </div>
      )}

      {catalog.length === 0 && !adding && (
        <p className="hint">No products yet. Add the pesticides and devices this shop actually uses.</p>
      )}
      {catalog.length > 0 && visible.length === 0 && !adding && (
        <p className="hint">No products match this search/filter.</p>
      )}
      {visible.map((product) => (
        <article className={`card${product.archived ? " card-archived" : ""}`} key={product.id}>
          {editingId === product.id ? (
            form
          ) : labelConfirmId === product.id ? (
            <div>
              <h3>Confirm label before activate</h3>
              <p className="hint">
                Check the physical product label. Name and EPA # on your shop list must match the
                label before this row becomes available on New log.
              </p>
              <p>
                <strong>{product.name}</strong>
              </p>
              <p className="hint">
                <span className="chip">{product.kind}</span>{" "}
                <span className="chip">{productEpaCaption(product)}</span>
              </p>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={labelConfirmed}
                  onChange={(e) => setLabelConfirmed(e.target.checked)}
                />
                I confirmed the product name and EPA # against the product label
              </label>
              <div className="sticky-save sticky-actions row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!labelConfirmed}
                  onClick={() => activateAfterLabelConfirm(product)}
                >
                  Confirm label &amp; activate
                </button>
                <button type="button" className="btn btn-secondary" onClick={cancelLabelConfirm}>
                  Leave archived
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="card-head">
                <div>
                  <strong>{product.name}</strong>
                  <div>
                    {product.archived && <span className="chip">archived</span>}{" "}
                    {pendingLabelIds.includes(product.id) && (
                      <span className="chip sample">needs label confirm</span>
                    )}{" "}
                    {product.isExample && <span className="chip sample">example</span>}{" "}
                    <span className="chip">{product.kind}</span>{" "}
                    <span className="chip">{productEpaCaption(product)}</span>
                  </div>
                </div>
                <div className="card-actions">
                  {product.archived && pendingLabelIds.includes(product.id) && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => beginLabelConfirm(product.id)}
                      disabled={labelConfirmId !== null}
                    >
                      Confirm label
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => startEdit(product)}
                    disabled={labelConfirmId !== null}
                  >
                    Edit
                  </button>
                  {!product.isExample && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={labelConfirmId !== null}
                      onClick={() => {
                        if (product.archived && pendingLabelIds.includes(product.id)) {
                          beginLabelConfirm(product.id);
                          return;
                        }
                        setArchived(product, !product.archived);
                      }}
                    >
                      {product.archived
                        ? pendingLabelIds.includes(product.id)
                          ? "Confirm label…"
                          : "Unarchive"
                        : "Archive"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={labelConfirmId !== null}
                    onClick={() => {
                      if (!confirm(`Delete ${product.name} from the shop list?`)) return;
                      onDelete(product.id);
                      setPendingLabelIds((ids) => ids.filter((id) => id !== product.id));
                      if (editingId === product.id) cancel();
                      if (labelConfirmId === product.id) cancelLabelConfirm();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </>
          )}
        </article>
      ))}
    </div>
  );
}