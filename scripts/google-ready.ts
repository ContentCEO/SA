/**
 * Check 28 P6: read the public pages the way Google's verification reviewer does, before
 * submitting (docs/LAUNCH.md 0e):  pnpm google:ready https://<your domain>
 * (default: APP_URL). Plain fetch, no cookies, never signs in, never sends anything, never prints
 * a page body: only PASS / FAIL lines and the reason. Exit code 1 if any line fails.
 * The rules are pure and unit-tested in src/lib/google-ready-rules.ts.
 */
import { readFileSync } from "node:fs";
import {
  formatChecks,
  googleReadyChecks,
  limitedUseSentenceFrom,
  type FetchedPage,
} from "../src/lib/google-ready-rules";

type Fetch = typeof fetch;

/** Fetch one path; follow a redirect only on the same host (at most 3), record a foreign one. */
export async function fetchPage(
  base: string,
  path: string,
  fetchImpl: Fetch,
): Promise<FetchedPage> {
  let url = new URL(path, base).toString();
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetchImpl(url, {
      redirect: "manual",
      headers: { accept: "text/html,application/json", "user-agent": "squared-away-google-ready" },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    if (res.status >= 300 && res.status < 400 && headers.location) {
      const to = new URL(headers.location, url).toString();
      if (new URL(to).host !== new URL(base).host || hop === 3) {
        return { status: res.status, headers, body: "", redirectedTo: to };
      }
      url = to;
      continue;
    }
    return { status: res.status, headers, body: await res.text(), redirectedTo: null };
  }
  throw new Error("unreachable");
}

export async function runGoogleReady(base: string, fetchImpl: Fetch = fetch) {
  const doc = readFileSync("docs/google-verification.md", "utf8");
  const [home, privacy, terms, health] = await Promise.all(
    ["/", "/privacy", "/terms", "/api/health"].map((p) => fetchPage(base, p, fetchImpl)),
  );
  return googleReadyChecks({
    base,
    pages: { home: home!, privacy: privacy!, terms: terms!, health: health! },
    limitedUseSentence: limitedUseSentenceFrom(doc),
  });
}

async function main() {
  const base = (process.argv[2] ?? process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    console.error("Usage: pnpm google:ready https://<your domain>   (default: APP_URL)");
    process.exit(2);
  }
  const checks = await runGoogleReady(base);
  for (const line of formatChecks(checks)) console.log(line);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `${failed} check(s) failed on ${base}.` : `All checks passed on ${base}.`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1]?.endsWith("google-ready.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.name : "error");
    process.exit(1);
  });
}
