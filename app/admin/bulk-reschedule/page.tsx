"use client";

import { useState, useCallback, useEffect } from "react";


type Mode = "admin-unavailable" | "date-shift";

type AdminUnavailableItem = {
  bookingId: string;
  dateKey: string;
  time: string;
  participantName: string;
  resolution: "reassign_admin" | "needs_manual_attention";
  newAdminId?: string;
  newAdminName?: string;
};

type DateShiftItem = {
  bookingId: string;
  oldDateKey: string;
  time: string;
  newDateKey: string;
  participantName: string;
  resolution: "same_admin_available" | "reassign_needed" | "slot_full_at_target" | "no_admin_available_at_target";
  resultingAdminId?: string;
  resultingAdminName?: string;
};

type CommitResult = { succeeded: number; failed: { bookingId: string; reason: string }[] };

const RESOLUTION_BADGE: Record<string, string> = {
  reassign_admin: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  same_admin_available: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  reassign_needed: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  needs_manual_attention: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  slot_full_at_target: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  no_admin_available_at_target: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const RESOLUTION_LABEL: Record<string, string> = {
  reassign_admin: "Reassign admin",
  same_admin_available: "Same admin available",
  reassign_needed: "Reassign needed",
  needs_manual_attention: "Needs manual attention",
  slot_full_at_target: "Slot full at target",
  no_admin_available_at_target: "No admin at target",
};

export default function BulkReschedulePage() {
  const [mode, setMode] = useState<Mode>("admin-unavailable");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [admins, setAdmins] = useState<{ id: string; name: string }[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Mode A
  const [aAdminId, setAAdminId] = useState("");
  const [aFrom, setAFrom] = useState("");
  const [aTo, setATo] = useState("");

  // Mode B
  const [bProjectId, setBProjectId] = useState("");
  const [bFrom, setBFrom] = useState("");
  const [bTo, setBTo] = useState("");
  const [bOffset, setBOffset] = useState("1");

  // Results
  const [preview, setPreview] = useState<AdminUnavailableItem[] | DateShiftItem[] | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const ensureLoaded = useCallback(async () => {
    if (loaded) return;
    setLoaded(true);
    const [pRes, aRes] = await Promise.all([
      fetch("/api/projects").then((r) => r.json()).catch(() => []),
      fetch("/api/admins").then((r) => r.json()).catch(() => []),
    ]);
    setProjects(pRes);
    setAdmins(aRes);
  }, [loaded]);

  useEffect(() => { ensureLoaded(); }, []);

  const runPreview = useCallback(async () => {
    setCommitResult(null);
    setRequestError(null);
    setLoading(true);
    try {
      if (mode === "admin-unavailable" && aAdminId && aFrom && aTo) {
        const res = await fetch("/api/reschedule/preview-admin-unavailable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adminId: aAdminId, fromDate: aFrom, toDate: aTo }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setPreview(null);
          setRequestError(typeof data?.error === "string" ? data.error : "Unable to preview changes.");
          return;
        }
        if (!Array.isArray(data)) {
          setPreview(null);
          setRequestError("Unable to preview changes.");
          return;
        }
        setPreview(data);
      } else if (mode === "date-shift" && bProjectId && bFrom && bTo && bOffset) {
        const res = await fetch("/api/reschedule/preview-date-shift", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: bProjectId, fromDate: bFrom, toDate: bTo, offsetDays: parseInt(bOffset) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setPreview(null);
          setRequestError(typeof data?.error === "string" ? data.error : "Unable to preview changes.");
          return;
        }
        if (!Array.isArray(data)) {
          setPreview(null);
          setRequestError("Unable to preview changes.");
          return;
        }
        setPreview(data);
      }
    } catch {
      setPreview(null);
      setRequestError("Unable to preview changes.");
    } finally {
      setLoading(false);
    }
  }, [mode, aAdminId, aFrom, aTo, bProjectId, bFrom, bTo, bOffset]);

  const runCommit = useCallback(async () => {
    setRequestError(null);
    setCommitResult(null);
    setCommitting(true);
    try {
      if (mode === "admin-unavailable" && aAdminId && aFrom && aTo) {
        const res = await fetch("/api/reschedule/commit-admin-unavailable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adminId: aAdminId, fromDate: aFrom, toDate: aTo }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setRequestError(typeof data?.error === "string" ? data.error : "Unable to apply changes.");
          return;
        }
        if (!data || typeof data.succeeded !== "number" || !Array.isArray(data.failed)) {
          setRequestError("Unable to apply changes.");
          return;
        }
        setCommitResult(data);
      } else if (mode === "date-shift" && bProjectId && bFrom && bTo && bOffset) {
        const res = await fetch("/api/reschedule/commit-date-shift", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: bProjectId, fromDate: bFrom, toDate: bTo, offsetDays: parseInt(bOffset) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setRequestError(typeof data?.error === "string" ? data.error : "Unable to apply changes.");
          return;
        }
        if (!data || typeof data.succeeded !== "number" || !Array.isArray(data.failed)) {
          setRequestError("Unable to apply changes.");
          return;
        }
        setCommitResult(data);
      }
    } catch {
      setRequestError("Unable to apply changes.");
    } finally {
      setCommitting(false);
    }
  }, [mode, aAdminId, aFrom, aTo, bProjectId, bFrom, bTo, bOffset]);

  const isPreview = mode === "admin-unavailable"
    ? !!(aAdminId && aFrom && aTo)
    : !!(bProjectId && bFrom && bTo && bOffset);

  const previewItems = preview as any[] ?? [];

  const autoCount = previewItems.filter((i: any) =>
    i.resolution !== "needs_manual_attention" &&
    i.resolution !== "slot_full_at_target" &&
    i.resolution !== "no_admin_available_at_target"
  ).length;
  const manualCount = previewItems.length - autoCount;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-50">Bulk Reschedule</h1>
          <p className="text-sm text-gray-500 mt-1 dark:text-gray-400">Reschedule multiple bookings at once.</p>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => { setMode("admin-unavailable"); setPreview(null); setCommitResult(null); }}
            className={`text-sm font-semibold rounded-lg px-4 py-2 ${mode === "admin-unavailable" ? "bg-brand-500 text-white" : "bg-white border border-gray-300 text-gray-700 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200"}`}
          >
            Admin Unavailable
          </button>
          <button
            onClick={() => { setMode("date-shift"); setPreview(null); setCommitResult(null); }}
            className={`text-sm font-semibold rounded-lg px-4 py-2 ${mode === "date-shift" ? "bg-brand-500 text-white" : "bg-white border border-gray-300 text-gray-700 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200"}`}
          >
            Shift Date Range
          </button>
        </div>

        {requestError && (
          <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6 text-sm dark:bg-red-900/20 dark:border-red-900 dark:text-red-300">
            {requestError}
          </div>
        )}

        {/* Mode A form */}
        {mode === "admin-unavailable" && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 flex flex-wrap gap-3 items-end shadow-sm dark:bg-gray-900 dark:border-gray-700">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">Admin</label>
              <select value={aAdminId} onChange={(e) => setAAdminId(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm min-w-[200px] dark:border-gray-600">
                <option value="">Select admin...</option>
                {admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">From date</label>
              <input type="date" value={aFrom} onChange={(e) => setAFrom(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm dark:border-gray-600" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">To date</label>
              <input type="date" value={aTo} onChange={(e) => setATo(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm dark:border-gray-600" />
            </div>
            <button disabled={!isPreview || loading} onClick={runPreview} className="bg-brand-500 hover:bg-brand-600 disabled:bg-gray-300 text-white text-xs font-semibold rounded-lg px-4 py-1.5 dark:disabled:bg-gray-700">
              {loading ? "Loading..." : "Preview changes"}
            </button>
          </div>
        )}

        {/* Mode B form */}
        {mode === "date-shift" && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 flex flex-wrap gap-3 items-end shadow-sm dark:bg-gray-900 dark:border-gray-700">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">Project</label>
              <select value={bProjectId} onChange={(e) => setBProjectId(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm min-w-[200px] dark:border-gray-600">
                <option value="">Select project...</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">From date</label>
              <input type="date" value={bFrom} onChange={(e) => setBFrom(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm dark:border-gray-600" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">To date</label>
              <input type="date" value={bTo} onChange={(e) => setBTo(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm dark:border-gray-600" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">Day offset</label>
              <input type="number" value={bOffset} onChange={(e) => setBOffset(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-20 dark:border-gray-600" />
            </div>
            <button disabled={!isPreview || loading} onClick={runPreview} className="bg-brand-500 hover:bg-brand-600 disabled:bg-gray-300 text-white text-xs font-semibold rounded-lg px-4 py-1.5 dark:disabled:bg-gray-700">
              {loading ? "Loading..." : "Preview changes"}
            </button>
          </div>
        )}

        {/* Preview results */}
        {preview && (
          <div className="mb-6">
            <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 shadow-sm dark:bg-gray-900 dark:border-gray-700">
              <p className="text-sm font-medium mb-1">
                {autoCount} of {previewItems.length} bookings can be automatically resolved;
                {" "}<span className="text-red-600 font-semibold dark:text-red-300">{manualCount} need manual attention</span>.
              </p>
            </div>

            <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-950">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">Date</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">Time</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">Participant</th>
                    {mode === "date-shift" && <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">New Date</th>}
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">Resolution</th>
                    {mode === "admin-unavailable" && <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">New Admin</th>}
                    {mode === "date-shift" && <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">New Admin</th>}
                  </tr>
                </thead>
                <tbody>
                  {previewItems.map((item: any) => (
                    <tr key={item.bookingId} className="border-b border-gray-200 last:border-b-0 dark:border-gray-700">
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{item.dateKey ?? item.oldDateKey}</td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{item.time}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-200">{item.participantName}</td>
                      {mode === "date-shift" && <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{item.newDateKey}</td>}
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${RESOLUTION_BADGE[item.resolution] ?? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200"}`}>
                          {RESOLUTION_LABEL[item.resolution] ?? item.resolution}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-200">{item.newAdminName ?? item.resultingAdminName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              disabled={committing || manualCount === previewItems.length}
              onClick={runCommit}
              className="mt-4 bg-gray-800 hover:bg-gray-900 disabled:bg-gray-300 text-white text-sm font-semibold rounded-lg px-5 py-2 dark:disabled:bg-gray-700"
            >
              {committing ? "Applying..." : "Confirm and apply"}
            </button>
          </div>
        )}

        {/* Commit results */}
        {commitResult && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm dark:bg-gray-900 dark:border-gray-700">
            <h3 className="text-base font-semibold mb-2">Results</h3>
            <p className="text-sm mb-3">
              <span className="text-green-600 font-semibold dark:text-green-300">{commitResult.succeeded} succeeded</span>
              {commitResult.failed.length > 0 && (
                <>, <span className="text-red-600 font-semibold dark:text-red-300">{commitResult.failed.length} failed</span></>
              )}
            </p>
            {commitResult.failed.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">Booking ID</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {commitResult.failed.map((f) => (
                    <tr key={f.bookingId} className="border-b border-gray-200 last:border-b-0 dark:border-gray-700">
                      <td className="px-3 py-2 text-gray-500 text-xs font-mono dark:text-gray-400">{f.bookingId}</td>
                      <td className="px-3 py-2 text-red-600 text-xs dark:text-red-300">{f.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
  );
}
