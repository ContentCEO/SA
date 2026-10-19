import { BRAND } from "@/config/brand";
import { siteConfig } from "@/config/site";

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const esc = escapeHtml;

const FONT = "Inter,Helvetica,Arial,sans-serif";

/**
 * Check 18 P7 / Check 7 P10: the one HTML shell every email uses. It declares the language,
 * charset, viewport and a light-only color scheme; the paper background sits on an outer table
 * with `bgcolor` as well as `style` (Gmail replaces <body> with a div); and a hidden preheader
 * gives inbox lists a content-free line instead of the headline words.
 */
export function emailShell(opts: { preheader: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
</head>
<body style="margin:0;padding:0;background:${BRAND.paper};color:${BRAND.charcoal};font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${BRAND.paper};opacity:0">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.paper}" style="background:${BRAND.paper};border-collapse:collapse"><tr><td align="center" style="padding:24px 16px">
<div style="max-width:480px;margin:0 auto;text-align:left;color:${BRAND.charcoal};font-family:${FONT}">
${opts.bodyHtml}
</div>
</td></tr></table>
</body>
</html>`;
}

/** The serif-over-heavy headline. */
export function emailHeadline(serif: string, heavy: string): string {
  return `<p style="margin:0;font-family:Georgia,serif;font-style:italic;font-size:24px">${esc(serif)}</p>
<p style="margin:0 0 20px;font-weight:900;font-size:30px;letter-spacing:-0.02em">${esc(heavy)}</p>`;
}

/** One paragraph of body text (escaped). */
export function emailParagraph(text: string): string {
  return `<p style="margin:0 0 12px;font-size:17px;line-height:1.45">${esc(text)}</p>`;
}

/**
 * The one button. The 2px off-white border is invisible on the paper background and becomes a
 * light edge when a mail app darkens the page, so a charcoal button never vanishes into it.
 */
export function emailButton(label: string, url: string): string {
  return `<p style="margin:24px 0"><a href="${esc(url)}" style="display:inline-block;background:${BRAND.charcoal};color:${BRAND.offwhite};text-decoration:none;font-weight:700;font-size:17px;padding:14px 22px;border-radius:10px;border:2px solid ${BRAND.offwhite}">${esc(label)}</a></p>`;
}

/** A footer link as a block, padded to a 44px target, at the footer's 14px size. */
export function emailFooterLink(label: string, url: string): string {
  return `<p style="margin:0"><a href="${esc(url)}" style="display:block;padding:13px 0;font-size:14px;line-height:18px;color:${BRAND.slate};text-decoration:underline">${esc(label)}</a></p>`;
}

/** The footer line, its links, and the copyright. */
export function emailFooter(opts: {
  footer: string;
  links?: { label: string; url: string }[];
}): string {
  return [
    `<p style="margin:24px 0 4px;font-size:14px;color:${BRAND.slate}">${esc(opts.footer)}</p>`,
    ...(opts.links ?? []).map((l) => emailFooterLink(l.label, l.url)),
    `<p style="margin:4px 0 0;font-size:14px;color:${BRAND.slate}">${esc(siteConfig.copyright)}</p>`,
  ].join("\n");
}

export type BrandEmailOptions = {
  serif: string;
  heavy: string;
  /** Plain paragraphs (escaped here). */
  lines: string[];
  /**
   * Pre-escaped blocks that take the lines' place in the HTML (the summaries' own sections);
   * `lines` still make the plain-text part.
   */
  htmlBody?: string;
  button?: { label: string; url: string };
  footer: string;
  /** A link under the footer line, as a 44px block (the summaries' "Change or turn off"). */
  footerLink?: { label: string; url: string };
  /** A one-click way to stop this kind of email (trial emails, 2026-10-16). */
  stopLink?: { label: string; url: string };
  /** The hidden line inbox lists show. Content-free; defaults to the first line. */
  preheader?: string;
};

/** The HTML of a brand email: shell + headline + body + button + footer. */
export function emailHtml(opts: BrandEmailOptions): string {
  const links = [
    ...(opts.footerLink ? [opts.footerLink] : []),
    ...(opts.stopLink ? [opts.stopLink] : []),
  ];
  const bodyHtml = [
    emailHeadline(opts.serif, opts.heavy),
    opts.htmlBody ?? opts.lines.map(emailParagraph).join("\n"),
    opts.button ? emailButton(opts.button.label, opts.button.url) : "",
    emailFooter({ footer: opts.footer, links }),
  ]
    .filter(Boolean)
    .join("\n");
  return emailShell({ preheader: opts.preheader ?? opts.lines[0] ?? opts.heavy, bodyHtml });
}

/** Our plain, on-brand email: serif-over-heavy headline, short lines, one button. */
export function brandEmail(opts: BrandEmailOptions) {
  const text = [
    ...opts.lines,
    "",
    ...(opts.button ? [`${opts.button.label}: ${opts.button.url}`, ""] : []),
    opts.footer,
    ...(opts.footerLink ? [`${opts.footerLink.label}: ${opts.footerLink.url}`] : []),
    ...(opts.stopLink ? [`${opts.stopLink.label}: ${opts.stopLink.url}`] : []),
    siteConfig.copyright,
  ].join("\n");
  return { text, html: emailHtml(opts) };
}
