import type { Page } from "@playwright/test";

/**
 * What the page's live regions hold, as a screen reader sees them (Check 32 P5). The regions
 * live in closed shadow roots (src/components/app/announcers.tsx), out of Playwright's reach,
 * so this reads Chromium's accessibility tree: the text under every node with a `live`
 * property of "polite" (status) or "assertive" (alert).
 */
export async function announced(page: Page): Promise<{ polite: string; assertive: string }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes: {
        nodeId: string;
        role?: { value?: string };
        name?: { value?: string };
        childIds?: string[];
        properties?: { name: string; value: { value?: unknown } }[];
      }[];
    };
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const textUnder = (id: string): string => {
      const n = byId.get(id);
      if (!n) return "";
      if (n.role?.value === "StaticText") return String(n.name?.value ?? "");
      return (n.childIds ?? []).map(textUnder).join("");
    };
    const out = { polite: "", assertive: "" };
    for (const n of nodes) {
      const live = n.properties?.find((p) => p.name === "live")?.value.value;
      const role = n.role?.value;
      if (live === "polite" && role === "status") out.polite += textUnder(n.nodeId);
      if (live === "assertive" && role === "alert") out.assertive += textUnder(n.nodeId);
    }
    return out;
  } finally {
    await cdp.detach();
  }
}
