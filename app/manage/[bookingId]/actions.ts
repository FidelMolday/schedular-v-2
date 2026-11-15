"use server";

import { db } from "@/lib/db";
import { demoRecipientEmail, isDemoProjectId } from "@/lib/demo";
import { cancelBooking, rescheduleBookingTime } from "@/lib/data/bookings";
import { hoursUntilSession } from "@/lib/slotHelpers";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { signManageToken } from "@/lib/manage-token";
import { createVerificationPin, verifyPin } from "@/lib/pin";
import { getActiveTemplate } from "@/lib/data/templates";
import { renderTemplate } from "@/lib/template-utils";
import { Resend } from "resend";
import { auth } from "@/auth";
import { requireActiveSession, requireBookingAccess } from "@/lib/authz";
import { verifyManageToken } from "@/lib/manage-token";

const PIN_FROM = process.env.EMAIL_FROM ?? "Scheduler <onboarding@resend.dev>";

async function getBookingWithProject(bookingId: string) {
  return db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, adminId: true, projectId: true, dateKey: true, time: true, participantEmail: true, project: { select: { timezone: true, selfServiceWindowHours: true } } },
  });
}

async function authorizeManageMutation(bookingId: string, token?: string) {
  const booking = await getBookingWithProject(bookingId);
  if (!booking) throw new Error("Booking not found");

  if (token) {
    const verified = verifyManageToken(token);
    if (!verified || verified.bookingId !== bookingId) throw new Error("Unauthorized");
    if (verified.scope === "p") {
      if (verified.email !== booking.participantEmail.toLowerCase().trim()) throw new Error("Unauthorized");
      return { booking, actorType: "participant" as const, actorLabel: "Self-service" };
    }

    const actor = await requireActiveSession(() => null);
    if (!actor || !("id" in actor)) throw new Error("Unauthorized");
    const admin = await db.admin.findUnique({ where: { id: actor.id }, select: { email: true } });
    if (!admin || verified.email !== admin.email.toLowerCase().trim()) throw new Error("Unauthorized");
    const access = await requireBookingAccess(actor, bookingId, () => null);
    if (!access || !("id" in access)) throw new Error("Forbidden");
    return { booking, actorType: "admin" as const, actorLabel: admin.email };
  }

  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) throw new Error("Unauthorized");
  const access = await requireBookingAccess(actor, bookingId, () => null);
  if (!access || !("id" in access)) throw new Error("Forbidden");
  const admin = await db.admin.findUnique({ where: { id: actor.id }, select: { email: true } });
  return { booking, actorType: "admin" as const, actorLabel: admin?.email ?? actor.id };
}

async function assertSelfServiceWindow(bookingId: string) {
  const b = await getBookingWithProject(bookingId);
  if (!b) throw new Error("Booking not found");
  const hoursLeft = hoursUntilSession(b.dateKey, b.time, b.project.timezone);
  if (hoursLeft < b.project.selfServiceWindowHours) {
    throw new Error("The self-service window has closed — changes must be made by an admin");
  }
}

export async function requestManagePin(
  bookingId: string,
  email: string
): Promise<{ sent: true } | { sent: false; error: string }> {
  const hdrs = await headers();
  const ip = getClientIp(hdrs);
  if (!checkRateLimit(`manage-pin-request:${ip}`, 10, 15 * 60 * 1000)) {
    return { sent: false, error: "Too many attempts. Please try again later." };
  }

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      participantEmail: true,
      participantName: true,
      projectId: true,
      project: { select: { name: true, company: true } },
    },
  });
  if (!booking) {
    return { sent: false, error: "Booking not found." };
  }
  if (booking.participantEmail.toLowerCase().trim() !== email.toLowerCase().trim()) {
    return { sent: false, error: "Email does not match our records." };
  }

  let pin: string;
  try {
    const result = await createVerificationPin(bookingId, booking.participantEmail);
    pin = result.pin;
  } catch (err) {
    console.error("[pin] Failed to create verification pin:", err);
    return { sent: false, error: "Failed to generate verification code. Please try again." };
  }

  // Send PIN email
  try {
    const template = await getActiveTemplate("verification_pin", booking.projectId);
    if (!template) {
      console.error("[pin] No active verification_pin template found for project:", booking.projectId);
      return { sent: false, error: "Email template not configured. Please contact support." };
    }
    const ctx = {
      participant_name: booking.participantName,
      project_name: booking.project.name ?? "",
      company_name: booking.project.company ?? "",
      pin,
    };
    const rendered = renderTemplate(template, ctx);
    const resend = new Resend(process.env.RESEND_API_KEY ?? "");
    const { error } = await resend.emails.send({
      from: PIN_FROM,
      to: isDemoProjectId(booking.projectId)
        ? demoRecipientEmail("participant", booking.participantEmail)
        : booking.participantEmail,
      subject: rendered.subject,
      html: rendered.bodyHtml,
    });
    if (error) {
      console.error("[pin] Resend API error:", error);
      return { sent: false, error: "Failed to send verification email. Please try again." };
    }
  } catch (err) {
    console.error("[pin] Failed to send PIN email:", err);
    return { sent: false, error: "Failed to send verification email. Please try again." };
  }

  return { sent: true };
}

