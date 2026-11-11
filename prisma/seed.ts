import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const db = new PrismaClient({ adapter });

// Production starts with exactly ONE admin: the organisation owner. No demo
// admins, no seed project, no sample bookings/participants. The org_owner
// signs in via Microsoft/Azure AD (password login is intentionally blocked
// for org_owner) — an Admin row with this email and isActive=true is the
// whole invite gate.
const orgOwnerEmail = process.env.ORG_OWNER_EMAIL?.trim() || (process.env.NODE_ENV === "production"
  ? (() => { throw new Error("ORG_OWNER_EMAIL is required when seeding production."); })()
  : "owner@example.test");

const ORG_OWNER = {
  id: "a0",
  name: "Mwebi Caleb",
  initials: "MC",
  email: orgOwnerEmail,
  role: "org_owner" as const,
  accountType: "organizational" as const,
};

async function main() {
  console.log("Seeding database...");

  await db.admin.upsert({
    where: { id: ORG_OWNER.id },
    update: {
      name: ORG_OWNER.name,
      initials: ORG_OWNER.initials,
      email: ORG_OWNER.email,
      role: ORG_OWNER.role,
      accountType: ORG_OWNER.accountType,
    },
    create: ORG_OWNER,
  });
  console.log(`  Created org_owner: ${ORG_OWNER.name} (${ORG_OWNER.email})`);

  // Seed global default email templates for all 11 categories. These are
  // production configuration (not demo data) — the app needs them to send any
  // email at all. Branding is placeholder-driven ({{company_name}}), with a
  // neutral "Eureka" footer.
  const TEMPLATES: {
    category: string;
    audience: string;
    subject: string;
    bodyHtml: string;
  }[] = [
    {
      category: "admin_invitation",
      audience: "admin",
      subject: "You've been added to {{project_name}} at {{company_name}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<h1 style="margin:0;font-size:20px;font-weight:700;color:#111827;">You've been added to {{project_name}}</h1>
<p>You've been added as an associate on <strong>{{project_name}}</strong> at {{company_name}}.</p>
<p>To access your account, check your inbox for a setup link from your organisation owner. Use that link to create your password and sign in.</p>
<p style="margin:16px 0 0;">You don't need a Microsoft account to sign in — just your email and the password you set up.</p>
<p>Eureka &mdash; multi-project scheduling platform</p>
</div>`,
    },
    {
      category: "availability_request",
      audience: "admin",
      subject: "Availability requested for {{project_name}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{admin_name}},</p>
<p>We need your availability for <strong>{{project_name}}</strong>. Please use the link below to mark the times you're available over the next {{availability_period}} days.</p>
<p style="margin:24px 0;"><a href="{{booking_link}}" style="background:#4338CA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Set availability</a></p>
<p>Thank you for helping us schedule these interviews.</p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "participant_invitation",
      audience: "participant",
      subject: "You're invited to book a session — {{project_name}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>You are invited to schedule a <strong>{{project_name}}</strong> session with {{company_name}}.</p>
<p>Please choose a time that works for you using the link below.</p>
<p style="margin:24px 0;"><a href="{{booking_link}}" style="background:#4338CA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Book a time</a></p>
<p>If none of the available times work, you can join the waitlist for additional slots.</p>
<p>We look forward to meeting you.</p>
<p>Best regards,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "booking_confirmation",
      audience: "participant",
      subject: "Confirmed: {{project_name}} on {{session_date}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>Your session is confirmed.</p>
<div style="border:2px dashed #DCE1FB;border-radius:12px;padding:20px;margin:20px 0;background:#EEF1FD;">
<p style="margin:0 0 8px;"><strong>{{project_name}}</strong></p>
<p style="margin:0 0 4px;">{{session_date}} · {{session_time}}</p>
<p style="margin:0 0 4px;">{{time_zone}}</p>
{{#unless is_feedback}}<p style="margin:0 0 4px;">Interviewer: {{admin_name}}</p>
{{/unless is_feedback}}{{#unless has_meeting_link}}<p style="margin:12px 0 0;color:#6b7280;">Your meeting link is pending — you'll receive it shortly.</p>
{{/unless has_meeting_link}}{{#unless no_meeting_link}}<p style="margin:12px 0 0;"><a href="{{meeting_link}}" style="color:#4338CA;font-weight:600;">Join {{meeting_platform_label}} meeting</a></p>
{{/unless no_meeting_link}}</div>
<p style="margin:16px 0;"><a href="{{manage_booking_link}}" style="color:#4338CA;">Manage your booking</a> — reschedule or cancel while the self-service window is open.</p>
<p>The meeting link will also appear on your calendar invitation shortly.</p>
<p>Thanks,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "booking_confirmation",
      audience: "admin",
      subject: "New session booked: {{participant_name}} — {{project_name}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{admin_name}},</p>
<p>A new session has been booked for <strong>{{project_name}}</strong>.</p>
<div style="border:2px dashed #DCE1FB;border-radius:12px;padding:20px;margin:20px 0;background:#EEF1FD;">
<p style="margin:0 0 8px;"><strong>{{project_name}}</strong></p>
<p style="margin:0 0 4px;">{{session_date}} · {{session_time}}</p>
<p style="margin:0 0 4px;">{{time_zone}}</p>
{{#unless is_feedback}}<p style="margin:0 0 4px;">Interviewer: {{admin_name}}</p>
{{/unless is_feedback}}<p style="margin:0 0 4px;">Participant: {{participant_name}} ({{participant_email}})</p>
{{#unless has_meeting_link}}<p style="margin:12px 0 0;color:#6b7280;">Meeting link is pending — you'll receive it shortly.</p>
{{/unless has_meeting_link}}{{#unless no_meeting_link}}<p style="margin:12px 0 0;"><a href="{{meeting_link}}" style="color:#4338CA;font-weight:600;">Join {{meeting_platform_label}} meeting</a></p>
{{/unless no_meeting_link}}</div>
<p style="margin:16px 0;"><a href="{{manage_booking_link}}" style="color:#4338CA;">View or manage this session in your dashboard</a>.</p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "booking_confirmation",
      audience: "super_admin",
      subject: "Session booked: {{participant_name}} with {{admin_name}} — {{project_name}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{admin_name}},</p>
<p>A new session has been booked for <strong>{{project_name}}</strong>.</p>
<div style="border:2px dashed #DCE1FB;border-radius:12px;padding:20px;margin:20px 0;background:#EEF1FD;">
<p style="margin:0 0 8px;"><strong>{{project_name}}</strong></p>
<p style="margin:0 0 4px;">{{session_date}} · {{session_time}}</p>
<p style="margin:0 0 4px;">{{time_zone}}</p>
{{#unless is_feedback}}<p style="margin:0 0 4px;">Interviewer: {{admin_name}}</p>
{{/unless is_feedback}}<p style="margin:0 0 4px;">Participant: {{participant_name}} ({{participant_email}})</p>
{{#unless has_meeting_link}}<p style="margin:12px 0 0;color:#6b7280;">Meeting link is pending — you'll receive it shortly.</p>
{{/unless has_meeting_link}}{{#unless no_meeting_link}}<p style="margin:12px 0 0;"><a href="{{meeting_link}}" style="color:#4338CA;font-weight:600;">Join {{meeting_platform_label}} meeting</a></p>
{{/unless no_meeting_link}}{{#unless no_zoom_account}}<p style="margin:8px 0 4px;">Zoom account: {{zoom_account_label}} ({{zoom_account_email}})</p>
{{/unless no_zoom_account}}</div>
<p style="margin:16px 0;"><a href="{{manage_booking_link}}" style="color:#4338CA;">View or manage this session in your dashboard</a>.</p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "reminder_24h",
      audience: "participant",
      subject: "Reminder: {{project_name}} tomorrow at {{session_time}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>This is a reminder that your <strong>{{project_name}}</strong> session is tomorrow.</p>
<div style="border:2px dashed #DCE1FB;border-radius:12px;padding:20px;margin:20px 0;background:#EEF1FD;">
<p style="margin:0 0 8px;"><strong>{{project_name}}</strong></p>
<p style="margin:0 0 4px;">{{session_date}} · {{session_time}}</p>
<p style="margin:0 0 4px;">{{time_zone}}</p>
{{#unless is_feedback}}<p style="margin:0;">Interviewer: {{admin_name}}</p>
{{/unless is_feedback}}</div>
<p style="margin:24px 0;"><a href="{{meeting_link}}" style="background:#4338CA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Join meeting</a></p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "reminder_1h",
      audience: "participant",
      subject: "Starting soon: {{project_name}} at {{session_time}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>Your <strong>{{project_name}}</strong> session starts in about one hour.</p>
<p style="margin:24px 0;"><a href="{{meeting_link}}" style="background:#4338CA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Join meeting</a></p>
<p>Please ensure you have a quiet space and a working camera/microphone.</p>
<p>Good luck!<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "reminder",
      audience: "participant",
      subject: "Reminder: {{reminder_label}} — {{project_name}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>This is a reminder that your <strong>{{project_name}}</strong> session is coming up.</p>
<div style="border:2px dashed #DCE1FB;border-radius:12px;padding:20px;margin:20px 0;background:#EEF1FD;">
<p style="margin:0 0 8px;"><strong>{{project_name}}</strong></p>
<p style="margin:0 0 4px;">{{session_date}} · {{session_time}}</p>
<p style="margin:0 0 4px;">{{time_zone}}</p>
{{#unless is_feedback}}<p style="margin:0;">Interviewer: {{admin_name}}</p>
{{/unless is_feedback}}</div>
<p style="margin:24px 0;"><a href="{{meeting_link}}" style="background:#4338CA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Join meeting</a></p>
<p>Please ensure you have a quiet space and a working camera/microphone.</p>
<p>See you there!<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "reschedule_notice",
      audience: "participant",
      subject: "Rescheduled: {{project_name}} on {{session_date}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>Your <strong>{{project_name}}</strong> session has been rescheduled.</p>
<p>Please click below to view the new time and confirm your attendance.</p>
<p style="margin:24px 0;"><a href="{{booking_link}}" style="background:#4338CA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">View new time</a></p>
<p>We apologise for any inconvenience.</p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "cancellation_notice",
      audience: "participant",
      subject: "Cancelled: {{project_name}} on {{session_date}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>Your <strong>{{project_name}}</strong> session scheduled for {{session_date}} at {{session_time}} has been cancelled.</p>
<p>If you would like to reschedule, please visit the link below to book a new time.</p>
<p style="margin:24px 0;"><a href="{{booking_link}}" style="background:#4338CA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Book a new time</a></p>
<p>We apologise for the inconvenience.</p>
<p>Best regards,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "waitlist_offer",
      audience: "participant",
      subject: "A slot just opened up — {{project_name}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>A new slot has opened up for <strong>{{project_name}}</strong> at {{company_name}}.</p>
<p>Availability is limited, so grab it before it's taken.</p>
<p style="margin:24px 0;"><a href="{{booking_link}}" style="background:#4338CA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Book now</a></p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "zoom_fallback_to_teams",
      audience: "super_admin",
      subject: "Zoom unavailable — {{project_name}} session booked on Teams",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{admin_name}},</p>
<p>We couldn't place a Zoom meeting for the <strong>{{project_name}}</strong> session on {{session_date}} at {{session_time}} ({{participant_name}}), so a <strong>Microsoft Teams</strong> meeting was created instead.</p>
<p>This usually means the Zoom account pool was full or the Zoom API briefly failed. No action is needed unless you want to review your Zoom pool.</p>
<p>Manage this booking: <a href="{{manage_booking_link}}">{{manage_booking_link}}</a></p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "zoom_pool_full_no_fallback",
      audience: "super_admin",
      subject: "Action needed — no meeting link for {{project_name}} ({{session_date}})",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{admin_name}},</p>
<p>The <strong>{{project_name}}</strong> session on {{session_date}} at {{session_time}} ({{participant_name}}) could not receive a Zoom meeting: every licensed Zoom account is busy and this project does not fall back to Teams.</p>
<p>The participant was confirmed without a meeting link. Please either add a licensed Zoom account to the pool or switch this project to "Automatic" meeting selection.</p>
<p>Manage this booking: <a href="{{manage_booking_link}}">{{manage_booking_link}}</a></p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
    {
      category: "verification_pin",
      audience: "participant",
      subject: "Your verification code: {{pin}}",
      bodyHtml: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<p>Hi {{participant_name}},</p>
<p>Your verification code for <strong>{{project_name}}</strong> is:</p>
<div style="background:#EEF1FD;border:2px dashed #DCE1FB;border-radius:12px;padding:20px;margin:20px 0;text-align:center;">
<p style="margin:0;font-size:32px;font-weight:700;letter-spacing:8px;color:#4338CA;">{{pin}}</p>
</div>
<p>This code expires in 10 minutes.</p>
<p>If you did not request this code, you can safely ignore this email.</p>
<p>Best,<br/>{{company_name}}</p>
</div>`,
    },
  ];

  for (const t of TEMPLATES) {
    const existing = await db.emailTemplate.findFirst({
      where: { category: t.category as any, audience: t.audience as any, projectId: null, isActive: true },
    });
    if (existing) {
      await db.emailTemplate.update({
        where: { id: existing.id },
        data: {
          subject: t.subject,
          bodyHtml: t.bodyHtml,
          version: existing.version + 1,
        },
      });
    } else {
      await db.emailTemplate.create({
        data: {
          category: t.category as any,
          audience: t.audience as any,
          projectId: null,
          subject: t.subject,
          bodyHtml: t.bodyHtml,
          version: 1,
          isActive: true,
        },
      });
    }
  }
  console.log(`  Created ${TEMPLATES.length} global email templates`);

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
