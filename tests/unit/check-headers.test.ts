import { describe, expect, it } from "vitest";
import {
  formatFindings,
  HEADER_CHECK_PATHS,
  headerFindings,
  type FetchedHead,
} from "@/lib/check-headers-rules";
import { checkHeaders } from "../../scripts/check-headers";

/** Check 1 P6: the post-deploy noindex check, with no network. */
const ok = (path: FetchedHead["path"], headers: Record<string, string> = {}): FetchedHead => ({
  path,
  status: 200,
  headers: path === "/favicon.ico" ? { "content-type": "image/x-icon", ...headers } : headers,
});
const allOk = HEADER_CHECK_PATHS.map((p) => ok(p));

describe("headerFindings", () => {
  it("passes when no page is noindex and the favicon is a 200 image", () => {
    expect(headerFindings(allOk)).toEqual([]);
    expect(formatFindings("https://example.com", [])[0]).toMatch(/^All checks passed/);
  });

  it("fails a page sent with x-robots-tag: noindex, in any case", () => {
    const heads = allOk.map((h) =>
      h.path === "/growth" ? { ...h, headers: { "x-robots-tag": "NOINDEX, nofollow" } } : h,
    );
    expect(headerFindings(heads)).toEqual([
      { path: "/growth", problem: "sent with x-robots-tag: noindex (search engines skip it)" },
    ]);
  });

  it("fails a favicon that isn't 200 or isn't an image, and a page that isn't 200", () => {
    const missing = allOk.map((h) => (h.path === "/favicon.ico" ? { ...h, status: 404 } : h));
    expect(headerFindings(missing)).toEqual([
      { path: "/favicon.ico", problem: "answered 404, not 200" },
    ]);
    const html = allOk.map((h) =>
      h.path === "/favicon.ico" ? { ...h, headers: { "content-type": "text/html" } } : h,
    );
    expect(headerFindings(html)).toEqual([{ path: "/favicon.ico", problem: "isn't an image" }]);
    const down = allOk.map((h) => (h.path === "/privacy" ? { ...h, status: 500 } : h));
    expect(headerFindings(down)).toEqual([{ path: "/privacy", problem: "answered 500, not 200" }]);
  });

  it("a path that got no response is a failure, not a pass", () => {
    expect(headerFindings(allOk.slice(0, 4))).toEqual([
      { path: "/favicon.ico", problem: "wasn't checked (no response)" },
    ]);
  });
});

describe("checkHeaders with a fake fetch", () => {
  const fake = (robots: string | null, favicon: number) =>
    (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const headers: Record<string, string> = {};
      if (robots) headers["x-robots-tag"] = robots;
      if (u.pathname === "/favicon.ico") {
        return new Response("", { status: favicon, headers: { "content-type": "image/x-icon" } });
      }
      return new Response("<html>SECRET BODY</html>", { status: 200, headers });
    }) as typeof fetch;

  it("passes on a clean site", async () => {
    const r = await checkHeaders("https://example.com", fake(null, 200));
    expect(r.findings).toEqual([]);
    expect(r.lines).toEqual([
      "All checks passed on https://example.com: no noindex, favicon answers.",
    ]);
  });

  it("fails on today's vercel.app answers and prints paths and reasons only", async () => {
    const r = await checkHeaders("https://sa-dac3.vercel.app", fake("noindex", 404));
    // Four noindex pages, and the favicon is a 404.
    expect(r.findings.map((f) => f.path)).toEqual([
      "/",
      "/growth",
      "/privacy",
      "/terms",
      "/favicon.ico",
    ]);
    expect(r.findings.at(-1)!.problem).toBe("answered 404, not 200");
    expect(r.lines.at(-1)).toMatch(/^5 problem\(s\) on https:\/\/sa-dac3\.vercel\.app\./);
    expect(r.lines.join("\n")).not.toContain("SECRET");
  });
});
