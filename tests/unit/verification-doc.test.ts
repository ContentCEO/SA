import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNDO_WINDOW_SECONDS } from "@/config/drafting";
import { modelPricing, models } from "@/config/models";
import { bodyRetentionDays } from "@/config/retention";
import { GMAIL_SCOPES, IDENTITY_SCOPES } from "@/mailbox/gmail/scopes";
import { EARN_THRESHOLD, GRACE_MINUTES } from "@/server/autopilot";
import { MAX_SENT_EMAILS } from "@/server/voice";

/**
 * Plan M11 S6: docs/google-verification.md is what we tell Google, so it must stay true of the
 * code: the scopes we ask for, the files it cites, Google's Limited Use wording, the facts the
 * reviewer will check (practice sends, Promotions bodies), and a demo-video script that covers
 * every step of the end-to-end journey in tests/e2e/full-flow.spec.ts.
 */

const DOC_PATH = "docs/google-verification.md";
const SPEC_PATH = "tests/e2e/full-flow.spec.ts";
const doc = readFileSync(DOC_PATH, "utf8");
const spec = readFileSync(SPEC_PATH, "utf8");

/** Markdown wraps lines; compare text with the line breaks and runs of spaces collapsed. */
const flat = (s: string) => s.replace(/\s+/g, " ");
const text = flat(doc);

/** A `## Heading` section, up to the next `## ` heading. */
function section(heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  expect(start, `section "${heading}"`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + 1);
  const end = rest.slice(3).search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end + 3);
}

/**
 * The spec's test.step titles, in source order. A shared helper's steps are written once (and
 * run in both tests); a step written twice must get its own title, so it gets its own row.
 */
