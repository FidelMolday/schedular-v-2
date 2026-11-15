"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveTemplateAction } from "@/lib/actions";
import { PLACEHOLDER_TOKENS, renderTemplate, MOCK_PREVIEW_CONTEXT } from "@/lib/template-utils";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";

const CATEGORIES = [
  { value: "admin_invitation", label: "Admin Invitation" },
  { value: "availability_request", label: "Availability Request" },
  { value: "participant_invitation", label: "Participant Invitation" },
  { value: "booking_confirmation", label: "Booking Confirmation" },
  { value: "reminder_24h", label: "24h Reminder" },
  { value: "reminder_1h", label: "1h Reminder" },
  { value: "reschedule_notice", label: "Reschedule Notice" },
  { value: "cancellation_notice", label: "Cancellation Notice" },
  { value: "waitlist_offer", label: "Waitlist Offer" },
] as const;

const AUDIENCES = [
  { value: "admin", label: "Admin" },
  { value: "participant", label: "Participant" },
  { value: "super_admin", label: "Super Admin" },
] as const;

export default function TemplateForm() {
  const router = useRouter();
  const [category, setCategory] = useState<string>(CATEGORIES[0].value);
  const [audience, setAudience] = useState<string>("participant");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  const renderedPreview = showPreview
    ? renderTemplate({ subject, bodyHtml }, MOCK_PREVIEW_CONTEXT)
    : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await saveTemplateAction({
      category: category as any,
      audience: audience as any,
      projectId: null,
      subject,
      bodyHtml,
    });
    router.push("/admin/templates");
  }

  function insertToken(token: string) {
    setBodyHtml((prev) => prev + `{{${token}}}`);
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-4xl mx-auto p-6">
        <button
          onClick={() => router.push("/admin/templates")}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ArrowLeft className="w-4 h-4" /> Back to templates
        </button>

        <h1 className="text-xl font-bold text-gray-900 mb-6 dark:text-gray-50">New email template</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Audience</label>
              <select
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              >
                {AUDIENCES.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Enter email subject line"
              className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 dark:border-gray-600"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Body (HTML)</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 dark:text-gray-500">Insert token:</span>
                <select
                  onChange={(e) => { if (e.target.value) insertToken(e.target.value); e.target.value = ""; }}
                  className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  <option value="">-- select --</option>
                  {PLACEHOLDER_TOKENS.map((t) => (
                    <option key={t} value={t}>{`{{${t}}}`}</option>
                  ))}
                </select>
              </div>
            </div>
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              placeholder="<div>Your HTML email body...</div>"
              rows={16}
              className="w-full mt-1 text-sm font-mono border border-gray-300 rounded-lg px-3 py-2 dark:border-gray-600"
            />
          </div>

          {renderedPreview && (
            <div className="border border-gray-200 rounded-lg bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <div className="px-4 py-3 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide dark:border-gray-700 dark:text-gray-400">
                Preview — Subject: {renderedPreview.subject}
              </div>
              <iframe title="Template preview" sandbox="" srcDoc={renderedPreview.bodyHtml} className="w-full min-h-[320px] overflow-auto border-0" />
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowPreview(!showPreview)}
              className="border border-gray-300 text-gray-700 hover:bg-gray-50 rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {showPreview ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {showPreview ? "Hide preview" : "Show preview"}
            </button>
            <button
              type="submit"
              disabled={!subject || !bodyHtml || saving}
              className="bg-brand-500 hover:bg-brand-600 disabled:bg-gray-300 text-white text-sm font-semibold rounded-lg px-6 py-2.5 dark:disabled:bg-gray-700"
            >
              {saving ? "Saving..." : "Save template"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
