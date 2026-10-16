import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { expect, test } from "@playwright/test";
import { seedOwner, signInAs } from "./support";

/**
 * Milestone 11 S4: the security checks a real browser and server can prove — /admin's 404, the
 * loopback-only bind of the e2e servers, the send API's Origin check and the Gmail-connect state
 * cookie. These seed rows, so they run locally only; the database-free checks (headers, the test
 * hook's 404) are in security-public.spec.ts, which smoke runs include.
 */

test("/admin is a plain 404 for an owner who isn't the admin", async ({ page, context }) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  for (const path of ["/admin", "/admin/costs"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { name: /admin/i })).toHaveCount(0);
  }
});

/** True if a TCP connection to host:port opens within 2 seconds. */
function opens(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

test("the e2e app and fakes listen on loopback only, not on this machine's network addresses", async ({
  baseURL,
}) => {
  // Every address this machine has besides loopback (IPv6 link-local needs a zone: left out).
  const outside = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && !a.address.startsWith("fe80:"))
    .map((a) => a!.address);
  test.skip(outside.length === 0, "this machine has no non-loopback address to try");
  const ports = [Number(new URL(baseURL!).port), Number(new URL(process.env.E2E_FAKES_URL!).port)];
  for (const port of ports) {
    // Positive control: the server is up on loopback, so a refusal below is the bind.
    expect(await opens("localhost", port), `localhost:${port}`).toBe(true);
    for (const address of outside) {
      expect(await opens(address, port), `${address}:${port}`).toBe(false);
    }
  }
});

test("the send API refuses a request with no real Origin (403, never a 500)", async ({
  request,
}) => {
  for (const origin of ["null", "https://evil.example", "::garbled::"]) {
    const res = await request.post(`/api/drafts/${randomUUID()}/send`, {
      headers: { origin },
      data: {},
    });
    expect(res.status(), origin).toBe(403);
  }
});

test("the Gmail-connect state cookie is httpOnly, SameSite=Lax and only sent to /api/gmail", async ({
  page,
  context,
}) => {
  const owner = await seedOwner();
  await signInAs(context, owner);
  // Stop at Google's door: the cookie is set by then.
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, body: "google consent (stubbed)" }),
  );
  await page.goto("/connect");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await expect(page.getByText("google consent (stubbed)")).toBeVisible();

  const state = (await context.cookies()).find((c) => c.name === "sa_gmail_oauth_state");
  expect(state).toBeDefined();
  expect(state!.httpOnly).toBe(true);
  expect(state!.sameSite).toBe("Lax");
  expect(state!.path).toBe("/api/gmail");
  // `pnpm start` runs in production mode, where it's Secure too.
  expect(state!.secure).toBe(true);
  expect(state!.value).toMatch(/^[A-Za-z0-9_-]{40,}$/);
});
