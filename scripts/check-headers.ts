/**
 * Check 1 P6: right after a deploy or the domain move (docs/LAUNCH.md step 5),
 *   pnpm check:headers https://<your domain>
 * fetches /, /growth, /privacy, /terms and /favicon.ico and fails with a plain message if any
 * response carries x-robots-tag: noindex or the favicon isn't a 200 image. It prints only the
 * paths and those findings: no cookies, no other headers, no bodies. Exit code 1 on a failure.
 * Rules are pure and unit-tested in src/lib/check-headers-rules.ts.
 */
import {
  formatFindings,
  HEADER_CHECK_PATHS,
  headerFindings,
  type FetchedHead,
} from "../src/lib/check-headers-rules";

type Fetch = typeof fetch;

export async function checkHeaders(base: string, fetchImpl: Fetch = fetch) {
  const heads: FetchedHead[] = [];
  for (const path of HEADER_CHECK_PATHS) {
    const res = await fetchImpl(new URL(path, base).toString(), {
      redirect: "follow",
      headers: { "user-agent": "squared-away-check-headers" },
    });
    // Only the two headers the rules read are kept.
    const headers: Record<string, string> = {};
    for (const k of ["x-robots-tag", "content-type"]) {
      const v = res.headers.get(k);
      if (v) headers[k] = v;
    }
    await res.arrayBuffer(); // drain, never read
    heads.push({ path, status: res.status, headers });
  }
  const findings = headerFindings(heads);
  return { findings, lines: formatFindings(base, findings) };
}

async function main() {
  const base = (process.argv[2] ?? process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    console.error("Usage: pnpm check:headers https://<your domain>   (default: APP_URL)");
    process.exit(2);
  }
  const { findings, lines } = await checkHeaders(base);
  for (const l of lines) console.log(l);
  process.exit(findings.length ? 1 : 0);
}

if (process.argv[1]?.endsWith("check-headers.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.name : "error");
    process.exit(1);
  });
}
