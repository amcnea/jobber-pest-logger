// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLog } from "../test/fixtures";
import { MemoryStorage } from "../test/memoryStorage";
import { REVIEWED_COPIES_KEY } from "../shop/reviewedCopies";
import { SHOP_SESSION_KEY } from "../shop/session";
import type { ApplicationLog } from "../types";
import { History } from "./History";
import { NewLogForm } from "./NewLogForm";

// #212: office note on a log whose shop data holds two reviewed copies that don't match.

const NOW = new Date(2026, 9, 17, 17, 5);
const REVISION_TEXT =
  "Needs a look: the shop data has two reviewed versions of this log that don't match. This app shows the higher revision. The other is set aside and kept in the backup JSON.";
const OTHER_TEXT =
  "Needs a look: the shop data has two reviewed versions of this log that don't match. This app shows the one picked by revision and review date. The other is set aside and kept in the backup JSON.";
const reviewed = (log: ApplicationLog) => ({ ...log, reviewedAt: "2026-10-02T09:00:00-05:00", reviewedBy: "Ana Office" });

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  storage.setItem(SHOP_SESSION_KEY, JSON.stringify({ shopId: "SHOP1", role: "office", verifiedAt: NOW.toISOString(), lastActiveAt: NOW.toISOString() }));
});
afterEach(() => vi.unstubAllGlobals());

function renderHistory(logs: ApplicationLog[], canEditDelete = true) {
  return render(
    <History
      logs={logs}
      canEditDelete={canEditDelete}
      onDelete={vi.fn()}
      onEdit={vi.fn()}
      onLogAgainHere={vi.fn()}
      onDuplicateLastStop={vi.fn()}
      now={NOW}
    />,
  );
}

describe("History: reviewed copies note", () => {
  it("shows the text matching how the copy was picked, only on that log", () => {
    storage.setItem(REVIEWED_COPIES_KEY, JSON.stringify({ SHOP1: { A: "revision", B: "other" } }));
    renderHistory([
      reviewed(makeLog({ id: "A", dateUsed: "2026-10-01" })),
      reviewed(makeLog({ id: "B", dateUsed: "2026-10-02" })),
      makeLog({ id: "C", dateUsed: "2026-10-03" }),
    ]);
    expect(screen.getByText(REVISION_TEXT).closest("article")).toHaveTextContent("2026-10-01");
    expect(screen.getByText(OTHER_TEXT).closest("article")).toHaveTextContent("2026-10-02");
    expect(screen.getAllByText(/two reviewed versions/)).toHaveLength(2);
  });

  it("not shown to tech, for another shop, or when nothing is recorded", () => {
    storage.setItem(REVIEWED_COPIES_KEY, JSON.stringify({ SHOP1: { A: "revision" } }));
    const log = reviewed(makeLog({ id: "A", dateUsed: "2026-10-01" }));
    const { unmount } = renderHistory([log], false);
    expect(screen.queryByText(/two reviewed versions/)).toBeNull();
    unmount();
    storage.setItem(REVIEWED_COPIES_KEY, JSON.stringify({ OTHER: { A: "revision" } }));
    const second = renderHistory([log]);
    expect(screen.queryByText(/two reviewed versions/)).toBeNull();
    second.unmount();
    storage.removeItem(REVIEWED_COPIES_KEY);
    renderHistory([log]);
    expect(screen.queryByText(/two reviewed versions/)).toBeNull();
  });
});

describe("Correct this log: reviewed copies note", () => {
  it("shows the note in the correction form for that log only", () => {
    storage.setItem(REVIEWED_COPIES_KEY, JSON.stringify({ SHOP1: { A: "other" } }));
    const settings = { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" };
    const { unmount } = render(
      <NewLogForm
        catalog={[]}
        people={[]}
        settings={settings}
        initialDraft={reviewed(makeLog({ id: "A" }))}
        isEditing
        onSave={vi.fn()}
        correction={{ onSubmit: vi.fn(() => null) }}
      />,
    );
    expect(screen.getByText(OTHER_TEXT)).toBeInTheDocument();
    unmount();
    render(
      <NewLogForm
        catalog={[]}
        people={[]}
        settings={settings}
        initialDraft={reviewed(makeLog({ id: "B" }))}
        isEditing
        onSave={vi.fn()}
        correction={{ onSubmit: vi.fn(() => null) }}
      />,
    );
    expect(screen.queryByText(/two reviewed versions/)).toBeNull();
  });
});
