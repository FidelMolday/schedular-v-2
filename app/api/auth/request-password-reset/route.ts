import { NextResponse } from "next/server";
import { Resend } from "resend";
import { stripHtml } from "@/lib/html-to-text";
import { db } from "@/lib/db";
import { createPasswordToken } from "@/lib/data/password-reset";
import { logNotification } from "@/lib/data/notifications";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request.headers);
    if (!checkRateLimit(`password-reset:${ip}`, 5, 15 * 60 * 1000)) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const { email } = await request.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required." }, { status: 400 });
    }

    const admin = await db.admin.findUnique({ where: { email: email.toLowerCase().trim() } });

    // Unknown and inactive addresses share the same generic success response;
    // only active accounts receive a reset/setup email.
    if (admin?.isActive) {
      if (admin.passwordHash) {
        // Real reset — send a password reset email
        const { rawToken } = await createPasswordToken(admin.id);
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
        const resetUrl = `${baseUrl}/auth/reset-password/${rawToken}`;

        const html = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:40px 20px;background-color:#f3f4f6;">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 32px 0;">
<h1 style="margin:0;font-size:20px;font-weight:700;color:#111827;">Reset your password</h1>
</td></tr>
<tr><td style="padding:16px 32px;">
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">Hi ${admin.name},</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">
We received a request to reset the password for your Scheduler account.
</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">
Click the button below to set a new password. This link expires in 48 hours.
</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
<tr><td style="background-color:#7c3aed;border-radius:8px;padding:12px 24px;">
<a href="${resetUrl}" style="color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;display:inline-block;">
Reset your password
</a>
</td></tr>
</table>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">
If you did not request a password reset, you can safely ignore this email.
</p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e5e7eb;">
<p style="margin:0;font-size:12px;color:#9ca3af;">
Scheduler &mdash; Multi-project scheduling platform
</p>
</td></tr>
</table>
</td></tr>
</table>`;

        const resend = new Resend(process.env.RESEND_API_KEY ?? "");
        await resend.emails.send({
          from: process.env.EMAIL_FROM ?? "Scheduler <notifications@eureka-ent.org>",
          to: email,
          subject: "Reset your Scheduler password",
          html,
          text: stripHtml(html),
        });

        await logNotification({
          category: "admin_invitation",
          recipientEmail: email,
          recipientRole: "admin",
          subject: "Reset your Scheduler password",
          renderedBody: html,
          status: "sent",
        });
      } else {
        // No password yet — send guidance to check invite
        const html = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:40px 20px;background-color:#f3f4f6;">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 32px 0;">
<h1 style="margin:0;font-size:20px;font-weight:700;color:#111827;">Password setup required</h1>
</td></tr>
<tr><td style="padding:16px 32px;">
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">Hi ${admin.name},</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">
Your Scheduler account has not been activated yet. You&rsquo;ll need to use the setup link from your original invitation email to create a password.
</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">
If you can&rsquo;t find the invitation email, please contact your organisation owner to send a new one.
</p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e5e7eb;">
<p style="margin:0;font-size:12px;color:#9ca3af;">
Scheduler &mdash; Multi-project scheduling platform
</p>
</td></tr>
</table>
</td></tr>
</table>`;

        const resend = new Resend(process.env.RESEND_API_KEY ?? "");
        await resend.emails.send({
          from: process.env.EMAIL_FROM ?? "Scheduler <notifications@eureka-ent.org>",
          to: email,
          subject: "Activate your Scheduler account",
          html,
          text: stripHtml(html),
        });

        await logNotification({
          category: "admin_invitation",
          recipientEmail: email,
          recipientRole: "admin",
          subject: "Activate your Scheduler account",
          renderedBody: html,
          status: "sent",
        });
      }
    }

    // Always respond with the same generic message
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Request password reset error:", error);
    return NextResponse.json({ error: "Failed to process request." }, { status: 500 });
  }
}

