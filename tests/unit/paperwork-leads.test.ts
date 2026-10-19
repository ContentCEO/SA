/**
 * Wave 2, Prompt versions step 6: Check 39 P5 (no automatic draft to a rebate processor, a
 * registration desk or a dispatch robot; the owner's tap still drafts) and Check 40 P4 (roofing
 * lead marketplaces are counted under their name and never drafted to).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createDraftForThread, threadsToAutoDraft } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { leadPlatformOf } from "@/server/monthly-rules";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-10T14:00:00Z");
let database: Database;
let workspaceId: string;
let mailboxId: string;
let g = 0;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
}, 30_000);

async function sorted(o: {
  category: string;
  from: string;
  extracted?: Record<string, unknown>;
  replyTo?: string;
}) {
  const id = `p${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Hello",
      category: o.category,
      needsOwner: false,
      summary: "Something.",
      extracted: o.extracted ?? {},
      classifiedAt: NOW,
      lastMessageAt: new Date(NOW.getTime() - 3_600_000),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${id}-in`,
    rfc822MessageId: `<${id}@x.test>`,
    direction: "in",
    fromAddress: o.from,
    fromName: "Sender",
    subject: "Hello",
    bodyText: "Application HP-55120 incomplete. Missing: outdoor unit serial numbers.",
    labelIds: ["INBOX"],
    replyToHeader: o.replyTo ? { address: o.replyTo } : {},
    sentAt: new Date(NOW.getTime() - 3_600_000),
    classifiedAt: NOW,
  });
  return t!.id;
}

const modelDraft = {
  body: "Hi,\n\nThanks, I'll get the serial numbers over this week.\n\nAlex",
  reason: "Answered.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
  opening: "not_first",
};

describe("Check 39 P5: paperwork robots get no automatic draft", () => {
  it.each(["supplier_vendor", "customer_question", "quote_request"])(
    "%s with routine_paperwork: skipped for auto and followup, drafted on the owner's tap",
    async (category) => {
      const t = await sorted({
        category,
        from: "hp-rebates@program.test",
        extracted: { routine_paperwork: true },
      });
      const writer = new FakeWriter();
      const { transport, calls } = fakeTransport([modelDraft]);
      setModelTransportForTests(transport);
      for (const trigger of ["auto", "followup"] as const)
        expect(
          await createDraftForThread(t, { trigger, writerFor: () => writer, now: () => NOW }),
        ).toMatchObject({ status: "skipped", reason: "paperwork" });
      expect(calls).toHaveLength(0);
      expect(
        (
          await createDraftForThread(t, {
            trigger: "owner",
            workspaceId,
            writerFor: () => writer,
            now: () => NOW,
          })
        ).status,
      ).toBe("created");
    },
  );

  it("threadsToAutoDraft leaves them out; an ordinary email stays in", async () => {
    const paperwork = await sorted({
      category: "supplier_vendor",
      from: "registrations@maker.test",
      extracted: { routine_paperwork: true },
    });
    const ordinary = await sorted({ category: "customer_question", from: "dana@customer.test" });
    const ids = await threadsToAutoDraft(mailboxId);
    expect(ids).toContain(ordinary);
    expect(ids).not.toContain(paperwork);
  });
});

describe("Check 40 P4: roofing lead marketplaces", () => {
  it("each new domain and its subdomains count under their label", () => {
    expect(leadPlatformOf("leads@modernize.com")).toBe("Modernize");
    expect(leadPlatformOf("noreply@mail.modernize.com")).toBe("Modernize");
    expect(leadPlatformOf("leads@elocal.com")).toBe("eLocal");
    expect(leadPlatformOf("x@notify.elocal.com")).toBe("eLocal");
    expect(leadPlatformOf("notifications@roofle.com")).toBe("Instant quote on your website");
    expect(leadPlatformOf("leads@app.roofr.com")).toBe("Instant quote on your website");
    expect(leadPlatformOf("someone@notmodernize.com")).toBeNull();
  });

  it("a Modernize lead with no Reply-To is never drafted to the robot, not even on a tap", async () => {
    const t = await sorted({ category: "quote_request", from: "leads@modernize.com" });
    const writer = new FakeWriter();
    const { transport, calls } = fakeTransport([modelDraft, modelDraft]);
    setModelTransportForTests(transport);
    for (const trigger of ["auto", "owner"] as const)
      expect(
        await createDraftForThread(t, {
          trigger,
          workspaceId,
          writerFor: () => writer,
          now: () => NOW,
        }),
      ).toMatchObject({ status: "skipped", reason: "lead_platform" });
    expect(calls).toHaveLength(0);
    expect(writer.drafts.size).toBe(0);
  });

  it("with the homeowner's own Reply-To, the lead drafts to the homeowner", async () => {
    const t = await sorted({
      category: "quote_request",
      from: "leads@modernize.com",
      replyTo: "pat@homeowner.test",
    });
    const writer = new FakeWriter();
    setModelTransportForTests(fakeTransport([modelDraft]).transport);
    const r = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      writerFor: () => writer,
      now: () => NOW,
    });
    expect(r.status).toBe("created");
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row).toBeDefined();
  });
});