export async function verifyManagePin(
  bookingId: string,
  email: string,
  pin: string
): Promise<{ verified: true; token: string } | { verified: false; error: string }> {
  const hdrs = await headers();
  const ip = getClientIp(hdrs);
  if (!checkRateLimit(`manage-pin-verify:${ip}`, 10, 15 * 60 * 1000)) {
    return { verified: false, error: "Too many attempts. Please try again later." };
  }

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { participantEmail: true },
  });
  if (!booking) {
    return { verified: false, error: "Booking not found." };
  }
  if (booking.participantEmail.toLowerCase().trim() !== email.toLowerCase().trim()) {
    return { verified: false, error: "Email does not match our records." };
  }

  const result = await verifyPin(bookingId, booking.participantEmail, pin);
  if (!result.ok) {
    const errors: Record<string, string> = {
      not_found: "No verification code found. Please request a new one.",
      expired: "This code has expired. Please request a new one.",
      too_many_attempts: "Too many failed attempts. Please request a new code.",
      wrong_pin: "Incorrect code. Please try again.",
    };
    return { verified: false, error: errors[result.reason] };
  }

  return { verified: true, token: signManageToken(bookingId, booking.participantEmail) };
}

export async function participantCancelAction(bookingId: string, token?: string) {
  const hdrs = await headers();
  const ip = getClientIp(hdrs);
  if (!checkRateLimit(`manage-cancel:${ip}`, 5, 15 * 60 * 1000)) {
    throw new Error("Too many requests. Please try again later.");
  }

  const access = await authorizeManageMutation(bookingId, token);

  await assertSelfServiceWindow(bookingId);
  await cancelBooking(bookingId, { actorType: access.actorType, actorLabel: access.actorLabel });
  try {
    revalidatePath(`/manage/${bookingId}`);
  } catch (err) {
    console.error("Failed to revalidate manage page after participant cancel:", err);
  }
}

export async function participantRescheduleAction(
  bookingId: string,
  newDateKey: string,
  newTime: string,
  token?: string
): Promise<{ ok: true; newBookingId: string; token: string } | { ok: false; reason: string }> {
  const hdrs = await headers();
  const ip = getClientIp(hdrs);
  if (!checkRateLimit(`manage-reschedule:${ip}`, 5, 15 * 60 * 1000)) {
    throw new Error("Too many requests. Please try again later.");
  }

  let access: Awaited<ReturnType<typeof authorizeManageMutation>>;
  try {
    access = await authorizeManageMutation(bookingId, token);
  } catch {
    return { ok: false, reason: "Unauthorized — email verification required." };
  }

  await assertSelfServiceWindow(bookingId);

  // Read the project's lockRescheduleToOriginalAdmin setting
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { project: { select: { lockRescheduleToOriginalAdmin: true } } },
  });
  const keepSameAdmin = booking?.project.lockRescheduleToOriginalAdmin ?? true;

  const result = await rescheduleBookingTime(bookingId, newDateKey, newTime, {
    keepSameAdminIfPossible: keepSameAdmin,
    actor: { actorType: access.actorType, actorLabel: access.actorLabel },
  });
  if (result.ok) {
    const newBooking = await db.booking.findUnique({
      where: { id: result.newBooking.id },
      select: { participantEmail: true },
    });
    if (!newBooking) return { ok: false, reason: "not_found" };
    try {
      revalidatePath(`/manage/${bookingId}`);
      revalidatePath(`/manage/${result.newBooking.id}`);
    } catch (err) {
      console.error("Failed to revalidate manage pages after participant reschedule:", err);
    }
    return { ok: true, newBookingId: result.newBooking.id, token: signManageToken(result.newBooking.id, newBooking.participantEmail) };
  }
  return result;
}
