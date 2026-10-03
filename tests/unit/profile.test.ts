import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending } from "@/server/classification";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  businessProfileInput,
  describeVoice,
  getBusinessProfile,
  saveBusinessProfile,
} from "@/server/profile";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";

const valid = {
  businessName: "Elm Electric",
  trade: "electrical",
  services: "Service calls, panel upgrades",
  serviceArea: "",
  hours: "",
  leadTime: "",
  pricingNotes: "",
  paymentTerms: "",
  policies: "",
  signature: "",
  doNotPromise: "Same-day service\n\n  A price over email  \nSame-day service",
  vipSenders: "Boss@GC.com\n",
  amountThresholdDollars: "5000",
};

describe("business profile form", () => {
  it("cleans up list fields and coerces the threshold", () => {
    const r = businessProfileInput.parse(valid);
    expect(r.doNotPromise).toEqual(["Same-day service", "A price over email"]);
    expect(r.vipSenders).toEqual(["boss@gc.com"]);
    expect(r.amountThresholdDollars).toBe(5000);
    expect(r.serviceArea).toBeNull();
  });

  it("explains what's missing in plain words", () => {
    const r = businessProfileInput.safeParse({
      ...valid,
      businessName: " ",
      services: "",
      vipSenders: "not an email",
    });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => i.message);
    expect(msgs).toContain("What's the business called?");
    expect(msgs).toContain("Tell us what work you do.");
    expect(msgs).toContain("Each VIP line should be one email address.");
  });

  it("rejects a non-number threshold", () => {
    expect(
      businessProfileInput.safeParse({ ...valid, amountThresholdDollars: "lots" }).success,
    ).toBe(false);
  });
});

describe("describeVoice", () => {
  it("reads like a person noticed", () => {
    expect(
      describeVoice({
        greetingStyle: "Hey",
        signoffStyle: "Thanks, Davi",
        avgLengthWords: 45,
        formality: "casual",
      }),
    ).toBe(
      "You usually open with “Hey” and sign off “Thanks, Davi”. Your emails run about 45 words — short and to the point. You keep it casual.",
    );
  });
});

describe("profile drives classification", () => {
  let database: Database;
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    database = await createTestDb();
  });

  it("saves, and uses the owner's threshold and VIP list", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await saveBusinessProfile(workspace.id, businessProfileInput.parse(valid));
    const [ws] = await database.select().from(workspaces).where(eq(workspaces.id, workspace.id));
    expect(ws).toMatchObject({ businessName: "Elm Electric", trade: "electrical" });
    expect((await getBusinessProfile(workspace.id))!.completedAt).not.toBeNull();

    const box = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    const now = new Date();
    for (const [g, from] of [
      ["t1", "boss@gc.com"],
      ["t2", "someone@x.com"],
    ] as const) {
      const [t] = await database
        .insert(threads)
        .values({ mailboxId: box.id, gmailThreadId: g, inInbox: true })
        .returning();
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId: box.id,
        gmailMessageId: `m-${g}`,
        direction: "in",
        fromAddress: from,
        bodyText: "hello",
        labelIds: ["INBOX"],
        sentAt: new Date(now.getTime() - 3600_000),
      });
    }
    const amount = { ...classification().extracted, dollar_amounts: [4000] };
    const { transport, calls } = fakeTransport([
      classification(),
      classification({ extracted: amount }),
    ]);
    setModelTransportForTests(transport);
    await classifyPending(box.id, { now });

    expect(calls[0]!.system.at(-1)!.text).toContain("more than $5,000");
    expect(calls[0]!.system.at(-1)!.text).toContain("boss@gc.com");
    const rows = Object.fromEntries(
      (await database.select().from(threads)).map((t) => [t.gmailThreadId, t]),
    );
    expect(rows.t1!.needsOwner).toBe(true); // VIP
    expect(rows.t2!.needsOwner).toBe(false); // $4,000 is under the owner's $5,000
  });
});
