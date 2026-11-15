"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Loader2, CheckCircle, XCircle, Video } from "lucide-react";
import { participantCancelAction, participantRescheduleAction } from "./actions";
import SlotPicker, { formatDate, formatTime } from "@/components/SlotPicker";

type Booking = {
  id: string;
  participantName: string;
  participantEmail: string;
  dateKey: string;
  time: string;
  meetingPlatform: "zoom" | "teams" | null;
  teamsJoinUrl: string | null;
  zoomJoinUrl: string | null;
  meetingFallbackReason: string | null;
};

type Project = {
  name: string;
  company: string;
  timezone: string;
  selfServiceWindowHours: number;
  durationMinutes: number;
  slug: string;
};

export default function ManageBooking({
  booking,
  manageToken,
  project,
  availability,
  inPast,
  windowOpen,
  hoursLeft,
  showRescheduleBanner,
  lockedAdminHasNoSlots,
}: {
  booking: Booking;
  manageToken: string;
  project: Project;
  availability: Record<string, string[]>;
  inPast: boolean;
  windowOpen: boolean;
  hoursLeft: number;
  showRescheduleBanner: boolean;
  lockedAdminHasNoSlots: boolean;
}) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState(false);
  const [showConfirmCancel, setShowConfirmCancel] = useState(false);
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [rescheduledNotice, setRescheduledNotice] = useState(showRescheduleBanner);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    setMessage(null);
    try {
      await participantCancelAction(booking.id, manageToken);
      setMessage({ type: "success", text: "Your booking has been cancelled." });
      router.refresh();
    } catch (err: any) {
      setMessage({ type: "error", text: err?.message ?? "Something went wrong." });
    } finally {
      setCancelling(false);
      setShowConfirmCancel(false);
    }
  }, [booking.id, manageToken, router]);

  const handleReschedule = useCallback(async () => {
    if (!selectedDateKey || !selectedTime) return;
    setRescheduling(true);
    setMessage(null);
    setRescheduledNotice(false);
    try {
      const result = await participantRescheduleAction(booking.id, selectedDateKey, selectedTime, manageToken);
      if (result.ok) {
        router.replace(`/manage/${result.newBookingId}?token=${result.token}&rescheduled=1`);
      } else {
        const reason =
          result.reason === "slot_full"
            ? "That slot is no longer available."
            : result.reason === "already_resolved"
              ? "This booking has already been rescheduled or cancelled."
              : result.reason === "Unauthorized — email verification required."
                ? "Please verify your email address to continue."
                : "No interviewer is available at that time.";
        setMessage({ type: "error", text: reason });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err?.message ?? "Something went wrong." });
    } finally {
      setRescheduling(false);
    }
  }, [booking.id, selectedDateKey, selectedTime, manageToken, router]);

  const formatHoursLeft = hoursLeft > 0
    ? `${Math.floor(hoursLeft)}h${Math.floor((hoursLeft % 1) * 60) > 0 ? ` ${Math.floor((hoursLeft % 1) * 60)}m` : ""}`
    : "past";

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-start justify-center p-4 pt-12">
      <div className="w-full max-w-2xl space-y-4">

        {rescheduledNotice && (
          <div className="flex items-center gap-2 rounded-lg p-3 text-sm bg-green-50 border border-green-200 text-green-700 dark:bg-green-900/40 dark:border-green-800 dark:text-green-300">
            <CheckCircle className="w-4 h-4 shrink-0" />
            Your booking has been rescheduled!
          </div>
        )}

        {message && (
          <div className={`flex items-center gap-2 rounded-lg p-3 text-sm ${message.type === "success" ? "bg-green-50 border border-green-200 text-green-700 dark:bg-green-900/40 dark:border-green-800 dark:text-green-300" : "bg-red-50 border border-red-200 text-red-700 dark:bg-red-900/40 dark:border-red-800 dark:text-red-300"}`}>
            {message.type === "success" ? <CheckCircle className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
            {message.text}
          </div>
        )}

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border p-6 space-y-5">
          <div className="text-xs font-semibold tracking-wide text-brand-500 uppercase">{project.company}</div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-50">Manage your booking</h1>

          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-2">
            <p className="text-sm text-gray-700 dark:text-gray-200"><span className="font-medium">Project:</span> {project.name}</p>
            <p className="text-sm text-gray-700 dark:text-gray-200"><span className="font-medium">Name:</span> {booking.participantName}</p>
            <p className="text-sm text-gray-700 dark:text-gray-200"><span className="font-medium">Email:</span> {booking.participantEmail}</p>
            <p className="text-sm text-gray-700 dark:text-gray-200">
              <span className="font-medium">Session:</span> {formatDate(booking.dateKey)} at {formatTime(booking.time)}
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-200">
              <span className="font-medium">Duration:</span> {project.durationMinutes} min
            </p>

            {booking.meetingPlatform === "zoom" && booking.zoomJoinUrl && (
              <div className="mt-2">
                <a
                  href={booking.zoomJoinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  <Video className="w-4 h-4" /> Join Zoom meeting
                </a>
              </div>
            )}
            {booking.meetingPlatform === "teams" && booking.teamsJoinUrl && (
              <div className="mt-2">
                <a
                  href={booking.teamsJoinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  <Video className="w-4 h-4" /> Join Microsoft Teams meeting
                </a>
              </div>
            )}
            {booking.meetingPlatform && !booking.teamsJoinUrl && !booking.zoomJoinUrl && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                No join link available yet{booking.meetingFallbackReason === "zoom_pool_full_no_fallback" ? " — the Zoom pool was full and this project does not fall back to Teams." : "."}
              </p>
            )}
          </div>

          {inPast ? (
            <div className="bg-yellow-50 border border-yellow-200 dark:bg-yellow-900/40 dark:border-yellow-800 dark:text-yellow-300 rounded-lg p-3 text-sm text-yellow-800">
              This session has already taken place. No changes can be made.
            </div>
          ) : !windowOpen ? (
            <div className="bg-yellow-50 border border-yellow-200 dark:bg-yellow-900/40 dark:border-yellow-800 dark:text-yellow-300 rounded-lg p-3 text-sm text-yellow-800">
              The self-service window has closed ({project.selfServiceWindowHours}h before the session).
              Please contact the administrator for changes.
            </div>
          ) : null}

          {windowOpen && !message?.type.startsWith("success") && (
            <div className="space-y-4 pt-2">
              <div className="text-sm text-gray-500 dark:text-gray-400">
                Self-service window closes in <span className="font-semibold text-gray-700 dark:text-gray-200">{formatHoursLeft}</span>.
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirmCancel(true)}
                  disabled={cancelling}
                  className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-300 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/40 disabled:opacity-50"
                >
                  Cancel booking
                </button>
              </div>

              {showConfirmCancel && (
                <div className="bg-red-50 border border-red-200 dark:bg-red-900/40 dark:border-red-800 rounded-lg p-3 space-y-2">
                  <p className="text-sm text-red-700 dark:text-red-300">Are you sure you want to cancel this booking?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCancel}
                      disabled={cancelling}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-1"
                    >
                      {cancelling && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Yes, cancel
                    </button>
                    <button
                      onClick={() => setShowConfirmCancel(false)}
                      className="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      Keep booking
                    </button>
                  </div>
                </div>
              )}

              <div className="border-t pt-4">
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-3 flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-brand-500" />
                  Reschedule to a new time
                </h2>

                {lockedAdminHasNoSlots ? (
                  <p className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                    Your interviewer currently has no available slots in the booking window.
                    Please contact an administrator to reschedule.
                  </p>
                ) : (
                  <>
                  <SlotPicker
                  availability={availability}
                  selectedDateKey={selectedDateKey}
                  selectedTime={selectedTime}
                  onSelectDate={setSelectedDateKey}
                  onSelectTime={setSelectedTime}
                  currentDateKey={booking.dateKey}
                  currentTime={booking.time}
                />

                <button
                  onClick={handleReschedule}
                  disabled={!selectedTime || rescheduling}
                  className="mt-3 px-4 py-2 text-sm font-medium text-white bg-brand-500 rounded-lg hover:bg-brand-600 disabled:opacity-50 flex items-center gap-1"
                >
                  {rescheduling && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Confirm reschedule
                </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
