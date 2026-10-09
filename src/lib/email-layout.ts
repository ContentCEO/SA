import { siteConfig } from "@/config/site";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Our plain, on-brand email: serif-over-heavy headline, short lines, one button. */
export function brandEmail(opts: {
  serif: string;
  heavy: string;
  lines: string[];
  button?: { label: string; url: string };
  footer: string;
}) {
  const text = [
    ...opts.lines,
    "",
    ...(opts.button ? [`${opts.button.label}: ${opts.button.url}`, ""] : []),
    opts.footer,
    siteConfig.copyright,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f7f6f3;color:#1b1b1b;font-family:Inter,Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:24px 16px">
<p style="margin:0;font-family:Georgia,serif;font-style:italic;font-size:24px">${esc(opts.serif)}</p>
<p style="margin:0 0 20px;font-weight:900;font-size:30px;letter-spacing:-0.02em">${esc(opts.heavy)}</p>
${opts.lines.map((l) => `<p style="margin:0 0 12px;font-size:17px;line-height:1.45">${esc(l)}</p>`).join("\n")}
${
  opts.button
    ? `<p style="margin:24px 0"><a href="${esc(opts.button.url)}" style="display:inline-block;background:#1b1b1b;color:#efeeea;text-decoration:none;font-weight:700;font-size:17px;padding:14px 22px;border-radius:10px">${esc(opts.button.label)}</a></p>`
    : ""
}
<p style="margin:24px 0 4px;font-size:14px;color:#5e5d59">${esc(opts.footer)}</p>
<p style="margin:0;font-size:14px;color:#5e5d59">${esc(siteConfig.copyright)}</p>
</div></body></html>`;
  return { text, html };
}
