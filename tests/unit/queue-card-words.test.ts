import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { withoutCategoryPrefix } from "@/lib/card-words";

vi.mock("@/app/(app)/queue/actions", () => {
  const noop = async () => {};
  return {
    discardDraftAction: noop,
    holdAutopilotAction: noop,
    practiceSendAction: noop,
    sendDraftAction: noop,
    snoozeAction: noop,
    editorAction: noop,
    reviseDraftAction: noop,
  };
});
vi.mock("@/app/(app)/queue/first-week-actions", () => ({ answeredByPhoneAction: async () => {} }));
vi.mock("@/app/(app)/settings/wording-actions", () => ({ addNeverSayAction: async () => {} }));

const { DraftCard } = await import("@/app/(app)/queue/draft-card");
type DraftCardProps = import("@/app/(app)/queue/draft-card").DraftCardProps;

const base = {
  draftId: "d1",
  threadId: "11111111-1111-4111-8111-111111111111",
  customer: "Priya",
  toAddress: "priya@x.com",
  tag: "Scheduling",
  wrote: "Wrote 2 hours ago",
  summary: "Wants to move Thursday's water heater visit to next week." as string | null,
  reason: "Scheduling: move Thursday's water heater swap to next week (not Wednesday).",
  body: "Hi Priya,\n\nNext week works.\n\nSam",
  seenHash: "0".repeat(64),
  flags: [],
  label: "ready" as const,
  usedFacts: [],
  needsOwnerReason: null as string | null,
  canSend: true,
  sendingOffLabel: "",
  sendingOffDetail: "",
  remindOptions: [{ choice: "tonight", label: "Tonight (6pm)" }],
};
type Over = Partial<Omit<DraftCardProps, "summary" | "needsOwnerReason">> & {
  summary?: string | null;
  needsOwnerReason?: string | null;
};
const render = (over: Over = {}) =>
  renderToStaticMarkup(createElement(DraftCard, { ...base, ...over })).replace(/&#x27;/g, "'");
const header = (html: string) => html.match(/<header[^>]*>([\s\S]*?)<\/header>/)![1]!;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

describe("Check 9 P12: a card says what the customer wants once", () => {
  it("strips a category word and colon from a reason", () => {
    expect(withoutCategoryPrefix("Scheduling: move Thursday's swap.")).toBe(
      "Move Thursday's swap.",
    );
    expect(withoutCategoryPrefix("Quote request: panel upgrade.")).toBe("Panel upgrade.");
    expect(withoutCategoryPrefix("Invoice / payment: paid by check.")).toBe("Paid by check.");
    // Anything else stays as written.
    expect(withoutCategoryPrefix("Emergency: burst pipe.")).toBe("Emergency: burst pipe.");
    expect(withoutCategoryPrefix("Note: 8:30 works")).toBe("Note: 8:30 works");
    expect(withoutCategoryPrefix("No colon here")).toBe("No colon here");
  });

  it("with a summary, the reason is only inside Why this?", () => {
    const html = render();
    expect(header(html)).not.toContain("water heater swap");
    const why = html.match(/<details[\s\S]*?<\/details>/)![0];
    expect(why).toContain("Move Thursday's water heater swap to next week (not Wednesday).");
    expect(html.match(/water heater swap/g)).toHaveLength(1);
    expect(text(header(html))).toMatchInlineSnapshot(`
      [
        "Priya",
        "Ready",
        "To:",
        "priya@x.com",
        "Scheduling",
        "Wrote 2 hours ago",
        "Wants to move Thursday's water heater visit to next week.",
      ]
    `);
  });

  it("without a summary, the reason stands in on the card (without the category word)", () => {
    const html = render({ summary: null });
    expect(header(html)).toContain("Move Thursday's water heater swap to next week");
  });

  it("'Needs you: …' only when it adds something", () => {
    const reason = "Emergency: water is coming through the basement ceiling.";
    expect(render({ needsOwnerReason: reason })).toContain(`Needs you: ${reason}`);
    expect(render({ needsOwnerReason: reason, inRightNow: true })).not.toContain("Needs you:");
    expect(render({ needsOwnerReason: reason, inRightNow: true, summary: null })).toContain(
      `Needs you: ${reason}`,
    );
  });

  it("Remind me later and I called them share one row", () => {
    const html = render();
    const row = html.match(
      /<div class="grid grid-cols-2 gap-2 [^"]*only-child[^"]*">[\s\S]*?<\/div>/,
    )![0];
    expect(row).toContain("Remind me later");
    expect(row).toContain("I called them");
  });
});
