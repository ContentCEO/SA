import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_PATH_HEADER } from "@/config/legal";
import { homeRedirect } from "@/lib/home-redirect";
import { requestPathOf } from "@/server/terms-rules";

/**
 * One job (Davi, 2026-10-15, the "I agree" boxes): tell the signed-in screens which path and
 * query were asked for, in a request header, so someone sent to /welcome/terms comes back to
 * that screen once they agree (a server page can't see its own URL otherwise). It always
 * overwrites whatever a client sent in that header, checks nothing and blocks nothing: every
 * screen and action still checks the session and the terms itself (requireOwner), and the value
 * is only ever used as a same-origin relative path (safeNextPath).
 */
export function proxy(request: NextRequest) {
  // Check 29 P3: "/" is a prerendered page (served from the CDN); a visitor with a session
  // cookie goes to their screens instead. Nothing else is done on "/".
  if (request.nextUrl.pathname === "/") {
    // Page loads only: a form's POST to "/" (the waitlist's server action) is never redirected.
    const page = request.method === "GET" || request.method === "HEAD";
    const to =
      page &&
      homeRedirect(
        "/",
        request.cookies.getAll().map((c) => c.name),
      );
    return to ? NextResponse.redirect(new URL(to, request.url)) : NextResponse.next();
  }
  const headers = new Headers(request.headers);
  headers.set(REQUEST_PATH_HEADER, requestPathOf(request.nextUrl.pathname, request.nextUrl.search));
  return NextResponse.next({ request: { headers } });
}

/**
 * The signed-in screens only (the top-level folders of src/app/(app), plus /welcome, /start and
 * /my-growth); a unit test
 * keeps this list in step with those folders. Server actions post to their screen's path, so
 * they're covered too. Marketing pages, API routes and files never run it — except "/", for
 * the signed-in redirect only.
 */
export const config = {
  matcher: [
    // Check 29 P3: the homepage, only for the signed-in redirect (no path header there).
    "/",
    "/queue/:path*",
    "/inbox/:path*",
    "/quotes/:path*",
    "/customers/:path*",
    "/activity/:path*",
    "/money/:path*",
    "/more/:path*",
    "/settings/:path*",
    "/billing/:path*",
    "/connect/:path*",
    "/record/:path*",
    "/admin/:path*",
    "/welcome/:path*",
    // Squared Away Growth (2026-10-16): the sign-in choice and the client's dashboard.
    "/start/:path*",
    "/my-growth/:path*",
  ],
};
