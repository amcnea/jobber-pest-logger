import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
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
  filterStarters25bOnly,
  filterStartersByShopStatus,
  findShopMatchForStarter,
  formatStarterResultCount,
  listPendingLabelConfirmIds,
  searchTexasStarterCatalog,
  sortStarters,
  starterEpaCaption,
  starterShopState,
  starterToPendingShopProduct,
  type StarterKindFilter,
  type StarterShopStatusFilter,
  type StarterSortOrder,
  type StarterProduct,
} from "../starterCatalog";
import { highlightSegments } from "../starterCatalog/highlight";
import {
  CSV_FIELD_LABELS,
  CSV_IMPORT_MAX_BYTES,
  csvTooLargeMessage,
  parseCatalogCsv,
} from "../starterCatalog/csvImport";
import {
  buildCsvImportPreview,
  csvCandidateToShopProduct,
  type CsvImportPreview,
} from "../starterCatalog/csvImportPreview";
import type { ShopProduct } from "../types";

/** Render text with query matches wrapped in <mark> (plain React children, no raw HTML). */
function renderHighlighted(text: string, query: string) {
  return highlightSegments(text, query).map((seg, i) =>
    seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
  );
}

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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Short preview summary for the CSV import (also announced politely). */
function csvPreviewSummary(preview: CsvImportPreview, include: boolean[]): string {
  const toAdd = include.filter(Boolean).length;
  const dupes = preview.rows.filter((r) => r.duplicate !== null).length;
  const needLook = preview.rows.filter((r) => r.duplicate !== null || r.problems.length > 0).length;
  const parts = [plural(preview.rows.length, "row read", "rows read"), `${toAdd} to add`];
  if (dupes > 0) parts.push(plural(dupes, "possible duplicate", "possible duplicates"));
  if (needLook > 0) parts.push(`${needLook} ${needLook === 1 ? "needs" : "need"} a look`);
  if (preview.fileProblems.length > 0) {
    parts.push(plural(preview.fileProblems.length, "file note", "file notes"));
  }
  return `${parts.join(". ")}.`;
}

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
  const [starterKindFilter, setStarterKindFilter] = useState<StarterKindFilter>("all");
  const [starter25bOnly, setStarter25bOnly] = useState(false);
  const [starterShopStatus, setStarterShopStatus] = useState<StarterShopStatusFilter>("all");
  const [starterSort, setStarterSort] = useState<StarterSortOrder>("list");
  const starterSearchRef = useRef<HTMLInputElement>(null);
  const starterRowIdPrefix = useId();
  /** Polite screen-reader message for starter Add / label-confirm outcomes. */
  const [starterAnnouncement, setStarterAnnouncementText] = useState("");
  const starterAnnouncementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // #152: clear the polite live region, then set the message on the next task so an
  // identical repeat (e.g. the same failure twice) is still announced.
  function setStarterAnnouncement(message: string) {
    if (starterAnnouncementTimerRef.current !== null) clearTimeout(starterAnnouncementTimerRef.current);
    setStarterAnnouncementText("");
    starterAnnouncementTimerRef.current = setTimeout(() => {
      starterAnnouncementTimerRef.current = null;
      setStarterAnnouncementText(message);
    }, 0);
  }
  useEffect(
    () => () => {
      if (starterAnnouncementTimerRef.current !== null) clearTimeout(starterAnnouncementTimerRef.current);
    },
    [],
  );
  /** Heading of the open label-confirm panel; receives focus when the panel opens. */
  const labelConfirmHeadingRef = useRef<HTMLHeadingElement>(null);
  /** Control that opened label confirm; focus returns here (or to starter search) on close. */
  const labelConfirmReturnFocusRef = useRef<HTMLElement | null>(null);
  const prevLabelConfirmIdRef = useRef<string | null>(null);
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
  /** CSV import preview (nothing is saved until "Add N to shop catalog"). */
  const [csvPreview, setCsvPreview] = useState<CsvImportPreview | null>(null);
  const [csvInclude, setCsvInclude] = useState<boolean[]>([]);
  /** Preview row indexes already saved (after a partial add that stopped on an error). */
  const [csvAdded, setCsvAdded] = useState<boolean[]>([]);
  const [csvFileName, setCsvFileName] = useState("");
  const csvFileRef = useRef<HTMLInputElement>(null);
  const csvPreviewHeadingRef = useRef<HTMLHeadingElement>(null);
  /** Bumped on each file pick / cancel so a slow read cannot open a stale preview. */
  const csvReadTokenRef = useRef(0);
  const csvIdPrefix = useId();
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
    if (labelConfirmId === null) {
      const active = document.activeElement;
      labelConfirmReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
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
      setStarterAnnouncement(
        `Could not add ${starter.name}: label-confirm storage is unavailable on this device.`,
      );
      return;
    }
    const saved = onUpsert(pending);
    if (!saved) {
      if (!clearPendingLabelConfirm(pending.id)) setLabelConfirmStoreUnavailable(true);
      setStarterAnnouncement(`Could not add ${starter.name} to the shop list.`);
      return;
    }
    const nextPending = pendingLabelIdsRef.current.includes(pending.id)
      ? pendingLabelIdsRef.current
      : [...pendingLabelIdsRef.current, pending.id];
    pendingLabelIdsRef.current = nextPending;
    setPendingLabelIds(nextPending);
    reconcilePendingLabelState();
    beginLabelConfirm(pending.id);
    setStarterAnnouncement(
      `${starter.name} added to the shop list as archived. Confirm the label to activate it.`,
    );
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
    setStarterAnnouncement(`${product.name} is now active on the shop list.`);
  }

  // Keyboard / screen-reader focus: move into the label-confirm panel when it opens
  // (the control that opened it becomes disabled), and restore focus when it closes.
  useEffect(() => {
    const prev = prevLabelConfirmIdRef.current;
    prevLabelConfirmIdRef.current = labelConfirmId;
    if (labelConfirmId !== null && labelConfirmId !== prev) {
      labelConfirmHeadingRef.current?.focus();
      return;
    }
    if (labelConfirmId === null && prev !== null) {
      const target = labelConfirmReturnFocusRef.current;
      labelConfirmReturnFocusRef.current = null;
      if (
        target &&
        target.isConnected &&
        !(target instanceof HTMLButtonElement && target.disabled)
      ) {
        target.focus();
      } else {
        starterSearchRef.current?.focus();
      }
    }
  }, [labelConfirmId]);


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

  function openCsvPreview(preview: CsvImportPreview, fileName: string) {
    const include = preview.rows.map((r) => r.includeByDefault);
    setCsvPreview(preview);
    setCsvInclude(include);
    setCsvAdded(preview.rows.map(() => false));
    setCsvFileName(fileName);
    setStarterAnnouncement(`Import preview for ${fileName}: ${csvPreviewSummary(preview, include)}`);
  }

  function closeCsvPreview() {
    csvReadTokenRef.current += 1;
    setCsvPreview(null);
    setCsvInclude([]);
    setCsvAdded([]);
    setCsvFileName("");
    if (csvFileRef.current) csvFileRef.current.value = "";
  }

  async function onCsvFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    // #177: clear right away so picking the same file again still fires change
    // (after an oversize file, a failed read, a preview, or a Cancel).
    input.value = "";
    const token = ++csvReadTokenRef.current;
    if (!file) return;
    if (file.size > CSV_IMPORT_MAX_BYTES) {
      openCsvPreview({ rows: [], fileProblems: [csvTooLargeMessage()] }, file.name);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (token !== csvReadTokenRef.current) return;
      setStarterAnnouncement("Needs a look: could not read that file.");
      return;
    }
    if (token !== csvReadTokenRef.current) return;
    openCsvPreview(buildCsvImportPreview(parseCatalogCsv(text), catalog), file.name);
  }

  function addCsvRowsToCatalog() {
    if (!csvPreview || labelConfirmStoreUnavailable) return;
    const picked = csvPreview.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => csvInclude[index] && !csvAdded[index] && row.addable);
    if (picked.length === 0) return;
    const added = [...csvAdded];
    const nextPending = [...pendingLabelIdsRef.current];
    let addedCount = 0;
    let failure: string | null = null;
    for (const { row, index } of picked) {
      const product = csvCandidateToShopProduct(row.candidate, newId());
      // Persist the label-confirm guard before the catalog row (same order as starter add).
      if (!addPendingLabelConfirm(product.id)) {
        setLabelConfirmStoreUnavailable(true);
        failure = `Needs a look: could not add "${product.name}". Label-confirm storage is unavailable on this device.`;
        break;
      }
      if (!onUpsert(product)) {
        if (!clearPendingLabelConfirm(product.id)) setLabelConfirmStoreUnavailable(true);
        failure = `Needs a look: could not add "${product.name}" to the shop catalog.`;
        break;
      }
      if (!nextPending.includes(product.id)) nextPending.push(product.id);
      added[index] = true;
      addedCount += 1;
    }
    if (addedCount > 0) {
      pendingLabelIdsRef.current = nextPending;
      setPendingLabelIds(nextPending);
      reconcilePendingLabelState();
      // Show the new archived rows even when the Active filter is on.
      setListFilter("all");
    }
    if (failure) {
      setCsvAdded(added);
      setCsvInclude((inc) => inc.map((v, i) => v && !added[i]));
      setStarterAnnouncement(
        addedCount > 0 ? `${failure} ${plural(addedCount, "row was", "rows were")} added before it.` : failure,
      );
      return;
    }
    const total = added.filter(Boolean).length;
    closeCsvPreview();
    setStarterAnnouncement(
      `Added ${total} to the shop catalog as archived. Confirm each label before techs can pick it.`,
    );
  }

  const csvToAddCount = csvPreview
    ? csvPreview.rows.filter((row, i) => csvInclude[i] && !csvAdded[i] && row.addable).length
    : 0;
  const csvSummaryId = `${csvIdPrefix}-csv-summary`;

  // Focus the preview heading when a preview opens; return focus to the
  // (freshly mounted, empty) file picker when it closes.
  const csvPreviewOpen = csvPreview !== null;
  const prevCsvPreviewOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevCsvPreviewOpenRef.current;
    prevCsvPreviewOpenRef.current = csvPreviewOpen;
    if (csvPreviewOpen && !wasOpen) csvPreviewHeadingRef.current?.focus();
    else if (!csvPreviewOpen && wasOpen) csvFileRef.current?.focus();
  }, [csvPreviewOpen]);

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

  // Search + kind + 25(b) matches, shared by the results list and the status counts.
  const starterMatches = useMemo(
    () =>
      filterStarters25bOnly(
        searchTexasStarterCatalog(starterQuery, starterKindFilter),
        starter25bOnly,
      ),
    [starterQuery, starterKindFilter, starter25bOnly],
  );

  const starterResults = useMemo(() => {
    const rows = starterMatches;
    // hide-active hides only active shop matches; pending/archived stay so office can Confirm label…
    const filtered = filterStartersByShopStatus(rows, catalog, starterShopStatus, pendingLabelIds);
    return sortStarters(filtered, catalog, pendingLabelIds, starterSort);
  }, [starterMatches, starterShopStatus, starterSort, catalog, pendingLabelIds]);

  // Counts over the search + kind + 25(b) results (before the shop status filter).
  const starterStatusCounts = useMemo(() => {
    const rows = starterMatches;
    const ids = new Set(pendingLabelIds);
    const counts = { notAdded: 0, pending: 0, archived: 0, active: 0 };
    for (const starter of rows) {
      const state = starterShopState(catalog, starter, ids);
      if (state === "not-added") counts.notAdded += 1;
      else if (state === "pending") counts.pending += 1;
      else if (state === "archived") counts.archived += 1;
      else counts.active += 1;
    }
    return counts;
  }, [starterMatches, catalog, pendingLabelIds]);

  return (
    <div>
      <h2>Shop product list</h2>
      <p className="hint">
        Office-managed list stored on this device (separate from logs). Techs can only pick from this
        list. Archive hides a product from New log without deleting it. Seeded examples are labeled as
        examples. Real CSV/PDF export stays disabled until examples are removed from the catalog and
        from any saved logs that still reference them.
      </p>

      <p className="visually-hidden" role="status" aria-live="polite">
        {starterAnnouncement}
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
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                ref={starterSearchRef}
                type="search"
                value={starterQuery}
                onChange={(e) => setStarterQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Escape clears only the search text; leave default behavior when empty.
                  if (e.key === "Escape" && starterQuery !== "") {
                    e.preventDefault();
                    setStarterQuery("");
                  }
                }}
                placeholder="Name or EPA reg. no. (dashes optional)"
                aria-label="Search starter list by name or EPA reg. no."
                autoComplete="off"
                disabled={labelConfirmId !== null}
              />
              {starterQuery !== "" && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label="Clear starter search"
                  onClick={() => {
                    setStarterQuery("");
                    starterSearchRef.current?.focus();
                  }}
                  disabled={labelConfirmId !== null}
                >
                  ×
                </button>
              )}
            </div>
          </label>
          <div className="row">
            <label className="field">
              Kind
              <select
                value={starterKindFilter}
                onChange={(e) => setStarterKindFilter(e.target.value as StarterKindFilter)}
                disabled={labelConfirmId !== null}
              >
                <option value="all">All kinds</option>
                <option value="pesticide">Pesticide</option>
                <option value="device">Device</option>
              </select>
            </label>
            <label className="field">
              Shop status
              <select
                value={starterShopStatus}
                onChange={(e) => setStarterShopStatus(e.target.value as StarterShopStatusFilter)}
                disabled={labelConfirmId !== null}
              >
                <option value="all">All starters</option>
                <option value="hide-active">Hide already on shop list</option>
                <option value="active">Already on shop list</option>
                <option value="not-added">Not on shop list yet</option>
                <option value="pending">Pending label confirm</option>
                <option value="archived">Archived on shop list</option>
              </select>
            </label>
            <label className="field">
              Sort
              <select
                value={starterSort}
                onChange={(e) => setStarterSort(e.target.value as StarterSortOrder)}
                disabled={labelConfirmId !== null}
              >
                <option value="list">Starter list order</option>
                <option value="name">Name A–Z</option>
                <option value="needs-action">Needs action first</option>
              </select>
            </label>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={starter25bOnly}
              onChange={(e) => setStarter25bOnly(e.target.checked)}
              disabled={labelConfirmId !== null}
            />
            25(b) products only
          </label>
          {(starterQuery.trim() !== "" ||
            starterKindFilter !== "all" ||
            starter25bOnly ||
            starterShopStatus !== "all" ||
            starterSort !== "list") && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setStarterQuery("");
                setStarterKindFilter("all");
                setStarter25bOnly(false);
                setStarterShopStatus("all");
                setStarterSort("list");
                // This button unmounts after reset; keep keyboard focus in the picker.
                starterSearchRef.current?.focus();
              }}
              disabled={labelConfirmId !== null}
            >
              Reset search &amp; filters
            </button>
          )}
          <div className="hint">
            <span role="status" aria-live="polite">
              {formatStarterResultCount(starterResults.length, TEXAS_COMMON_STARTER.length)}. Add
              copies into your shop list; techs still only pick shop-owned active rows.
            </span>{" "}
            {(
              [
                ["not-added", "Not on shop list yet", starterStatusCounts.notAdded],
                ["pending", "Pending label confirm", starterStatusCounts.pending],
                ["archived", "Archived on shop list", starterStatusCounts.archived],
                ["active", "Already on shop list", starterStatusCounts.active],
              ] as const
            ).map(([value, label, count], index) => (
              <span key={value}>
                {index > 0 ? " · " : null}
                <button
                  type="button"
                  aria-pressed={starterShopStatus === value}
                  disabled={labelConfirmId !== null}
                  onClick={() =>
                    setStarterShopStatus((current) => (current === value ? "all" : value))
                  }
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    color: "inherit",
                    font: "inherit",
                    cursor: "pointer",
                    textDecoration: "underline",
                    fontWeight: starterShopStatus === value ? 700 : 400,
                  }}
                >
                  {label}: {count}
                </button>
                {value === "active" ? "." : null}
              </span>
            ))}
          </div>
          <div className="starter-results">
            {starterResults.length === 0 ? (
              <p className="hint">No starter rows match this search/filter.</p>
            ) : (
              starterResults.map((starter) => {
                const state = starterShopState(catalog, starter, pendingLabelIds);
                const alreadyActive = state === "active";
                const alreadyPending = state === "pending";
                const alreadyArchived = state === "archived";
                const nameId = `${starterRowIdPrefix}-starter-${starter.id}`;
                return (
                  <div className="card-head" key={starter.id} style={{ marginBottom: "0.65rem" }}>
                    <div>
                      <strong id={nameId}>{renderHighlighted(starter.name, starterQuery)}</strong>
                      <div>
                        <span className="chip">{starter.kind}</span>{" "}
                        <span className="chip">
                          {renderHighlighted(starterEpaCaption(starter), starterQuery)}
                        </span>
                        {alreadyActive && <span className="chip">on shop list</span>}
                        {alreadyPending && <span className="chip">pending label confirm</span>}
                        {alreadyArchived && <span className="chip">archived on shop list</span>}
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
                          aria-describedby={nameId}
                          onClick={() => addStarterToCatalog(starter)}
                        >
                          {/* Archived matches also route through label confirm in addStarterToCatalog. */}
                          {alreadyPending || alreadyArchived ? "Confirm label…" : "Add to my catalog"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {!adding && editingId === null && (
        <section className="card catalog-filters" aria-labelledby={`${csvIdPrefix}-csv-title`}>
          <h3 id={`${csvIdPrefix}-csv-title`}>Import products from CSV</h3>
          <p className="hint" id={`${csvIdPrefix}-csv-hint`}>
            Columns: {CSV_FIELD_LABELS.name}, {CSV_FIELD_LABELS.epaRegNo}, {CSV_FIELD_LABELS.is25b},{" "}
            {CSV_FIELD_LABELS.kind}. You see a preview first; nothing is saved until you add. Rows are
            added archived, and each label must be confirmed before techs can pick it.
          </p>
          {!csvPreview && (
            <label className="field">
              Choose a CSV file
              <input
                ref={csvFileRef}
                type="file"
                accept=".csv,text/csv"
                aria-describedby={`${csvIdPrefix}-csv-hint`}
                onChange={(e) => void onCsvFileChosen(e)}
                disabled={labelConfirmId !== null}
              />
            </label>
          )}
          {csvPreview && (
            <div>
              <h4 ref={csvPreviewHeadingRef} tabIndex={-1}>
                Preview: {csvFileName}
              </h4>
              <p className="hint" id={csvSummaryId}>
                {csvPreviewSummary(csvPreview, csvInclude.map((v, i) => v && !csvAdded[i]))}
              </p>
              {csvPreview.fileProblems.length > 0 && (
                <ul aria-label="File notes">
                  {csvPreview.fileProblems.map((msg, i) => (
                    <li key={i} className="error">
                      {msg}
                    </li>
                  ))}
                </ul>
              )}
              {csvPreview.rows.length > 0 && (
                <ul aria-label="Rows in this file" style={{ listStyle: "none", padding: 0 }}>
                  {csvPreview.rows.map((row, index) => {
                    const c = row.candidate;
                    const nameId = `${csvIdPrefix}-csv-row-${index}`;
                    const rowDone = csvAdded[index];
                    return (
                      <li key={`${row.line}-${index}`} style={{ marginBottom: "0.65rem" }}>
                        <strong id={nameId}>{c.name || `(no name, line ${row.line})`}</strong>
                        <div>
                          <span className="chip">line {row.line}</span>{" "}
                          <span className="chip">{c.kind}</span>{" "}
                          <span className="chip">25(b): {c.is25b && c.kind !== "device" ? "yes" : "no"}</span>{" "}
                          <span className="chip">
                            {c.epaRegNo === null
                              ? "no EPA reg #"
                              : `EPA reg # ${c.epaRegNo}${row.epaFormatOk ? " · format looks OK" : ""}`}
                          </span>
                          {rowDone && <span className="chip">added</span>}
                        </div>
                        {(row.duplicate !== null || row.problems.length > 0) && (
                          <ul aria-label={`Notes for ${c.name || `line ${row.line}`}`}>
                            {row.duplicate !== null && <li className="error">{row.duplicate}</li>}
                            {row.problems.map((msg, i) => (
                              <li key={i} className="error">
                                {msg}
                              </li>
                            ))}
                          </ul>
                        )}
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={csvInclude[index] === true && !rowDone}
                            disabled={!row.addable || rowDone}
                            aria-describedby={nameId}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setCsvInclude((inc) => inc.map((v, i) => (i === index ? checked : v)));
                            }}
                          />
                          Include in import
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="sticky-save sticky-actions row">
                <button
                  type="button"
                  className="btn btn-primary"
                  aria-describedby={csvSummaryId}
                  disabled={csvToAddCount === 0 || labelConfirmStoreUnavailable || labelConfirmId !== null}
                  onClick={addCsvRowsToCatalog}
                >
                  Add {csvToAddCount} to shop catalog
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label="Cancel CSV import"
                  onClick={() => {
                    const anyAdded = csvAdded.some(Boolean);
                    closeCsvPreview();
                    setStarterAnnouncement(
                      anyAdded ? "Import closed. No more rows were added." : "Import canceled. Nothing was added.",
                    );
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
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
              <h3 ref={labelConfirmHeadingRef} tabIndex={-1}>
                Confirm label before activate
              </h3>
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
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    cancelLabelConfirm();
                    setStarterAnnouncement(
                      `${product.name} left archived. Label confirm is still pending.`,
                    );
                  }}
                >
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