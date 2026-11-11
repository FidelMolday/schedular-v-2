import { auth } from "@/auth";
import { NextResponse, NextRequest } from "next/server";

const SECURITY_HEADERS: [string, string][] = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
];

function contentSecurityPolicy(): string {
  const scriptSrc =
    process.env.NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const ADMIN_ONLY_ROUTES = [
  "/admin/my-area",
  "/admin/my-availability",
  "/admin/settings",
];

const adminAuth = auth((req) => {
  const { pathname } = req.nextUrl;

  if (!req.auth || (req.auth.user as any)?.isActive !== true) {
    const signInUrl = new URL("/auth/signin", req.url);
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }

  const role = (req.auth.user as any)?.role;

  if (role === "admin" && !ADMIN_ONLY_ROUTES.some((r) => pathname.startsWith(r))) {
    return NextResponse.redirect(new URL("/admin/my-area", req.url));
  }

  return NextResponse.next();
});

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/admin")) {
    return (adminAuth as any)(req);
  }
  const res = NextResponse.next();
  for (const [key, value] of SECURITY_HEADERS) {
    res.headers.set(key, value);
  }
  res.headers.set("Content-Security-Policy", contentSecurityPolicy());
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
