import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
  TEXAS_COMMON_STARTER,
  TEXAS_STARTER_CATALOG_VERSION,
  addPendingLabelConfirm,
  clearPendingLabelConfirm,
  findShopMatchForStarter,
  listPendingLabelConfirmIds,
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
  const [pendingLabelIds, setPendingLabelIds] = useState<string[]>(() => {
    const read = listPendingLabelConfirmIds();
    return read.ok ? read.ids : [];
  });
  // Ref tracks pending ids for sync reads in helpers; update only in
  // event handlers / effects (never during render) so discarded renders cannot leak.
  const pendingLabelIdsRef = useRef(pendingLabelIds);
  const [labelConfirmStoreUnavailable, setLabelConfirmStoreUnavailable] = useState(() => {
    const read = listPendingLabelConfirmIds();
    return !read.ok;
  });
  /** Ids we asked App to delete; clear pending store only after they leave catalog. */
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);

  /**
   * After every successful storage read, sync durable IDs with pendingLabelIds.
   * Keep unavailable set while any in-memory pending ID is not durably represented.
   * Clear unavailable only when durable and in-memory pending state fully match.
   * Never recover a malformed store by resetting storage to [] — that would drop
   * pending IDs and allow unarchive without confirm (fail closed instead).
   */
  function reconcilePendingLabelState() {
    const read = listPendingLabelConfirmIds();
    if (!read.ok) {
      setLabelConfirmStoreUnavailable(true);
      // In-memory only: require confirm for archived starter-matched rows while
      // storage is unreadable. Never reset the durable key to [] (would drop IDs).
      const heuristic: string[] = [];
      for (const starter of TEXAS_COMMON_STARTER) {
        const match = findShopMatchForStarter(catalog, starter);
        if (match && match.archived && match.isExample !== true) {
          heuristic.push(match.id);
        }
      }
      if (heuristic.length > 0) {
        const union = Array.from(new Set([...pendingLabelIdsRef.current, ...heuristic]));
        pendingLabelIdsRef.current = union;
        setPendingLabelIds(union);
      }
      return;
    }

    const durableIds = read.ids;
    const durableSet = new Set(durableIds);
    const memoryIds = pendingLabelIdsRef.current;

    // Union: all durable ids must be in memory.
    const union = Array.from(new Set([...memoryIds, ...durableIds]));

    // Persist any in-memory id not yet durable.
    let persistFailed = false;
    for (const id of memoryIds) {
      if (!durableSet.has(id)) {
        if (!addPendingLabelConfirm(id)) {
          persistFailed = true;
        }
      }
    }

    const after = listPendingLabelConfirmIds();
    if (!after.ok) {
      setLabelConfirmStoreUnavailable(true);
      pendingLabelIdsRef.current = union;
      setPendingLabelIds(union);
      return;
    }

    // Prefer durable set ∪ any in-memory ids that still could not be persisted.
    const stillOnlyInMemory = memoryIds.filter((id) => !after.ids.includes(id));
    const reconciled = Array.from(new Set([...after.ids, ...stillOnlyInMemory]));
    pendingLabelIdsRef.current = reconciled;
    setPendingLabelIds(reconciled);

    if (!persistFailed && stillOnlyInMemory.length === 0) {
      setLabelConfirmStoreUnavailable(false);
    } else {
      setLabelConfirmStoreUnavailable(true);
    }
  }

  // Recover: re-read durable pending and clear unavailable only when fully reconciled.
  useEffect(() => {
    reconcilePendingLabelState();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount recovery only
  }, []);

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

  function markPendingLabel(id: string) {
    // Always keep an in-memory guard; any failed persist → fail closed.
    const next = pendingLabelIdsRef.current.includes(id)
      ? pendingLabelIdsRef.current
      : [...pendingLabelIdsRef.current, id];
    pendingLabelIdsRef.current = next;
    setPendingLabelIds(next);
    const persisted = addPendingLabelConfirm(id);
    if (!persisted) {
      setLabelConfirmStoreUnavailable(true);
    }
    // Do not clear unavailable merely because one add returned true — reconcile decides.
    reconcilePendingLabelState();
  }

  function clearPendingLabel(id: string) {
    const cleared = clearPendingLabelConfirm(id);
    if (!cleared) {
      // Retain in-memory guard when persist clear fails; do not clear unavailable here.
      setLabelConfirmStoreUnavailable(true);
      // Opportunistically pull durable ids into memory without clearing the flag.
      const read = listPendingLabelConfirmIds();
      if (read.ok) {
        const union = Array.from(new Set([...pendingLabelIdsRef.current, ...read.ids]));
        pendingLabelIdsRef.current = union;
        setPendingLabelIds(union);
      }
      return false;
    }
    const next = pendingLabelIdsRef.current.filter((x) => x !== id);
    pendingLabelIdsRef.current = next;
    setPendingLabelIds(next);
    // Do not clear unavailable merely because one clear returned true — reconcile decides.
    reconcilePendingLabelState();
    return true;
  }

  function needsLabelConfirm(id: string): boolean {
    return pendingLabelIds.includes(id);
  }

  function setArchived(product: ShopProduct, archived: boolean) {
    // Fail closed: block all unarchive/activate while pending-id storage is unreadable.
    if (!archived && labelConfirmStoreUnavailable) {
      return;
    }
    // Never activate a starter-pending row without label confirmation.
    if (!archived && needsLabelConfirm(product.id)) {
      beginLabelConfirm(product.id);
      return;
    }
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
        markPendingLabel(existing.id);
        beginLabelConfirm(existing.id);
      } else {
        alert(`${existing.name} is already on your shop list.`);
      }
      return;
    }
    const pending = starterToPendingShopProduct(starter, newId());
    // Persist guard before catalog row so reload cannot unarchive without confirm.
    if (!addPendingLabelConfirm(pending.id)) {
      setLabelConfirmStoreUnavailable(true);
      return;
    }
    const saved = onUpsert(pending);
    if (!saved) {
      if (!clearPendingLabelConfirm(pending.id)) setLabelConfirmStoreUnavailable(true);
      return;
    }
    const nextPending = pendingLabelIdsRef.current.includes(pending.id)
      ? pendingLabelIdsRef.current
      : [...pendingLabelIdsRef.current, pending.id];
    pendingLabelIdsRef.current = nextPending;
    setPendingLabelIds(nextPending);
    reconcilePendingLabelState();
    beginLabelConfirm(pending.id);
    // Show pending rows even when the Active filter is on.
    setListFilter("all");
  }

  function activateAfterLabelConfirm(product: ShopProduct) {
    if (!labelConfirmed) return;
    if (labelConfirmStoreUnavailable) return;
    // Do not expose until upsert AND clearPending both succeed.
    const saved = onUpsert({ ...product, archived: false });
    if (!saved) {
      // Leave durable pending intact — no clear was attempted.
      return;
    }
    if (!clearPendingLabel(product.id)) {
      // Clear failed: re-archive so NewLogForm cannot pick it; keep confirm open.
      const reArchived = onUpsert({ ...product, archived: true });
      setLabelConfirmStoreUnavailable(true);
      if (!reArchived) {
        alert(
          `${product.name} is active but label confirmation could not be saved. Archive this product manually before techs use it.`,
        );
      }
      return; // keep confirm open
    }
    cancelLabelConfirm();
  }


  // Clear pending store ids only after a delete we requested and the row is actually gone.
  // Use clearPendingLabel (not clearPendingLabelConfirm + unconditional filter) so a failed
  // storage clear retains the in-memory guard.
  useEffect(() => {
    if (pendingDeleteIds.length === 0) return;
    const present = new Set(catalog.map((p) => p.id));
    const gone = pendingDeleteIds.filter((id) => !present.has(id));
    if (gone.length === 0) return;
    for (const id of gone) {
      clearPendingLabel(id);
    }
    setPendingDeleteIds((ids) => ids.filter((id) => present.has(id)));
  }, [catalog, pendingDeleteIds]);

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

      {labelConfirmStoreUnavailable && (
        <div className="nag" role="alert">
          <p>
            Label-confirm storage is unavailable on this device. Activating or unarchiving products is
            blocked until storage works again (fail closed — pending confirmations are not wiped).
          </p>
        </div>
      )}

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
                  disabled={!labelConfirmed || labelConfirmStoreUnavailable}
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
                    {needsLabelConfirm(product.id) && (
                      <span className="chip sample">needs label confirm</span>
                    )}{" "}
                    {product.isExample && <span className="chip sample">example</span>}{" "}
                    <span className="chip">{product.kind}</span>{" "}
                    <span className="chip">{productEpaCaption(product)}</span>
                  </div>
                </div>
                <div className="card-actions">
                  {product.archived && needsLabelConfirm(product.id) && (
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
                      disabled={
                        labelConfirmId !== null ||
                        (product.archived &&
                          labelConfirmStoreUnavailable &&
                          !needsLabelConfirm(product.id))
                      }
                      onClick={() => {
                        if (product.archived && labelConfirmStoreUnavailable && !needsLabelConfirm(product.id)) {
                          return;
                        }
                        if (product.archived && needsLabelConfirm(product.id)) {
                          beginLabelConfirm(product.id);
                          return;
                        }
                        setArchived(product, !product.archived);
                      }}
                    >
                      {product.archived
                        ? needsLabelConfirm(product.id)
                          ? "Confirm label…"
                          : labelConfirmStoreUnavailable
                            ? "Unarchive blocked"
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
                      setPendingDeleteIds((ids) =>
                        ids.includes(product.id) ? ids : [...ids, product.id],
                      );
                      // Pending clear waits until catalog no longer contains this id (effect above).
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