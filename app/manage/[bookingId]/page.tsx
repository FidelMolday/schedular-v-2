import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getConsolidatedAvailability } from "@/lib/data/availability";
import { hoursUntilSession, isSessionInPast } from "@/lib/slotHelpers";
import { verifyManageToken } from "@/lib/manage-token";
import ManageBooking from "./ManageBooking";
import ManageBookingLocked from "./ManageBookingLocked";
import ManageBookingResolved from "./ManageBookingResolved";

export const dynamic = "force-dynamic";

export default async function ManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ token?: string; rescheduled?: string }>;
}) {
  const { bookingId } = await params;
  const { token, rescheduled } = await searchParams;

  const verified = token ? verifyManageToken(token) : null;
  if (!verified || verified.bookingId !== bookingId) {
    return <ManageBookingLocked bookingId={bookingId} />;
  }

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      participantName: true,
      participantEmail: true,
      dateKey: true,
      time: true,
      adminId: true,
      meetingPlatform: true,
      teamsJoinUrl: true,
      zoomJoinUrl: true,
      meetingFallbackReason: true,
      status: true,
      project: {
        select: {
          id: true, name: true, company: true, timezone: true,
          selfServiceWindowHours: true, durationMinutes: true, slug: true,
          lockRescheduleToOriginalAdmin: true,
        },
      },
    },
  });

  if (!booking) return notFound();

  // Defense-in-depth: the token is bound to this bookingId and to a specific email.
  // Participant tokens must match the booking's participantEmail.
  // Admin tokens must match an active admin assigned to this booking's project.
  if (verified.scope === "a") {
    const isAdmin = await db.projectAdmin.findFirst({
      where: {
        projectId: booking.project.id,
        admin: { email: verified.email, isActive: true },
      },
    });
    if (!isAdmin) return notFound();
  } else {
    if (booking.participantEmail.toLowerCase().trim() !== verified.email) return notFound();
  }

  // A reschedule or cancel moves the booking out of "confirmed": the old
  // manage link must show a clear, accurate message — never a bare 404.
  if (booking.status !== "confirmed") {
    return <ManageBookingResolved status={booking.status} />;
  }

  const { project } = booking;
  const inPast = isSessionInPast(booking.dateKey, booking.time, project.timezone);
  const hoursLeft = hoursUntilSession(booking.dateKey, booking.time, project.timezone);
  const windowOpen = !inPast && hoursLeft >= project.selfServiceWindowHours;

  // When lockRescheduleToOriginalAdmin is ON, filter availability to only the
  // originally-assigned admin's slots.
  const lockToAdminId = project.lockRescheduleToOriginalAdmin ? booking.adminId : undefined;
  const availability = await getConsolidatedAvailability(project.id, { lockToAdminId });

  return (
    <ManageBooking
      booking={{
        id: booking.id,
        participantName: booking.participantName,
        participantEmail: booking.participantEmail,
        dateKey: booking.dateKey,
        time: booking.time,
        meetingPlatform: booking.meetingPlatform,
        teamsJoinUrl: booking.teamsJoinUrl,
        zoomJoinUrl: booking.zoomJoinUrl,
        meetingFallbackReason: booking.meetingFallbackReason,
      }}
      manageToken={token!}
      project={{
        name: project.name,
        company: project.company,
        timezone: project.timezone,
        selfServiceWindowHours: project.selfServiceWindowHours,
        durationMinutes: project.durationMinutes,
        slug: project.slug,
      }}
      availability={availability}
      inPast={inPast}
      windowOpen={windowOpen}
      hoursLeft={hoursLeft}
      showRescheduleBanner={rescheduled === "1"}
      lockedAdminHasNoSlots={project.lockRescheduleToOriginalAdmin && Object.keys(availability).length === 0}
    />
  );
}
