import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_PATH_HEADER } from "@/config/legal";
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
  const headers = new Headers(request.headers);
  headers.set(REQUEST_PATH_HEADER, requestPathOf(request.nextUrl.pathname, request.nextUrl.search));
  return NextResponse.next({ request: { headers } });
}

/**
 * The signed-in screens only (the top-level folders of src/app/(app), plus /welcome); a unit test
 * keeps this list in step with those folders. Server actions post to their screen's path, so
 * they're covered too. Marketing pages, API routes and files never run it.
 */
export const config = {
  matcher: [
    "/queue/:path*",
    "/inbox/:path*",
    "/quotes/:path*",
    "/customers/:path*",
    "/activity/:path*",
    "/money/:path*",
    "/settings/:path*",
    "/billing/:path*",
    "/connect/:path*",
    "/record/:path*",
    "/admin/:path*",
    "/welcome/:path*",
  ],
};
