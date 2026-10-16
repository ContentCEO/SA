import { describe, expect, it } from "vitest";
import { checkDraft } from "@/ai/draft-checks";
import { applyOwnerRules } from "@/ai/classify";
import {
  addDays,
  awayActive,
  awayLastLine,
  awayNoteText,
  validateBackOn,
} from "@/server/away-rules";
import {
  companyChoice,
  junkShortcutBlocked,
  keyFromMessage,
  matchRules,
  RULE_REFUSALS,
  ruleMatches,
  SENDER_NEEDS_ME_REASON,
  type SenderRule,
} from "@/server/owner-sender-rule-rules";
import { classification } from "../support/fake-model";

const junk = (pattern: string, scope: SenderRule["scope"] = "address"): SenderRule => ({
  pattern,
  scope,
  action: "junk",
});

describe("H3 rule matching", () => {
  it("domain rules match subdomains, never look-alikes", () => {
    const r = junk("hillpm.com", "domain");
    expect(ruleMatches(r, "a@hillpm.com")).toBe(true);
    expect(ruleMatches(r, "a@north.hillpm.com")).toBe(true);
    expect(ruleMatches(r, "a@xhillpm.com")).toBe(false);
    expect(ruleMatches(junk("Dana@X.com"), "dana@x.com")).toBe(true);
  });

  it("junk only in the safe direction; caution matches either address and beats junk", () => {
    const rules = [junk("x@spam.com")];
    const base = { vips: [] as string[] };
    expect(
      matchRules(rules, {
        ...base,
        from: "x@spam.com",
        replyAddress: "x@spam.com",
        replyToHeader: {},
      }).junk,
    ).toBe(true);
    // A stranger naming the ruled address in Reply-To.
    expect(
      matchRules(rules, {
        ...base,
        from: "someone@else.com",
        replyAddress: "x@spam.com",
        replyToHeader: { address: "x@spam.com" },
      }).junk,
    ).toBe(false);
    // A form robot carrying another customer.
    expect(
      matchRules(rules, {
        ...base,
        from: "x@spam.com",
        replyAddress: "dana@x.com",
        replyToHeader: { address: "dana@x.com" },
      }).junk,
    ).toBe(false);
    // Never read: never junk.
    expect(
      matchRules(rules, {
        ...base,
        from: "x@spam.com",
        replyAddress: "x@spam.com",
        replyToHeader: null,
      }).junk,
    ).toBe(false);
    const vip = matchRules(rules, {
      vips: ["x@spam.com"],
      from: "x@spam.com",
      replyAddress: "x@spam.com",
      replyToHeader: {},
    });
    expect(vip).toEqual({ caution: "vip", noDraft: false, junk: false });
    const noDraft = matchRules([{ pattern: "dana@x.com", scope: "address", action: "no_draft" }], {
      ...base,
      from: "robot@form.com",
      replyAddress: "dana@x.com",
      replyToHeader: { address: "dana@x.com" },
    });
    expect(noDraft.noDraft).toBe(true);
  });

  it("the keyword guard sends complaint-sounding mail to the sorter", () => {
    for (const t of [
      "I'm calling my LAWYER",
      "water damage",
      "small  claims",
      "Refund please",
      "BBB",
    ])
      expect(junkShortcutBlocked(t), t).toBe(true);
    for (const t of ["Big sale on drills", "ignore my previous email", "sued?no", "courtyard sale"])
      expect(junkShortcutBlocked(t), t).toBe(false);
  });

  it("keys: unchecked, lead sites and robots are refused; the reply address otherwise", () => {
    expect(keyFromMessage({ fromAddress: "a@b.com", replyToHeader: null })).toEqual({
      ok: false,
      why: "unchecked",
    });
    expect(keyFromMessage({ fromAddress: "leads@thumbtack.com", replyToHeader: {} })).toEqual({
      ok: false,
      why: "platform",
    });
    expect(keyFromMessage({ fromAddress: "no-reply@b.com", replyToHeader: {} })).toEqual({
      ok: false,
      why: "robot",
    });
    expect(
      keyFromMessage({
        fromAddress: "form-submission@squarespace.info",
        replyToHeader: { address: "Dana@X.com" },
      }),
    ).toEqual({ ok: true, key: "dana@x.com" });
    for (const k of ["unchecked", "platform", "robot"] as const)
      expect(RULE_REFUSALS[k]).toBeTruthy();
  });

  it("no company choice for webmail or the owner's own domain", () => {
    expect(companyChoice("a@gmail.com", ["me@shop.com"])).toBeNull();
    expect(companyChoice("crew@shop.com", ["me@shop.com"])).toBeNull();
    expect(companyChoice("pm@hillpm.com", ["me@shop.com"])).toBe("hillpm.com");
  });

  it("a company Always needs me flags the email; injection still wins", () => {
    const m = classification({ category: "scheduling" });
    const base = { firstTimeSender: false, senderIsVip: false, amountThresholdDollars: 2500 };
    expect(applyOwnerRules(m, { ...base, senderNeedsMe: true })).toMatchObject({
      needsOwner: true,
      needsOwnerReason: SENDER_NEEDS_ME_REASON,
    });
    expect(
      applyOwnerRules(m, { ...base, senderNeedsMe: true, injection: true }).needsOwnerReason,
    ).not.toBe(SENDER_NEEDS_ME_REASON);
  });
});

describe("E7 away rules", () => {
  it("back-on edges", () => {
    const today = "2026-10-14";
    expect(validateBackOn(today, today)).toBe("past");
    expect(validateBackOn("2026-10-15", today)).toBe("ok");
    expect(validateBackOn(addDays(today, 90), today)).toBe("ok");
    expect(validateBackOn(addDays(today, 91), today)).toBe("too_far");
    expect(validateBackOn("2026-02-30", today)).toBe("invalid");
    expect(awayActive("2026-10-15", "2026-10-14")).toBe(true);
    expect(awayActive("2026-10-15", "2026-10-15")).toBe(false);
    expect(awayActive(null, "2026-10-15")).toBe(false);
  });

  it("the note names each day both ways, across a year end", () => {
    expect(awayNoteText("2026-10-10")).toBe(
      "Away until Friday, October 9 (Oct 9). Back Saturday, October 10 (Oct 10).",
    );
    expect(awayNoteText("2027-01-01")).toBe(
      "Away until Thursday, December 31 (Dec 31). Back Friday, January 1 (Jan 1).",
    );
  });

  it("a draft naming the day back is not flagged as an invented date", () => {
    const note = awayNoteText("2026-10-10");
    for (const body of ["I'm back Saturday, October 10.", "Back on Oct 10, I'll call then."]) {
      const r = checkDraft(body, {
        sourceText: `Can you come this week?\n${note}`,
        doNotPromise: [],
        phrasesAvoided: [],
      });
      expect(r.hits, body).not.toContain("when");
    }
  });

  it("the last line is honest about autopilot", () => {
    expect(awayLastLine(false)).toMatch(/Nothing goes out without your okay/);
    expect(awayLastLine(true)).toMatch(/Autopilot keeps sending/);
  });
});
