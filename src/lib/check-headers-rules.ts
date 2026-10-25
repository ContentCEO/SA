/**
 * Check 1 P6: after every deploy, the public pages must not be hidden from search. Pure rules for
 * `scripts/check-headers.ts` (`pnpm check:headers <url>`): given each fetched path's status and
 * the two headers that matter, say which paths fail and why. Nothing else from a response is
 * looked at, kept or printed.
 */

export const HEADER_CHECK_PATHS = ["/", "/growth", "/privacy", "/terms", "/favicon.ico"] as const;
export type HeaderCheckPath = (typeof HEADER_CHECK_PATHS)[number];

export type FetchedHead = {
  path: HeaderCheckPath;
  status: number;
  /** Lower-cased header names; only x-robots-tag and content-type are read. */
  headers: Record<string, string>;
};

export type HeaderFinding = { path: string; problem: string };

export function headerFindings(heads: FetchedHead[]): HeaderFinding[] {
  const out: HeaderFinding[] = [];
  const seen = new Set<string>();
  for (const h of heads) {
    seen.add(h.path);
    if (/noindex/i.test(h.headers["x-robots-tag"] ?? "")) {
      out.push({
        path: h.path,
        problem: "sent with x-robots-tag: noindex (search engines skip it)",
      });
    }
    if (h.path === "/favicon.ico") {
      if (h.status !== 200) out.push({ path: h.path, problem: `answered ${h.status}, not 200` });
      else if (!/image\//i.test(h.headers["content-type"] ?? "")) {
        out.push({ path: h.path, problem: "isn't an image" });
      }
    } else if (h.status !== 200) {
      out.push({ path: h.path, problem: `answered ${h.status}, not 200` });
    }
  }
  for (const p of HEADER_CHECK_PATHS) {
    if (!seen.has(p)) out.push({ path: p, problem: "wasn't checked (no response)" });
  }
  return out;
}

/** Plain lines for the terminal. */
export function formatFindings(base: string, findings: HeaderFinding[]): string[] {
  if (findings.length === 0) return [`All checks passed on ${base}: no noindex, favicon answers.`];
  return [
    ...findings.map((f) => `FAIL ${f.path}: ${f.problem}`),
    `${findings.length} problem(s) on ${base}. Previews are expected to fail (Vercel adds noindex to them); production must pass.`,
  ];
}