function specStepTitles(): string[] {
  return [...spec.matchAll(/test\.step\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

const script = section("Demo video script");
const [scriptSteps, mapping] = (() => {
  const i = script.indexOf("### Which test checks each step");
  expect(i, "the mapping table").toBeGreaterThanOrEqual(0);
  return [script.slice(0, i), script.slice(i)];
})();

/** Numbers of the numbered script steps ("1. **Sign in.** …"). */
const scriptNumbers = [...scriptSteps.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));

/** Mapping rows: spec step title → script step numbers. */
const rows = mapping
  .split("\n")
  .filter((l) => l.startsWith("| ") && !l.startsWith("| -") && !l.includes("Script step"))
  .map((l) => {
    const [, title, steps] = l.split("|").map((c) => c.trim());
    return { title: title!, steps: steps!.split(/\s*,\s*/).map(Number) };
  });

describe("the demo video script matches the end-to-end journey", () => {
  const titles = specStepTitles();

  it("reads the spec's steps (it can't silently find nothing)", () => {
    expect(titles.length).toBeGreaterThanOrEqual(15);
    expect(titles).toContain("The owner taps Send reply and gets a few seconds to undo it");
    expect(titles).toContain("The owner sends a practice copy to their own inbox instead");
  });

  it("no step title is written twice (each use of a step has its own row)", () => {
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
  });

  it("the script's steps are numbered 1, 2, 3 … with no gaps", () => {
    expect(scriptNumbers.length).toBeGreaterThanOrEqual(10);
    expect(scriptNumbers).toEqual(scriptNumbers.map((_, i) => i + 1));
  });

  it("every spec step has exactly one row, in the spec's order, and no row is stale", () => {
    expect(rows.map((r) => r.title)).toEqual(titles);
  });

  it("every row points at script steps that exist, and the script follows the spec's order", () => {
    let last = 0;
    for (const row of rows) {
      expect(row.steps.length, row.title).toBeGreaterThan(0);
      for (const n of row.steps) {
        expect(scriptNumbers, `${row.title} → ${n}`).toContain(n);
        expect(n, `${row.title} goes back to step ${n}`).toBeGreaterThanOrEqual(last);
        last = n;
      }
    }
  });

  it("is written for a real recording: Google's own consent screen, the client_id, each scope in use", () => {
    const s = flat(scriptSteps);
    expect(s).toContain("Google's real consent screen");
    expect(s).toContain("`client_id=`");
    expect(s).toContain("address bar");
    for (const scope of ["gmail.readonly", "gmail.compose", "gmail.send"]) {
      // Shown on the consent screen and again in a step where it is used.
      expect(s.split(`\`${scope}\``).length - 1, scope).toBeGreaterThanOrEqual(2);
    }
    // Invented mail only: no real customer is filmed.
    expect(s).toContain("dedicated demo Gmail account filled with invented emails");
  });

  it("the reviewer gets an invite in /admin; how the send part is shown is Davi's decision", () => {
    const r = flat(section("Reviewer test account"));
    expect(r).toContain("`/admin` → Invite an owner");
    expect(r).toContain("**Davi's decision**");
    expect(r).toContain("practice copies");
  });
});

describe("the verification answer is true of the code", () => {
  it("lists exactly the Gmail scopes the connect flow asks for, and the sign-in identity scopes", () => {
    const table = section("Scopes")
      .split("\n")
      .filter((l) => l.startsWith("| `gmail."))
      .map((l) => l.match(/^\| `(gmail\.[a-z]+)`/)![1]);
    const asked = Object.values(GMAIL_SCOPES).map((u) => u.replace(/^.*\/auth\//, ""));
    expect([...table].sort()).toEqual([...asked].sort());
    expect(text).toContain(`\`${IDENTITY_SCOPES.join(" ")}\``);
    const connector = readFileSync("src/mailbox/gmail/connector.ts", "utf8");
    for (const [param, value] of [
      ["access_type", "offline"],
      ["prompt", "consent"],
      ["include_granted_scopes", "true"],
    ]) {
      expect(text).toContain(`\`${param}=${value}\``);
      expect(connector).toContain(`${param}: "${value}"`);
    }
  });

  it("names the scopes we don't ask for, and the test that keeps them out exists", () => {
    expect(text).toContain("do **not** request `gmail.modify` or full `https://mail.google.com/`");
    const guard = readFileSync("tests/unit/gmail-connector.test.ts", "utf8");
    expect(guard).toContain("gmail.modify");
    expect(guard).toContain("https://mail.google.com/");
  });

  it("every file it cites exists", () => {
    const cited = [...doc.matchAll(/`((?:src|tests|docs|scripts|public)\/[^`\s]+)`/g)].map(
      (m) => m[1]!,
    );
    expect(cited.length).toBeGreaterThanOrEqual(15);
    expect(cited.filter((p) => !existsSync(p))).toEqual([]);
  });

  it("names no model ID", () => {
    for (const id of [...Object.values(models), ...Object.keys(modelPricing)]) {
      expect(doc).not.toContain(id);
    }
    expect(doc).not.toMatch(/claude-(haiku|sonnet|opus)/i);
    expect(readFileSync("docs/SETUP.md", "utf8")).not.toMatch(/claude-(haiku|sonnet|opus)/i);
  });

  it("uses Google's Limited Use template sentence and the explicit-permission merger wording", () => {
    expect(text).toContain(
      "Squared Away's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.",
    );
    expect(text).toContain(
      "if the business is merged or sold, only after asking for the owner's explicit permission first",
    );
  });

  it("carries none of the old claims the code contradicts", () => {
    for (const phrase of [
      /read once/i,
      /single Anthropic call/i,
      /with your rights protected/i,
      /in one tap/i,
      /everything we hold/i,
      /for the last 30 days, sender/i,
      /only after the owner taps "Send reply", and only/i,
      /Send a draft \*\*only after/i,
    ]) {
      expect(text).not.toMatch(phrase);
    }
  });

  it("practice sends go through messages.send to the owner's own address (as the code does)", () => {
    const sending = flat(doc.slice(doc.indexOf("- **Sending:**")));
    expect(sending).toContain("practice copy to the owner's own address through `messages.send`");
    expect(text).toContain("customer replies go out only through Gmail's `drafts.send`");
    const api = readFileSync("src/mailbox/gmail/api.ts", "utf8");
    expect(api).toContain('"/messages/send"');
    expect(api).toContain('"/drafts/send"');
    const practice = readFileSync("src/server/practice.ts", "utf8");
    expect(practice).toContain("onlyToOwner(");
    expect(practice).toContain("sendMessage(");
  });

  it("Promotions and Social mail: the body is read (it's in the inbox) but never sent to the AI", () => {
    expect(text).toContain("its body **is** read within the 30 days");
    expect(text).toContain("**without** being sent to the AI");
    expect(readFileSync("src/server/sync.ts", "utf8")).toContain('m.labelIds.includes("INBOX")');
    const classification = readFileSync("src/server/classification.ts", "utf8");
    expect(classification).toContain('"CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"');
  });

  it("the numbers it quotes are the code's", () => {
    expect(text).toContain(`up to ${MAX_SENT_EMAILS} _sent_ emails from the last year`);
    expect(text).toContain(`sent ${EARN_THRESHOLD} of that kind exactly as drafted`);
    expect(text).toContain(`for ${GRACE_MINUTES} minutes with a "Hold it" button`);
    expect(text).toContain(`then a ${UNDO_WINDOW_SECONDS}-second undo window`);
    expect(bodyRetentionDays()).toBe(30);
    expect(text).toContain("after 30 days (`RETENTION_BODY_DAYS`)");
  });

  it("describes voice learning as it runs: on connect, weekly, on Re-learn, and on retry; never stored", () => {
    const voice = flat(doc.slice(doc.indexOf("- **Learning the owner's writing style:**")));
    expect(voice).toContain("again weekly (skipped if the owner edited their style)");
    expect(voice).toContain('"Re-learn from my sent mail"');
    expect(voice).toContain("again automatically if a read stops part-way");
    expect(voice).toContain("never written to our database");
  });

  it("retention matches the purge (bodies, draft text and flags, pulled-out addresses and dates)", () => {
    const purge = readFileSync("src/server/sync.ts", "utf8");
    expect(purge).toContain("flags: []");
    expect(purge).toContain("- 'address' - 'dates'");
    expect(text).toContain("the check notes on drafts");
    expect(text).toContain("street address, dates, an inspector's corrections");
    expect(text).toContain("metadata stays until the owner disconnects that Gmail address");
  });

  it("Disconnect keeps the writing style (it belongs to the account), as the privacy policy says", () => {
    const bullet = flat(
      doc.slice(doc.indexOf("- **Disconnect:**"), doc.indexOf("- **Delete my account**")),
    );
    const [deleted, kept] = bullet.split("Kept until the owner taps Delete my account:");
    expect(kept, "the Disconnect bullet says what is kept").toBeDefined();
    for (const gone of ["messages", "drafts", "price memory"]) expect(deleted).toContain(gone);
    expect(deleted).not.toMatch(/style/);
    for (const stays of [
      "the writing style",
      "style suggestions",
      "business details",
      "activity history",
    ])
      expect(kept).toContain(stays);
    expect(text).toContain(
      "The style description and samples are kept until the owner deletes the account",
    );
    // True of the schema: the voice tables hang off the workspace, not the mailbox.
    const schema = readFileSync("src/db/schema.ts", "utf8");
    for (const table of ['pgTable("voice_profile"', 'pgTable(\n  "voice_suggestions"']) {
      const at = schema.indexOf(table);
      expect(at, table).toBeGreaterThanOrEqual(0);
      const body = schema.slice(at, schema.indexOf("pgTable(", at + 10));
      expect(body).toContain("references(() => workspaces.id");
      expect(body).not.toContain("mailboxes.id");
    }
  });

  it("the pre-autopilot lookup asks Gmail for ids and labels only, as the Scopes table says", () => {
    expect(text).toContain("we ask Google for message ids and labels only");
    const api = readFileSync("src/mailbox/gmail/api.ts", "utf8");
    expect(api).toContain('format=minimal&fields=${encodeURIComponent("messages(id,labelIds)")}');
  });

  it("says what each send scope does exactly as the privacy policy does (Google compares the two)", () => {
    const policy = readFileSync("docs/privacy-policy.md", "utf8");
    /** The table row for a scope, flattened. */
    const row = (md: string, scope: string) => {
      const rows = md.split("\n").filter((l) => l.startsWith("|") && l.includes(`\`${scope}\``));
      expect(rows, scope).toHaveLength(1);
      return flat(rows[0]!);
    };
    for (const [name, md] of [
      ["verification", doc],
      ["privacy policy", policy],
    ] as const) {
      const send = row(md, "gmail.send");
      expect(send, `${name}: gmail.send is for practice copies`).toMatch(/practice copy/);
      expect(send, `${name}: gmail.send never reaches a customer`).toContain(
        "to a customer through it",
      );
      for (const not of [/Send reply/, /autopilot/i, /approve/i, /drafts\.send/]) {
        expect(send, `${name}: gmail.send row`).not.toMatch(not);
      }
      const compose = row(md, "gmail.compose");
      expect(compose, `${name}: gmail.compose sends approved replies`).toMatch(
        /send a (draft|reply) (the owner|you) approved \(\**Send reply\**\)/,
      );
      expect(compose, `${name}: gmail.compose sends autopilot replies`).toMatch(/autopilot/);
    }
    // And the code: customer replies go through drafts.send; only practice.ts sends a message.
    const sendMessageCallers = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => readFileSync(`src/${f}`, "utf8").includes(".sendMessage("));
    expect(sendMessageCallers).toEqual(["server/practice.ts"]);
  });

  // docs/LAUNCH.md is written in plan step S7; once it exists it must list both decisions this
  // document hands to Davi.
  it.skipIf(!existsSync("docs/LAUNCH.md"))(
    "the launch checklist lists the decisions this document leaves to Davi",
    () => {
      const launch = flat(readFileSync("docs/LAUNCH.md", "utf8"));
      expect(launch).toContain("drop `gmail.send`?");
      expect(launch).toMatch(/reviewer/i);
    },
  );

  it("price memory is never sent to the AI, and says so", () => {
    expect(text).toContain("They are **never sent to the AI**");
  });
});
