"use client";

import { useState } from "react";
import { Clock, Check, CalendarDays, Loader2 } from "lucide-react";
import { claimWaitlistOfferAction } from "@/lib/actions";

export default function ClaimOffer({
  entry,
  claimToken,
}: {
  claimToken: string;
  entry: {
    id: string;
    name: string;
    email: string;
    dateKey: string | null;
    time: string | null;
    status: string;
    expiresAt: Date | null;
    project: { name: string; company: string; durationMinutes: number };
  };
}) {
  const [state, setState] = useState<"idle" | "claiming" | "claimed" | "expired" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const isExpired =
    entry.status !== "offered" ||
    (entry.expiresAt && new Date(entry.expiresAt) < new Date());

  if (isExpired && state === "idle") {
    return (
      <div className="min-h-screen w-full bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center">
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-50 mb-2">Offer expired</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">This waitlist offer is no longer valid.</p>
        </div>
      </div>
    );
  }

  const handleClaim = async () => {
    setState("claiming");
    const result = await claimWaitlistOfferAction(entry.id, claimToken);
    if (result.ok) {
      setState("claimed");
    } else {
      setState("expired");
      setErrorMsg(result.reason === "offer_expired" ? "This offer has expired." : "This slot was just taken.");
    }
  };

  if (state === "claimed") {
    return (
      <div className="min-h-screen w-full bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center mx-auto mb-4">
            <Check className="w-7 h-7 text-emerald-600 dark:text-emerald-300" />
          </div>
          <h3 className="text-xl font-bold text-gray-900 dark:text-gray-50 mb-1">You're booked!</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">Your slot has been confirmed. Check your email for details.</p>
        </div>
      </div>
    );
  }

  if (state === "expired") {
    return (
      <div className="min-h-screen w-full bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center">
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-50 mb-2">Slot unavailable</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">{errorMsg}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8">
        <div className="text-center mb-6">
          <div className="text-xs font-semibold tracking-wide text-brand-500 uppercase mb-1">{entry.project.company}</div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-50">{entry.project.name}</h2>
        </div>

        <div className="rounded-xl border-2 border-dashed border-brand-100 bg-brand-50/50 p-5 mb-6 dark:border-brand-700 dark:bg-brand-700/20">
          <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 mb-2">
            <CalendarDays className="w-4 h-4 text-gray-400 dark:text-gray-500" />
            {entry.dateKey ?? "Date TBD"}
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 mb-2">
            <Clock className="w-4 h-4 text-gray-400 dark:text-gray-500" />
            {entry.time ?? "Time TBD"} · {entry.project.durationMinutes} min
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-3">
            Offer for <strong>{entry.name}</strong> ({entry.email})
          </p>
        </div>

        <button
          onClick={handleClaim}
          disabled={state === "claiming"}
          className="w-full bg-brand-500 hover:bg-brand-600 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white text-sm font-semibold rounded-lg py-2.5 flex items-center justify-center gap-2"
        >
          {state === "claiming" ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Claiming...</>
          ) : (
            "Claim this slot"
          )}
        </button>
      </div>
    </div>
  );
}
