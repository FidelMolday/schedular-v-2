import crypto from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawToken = searchParams.get("token");

  if (!rawToken) {
    return NextResponse.json({ valid: false, error: "Missing token." }, { status: 400 });
  }

  const resetToken = await db.passwordResetToken.findUnique({
    where: { token: hashToken(rawToken) },
    include: { admin: { select: { name: true, email: true, isActive: true } } },
  });

  if (!resetToken || !resetToken.admin.isActive) {
    return NextResponse.json({ valid: false, error: "Invalid setup link." }, { status: 200 });
  }

  if (resetToken.usedAt) {
    return NextResponse.json({ valid: false, error: "This setup link has already been used.", reason: "used" }, { status: 200 });
  }

  if (resetToken.expires < new Date()) {
    return NextResponse.json({ valid: false, error: "This setup link has expired.", reason: "expired" }, { status: 200 });
  }

  return NextResponse.json({ valid: true, name: resetToken.admin.name, email: resetToken.admin.email });
}

export async function POST(request: Request) {
  try {
    // Defense-in-depth: rate-limit token submissions to slow brute-force.
    // Tokens are already 256-bit random values, so this is not the primary
    // protection — just an additional layer.
    const ip = getClientIp(request.headers);
    if (!checkRateLimit(`setup-password:${ip}`, 10, 15 * 60 * 1000)) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const { token: rawToken, password } = await request.json();

    if (!rawToken || !password) {
      return NextResponse.json({ error: "Token and password are required." }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const resetToken = await db.passwordResetToken.findUnique({
      where: { token: hashToken(rawToken) },
      include: { admin: true },
    });

    if (!resetToken) {
      return NextResponse.json({ error: "Invalid or expired setup link." }, { status: 404 });
    }

    // A token for an inactive or deleted admin is indistinguishable from an
    // invalid token and cannot be used to set a password.
    if (!resetToken.admin?.isActive) {
      return NextResponse.json({ error: "Invalid or expired setup link." }, { status: 404 });
    }

    if (resetToken.usedAt) {
      return NextResponse.json({ error: "This setup link has already been used." }, { status: 410 });
    }

    if (resetToken.expires < new Date()) {
      return NextResponse.json({ error: "This setup link has expired." }, { status: 410 });
    }

    const passwordHash = await hashPassword(password);

    await db.$transaction([
      db.admin.update({
        where: { id: resetToken.adminId },
        data: { passwordHash },
      }),
      db.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Setup password error:", error);
    return NextResponse.json({ error: "Failed to set password." }, { status: 500 });
  }
}
