"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveTemplateAction, sendTestAction } from "@/lib/actions";
import { PLACEHOLDER_TOKENS, renderTemplate, MOCK_PREVIEW_CONTEXT } from "@/lib/template-utils";
import { parseTemplateHtml, serializeTemplateHtml, type Block } from "@/lib/blocks";
import BlockEditor from "@/components/block-editor/BlockEditor";
import type { Prisma } from "@prisma/client";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Send,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";

const CATEGORY_LABELS: Record<string, string> = {
  admin_invitation: "Admin Invitation",
  availability_request: "Availability Request",
  participant_invitation: "Participant Invitation",
  booking_confirmation: "Booking Confirmation",
  reminder_24h: "24h Reminder",
  reminder_1h: "1h Reminder",
  reschedule_notice: "Reschedule Notice",
  cancellation_notice: "Cancellation Notice",
  waitlist_offer: "Waitlist Offer",
};

export default function TemplateEditForm({
  template,
  history,
  notificationLogs,
}: {
  template: Prisma.EmailTemplateGetPayload<{}>;
  history: Prisma.EmailTemplateGetPayload<{}>[];
  notificationLogs: Prisma.NotificationLogGetPayload<{}>[];
}) {
  const router = useRouter();
  const [subject, setSubject] = useState(template.subject);
  const [bodyHtml, setBodyHtml] = useState(template.bodyHtml);
  const initialParse = parseTemplateHtml(template.bodyHtml);
  const [mode, setMode] = useState<"simple" | "advanced">(initialParse.ok ? "simple" : "advanced");
  const [blocks, setBlocks] = useState<Block[]>(initialParse.ok ? initialParse.blocks : []);
  const [showPreview, setShowPreview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [testSent, setTestSent] = useState(false);

  const renderedPreview = showPreview
    ? renderTemplate({ subject, bodyHtml }, MOCK_PREVIEW_CONTEXT)
    : null;

  const parseResult = mode === "simple" ? parseTemplateHtml(bodyHtml) : null;

  function switchToSimple() {
    const p = parseTemplateHtml(bodyHtml);
    if (p.ok) {
      setBlocks(p.blocks);
      setMode("simple");
    } else {
      // Can't edit visually; still allow Simple view to show the notice, but
      // keep blocks untouched so nothing is overwritten.
      setMode("simple");
    }
  }

  function handleBlocksChange(next: Block[]) {
    setBlocks(next);
    setBodyHtml(serializeTemplateHtml(next));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await saveTemplateAction({
      category: template.category as any,
      audience: template.audience as any,
      projectId: template.projectId,
      subject,
      bodyHtml,
    });
    router.push("/admin/templates");
  }

  async function handleSendTest() {
    if (!testEmail) return;
    setSending(true);
    await sendTestAction(template.id, testEmail);
    setSending(false);
    setTestSent(true);
    setTimeout(() => setTestSent(false), 3000);
  }

  function insertToken(token: string) {
    setBodyHtml((prev) => prev + `{{${token}}}`);
  }

  const statusIcon: Record<string, React.ReactNode> = {
    sent: <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-300" />,
    failed: <XCircle className="w-4 h-4 text-red-500" />,
    test: <Send className="w-4 h-4 text-gray-400 dark:text-gray-500" />,
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-4xl mx-auto p-6">
        <button
          onClick={() => router.push("/admin/templates")}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ArrowLeft className="w-4 h-4" /> Back to templates
        </button>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-50">
              {CATEGORY_LABELS[template.category] ?? template.category}
            </h1>
            <p className="text-sm text-gray-500 mt-1 dark:text-gray-400">
              v{template.version} · {template.audience} ·{" "}
              {template.projectId ? "Project override" : "Global default"}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Subject</label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 dark:border-gray-600"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Body</label>
                  <div className="flex items-center gap-1 border border-gray-300 rounded-lg p-0.5 dark:border-gray-600">
                    <button
                      type="button"
                      onClick={() => switchToSimple()}
                      className={`text-xs font-medium rounded-md px-3 py-1 ${mode === "simple" ? "bg-brand-500 text-white" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"}`}
                    >
                      Simple
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("advanced")}
                      className={`text-xs font-medium rounded-md px-3 py-1 ${mode === "advanced" ? "bg-brand-500 text-white" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"}`}
                    >
                      Advanced
                    </button>
                  </div>
                </div>

                {mode === "advanced" && (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
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
                    <textarea
                      value={bodyHtml}
                      onChange={(e) => setBodyHtml(e.target.value)}
                      rows={16}
                      className="w-full mt-1 text-sm font-mono border border-gray-300 rounded-lg px-3 py-2 dark:border-gray-600"
                    />
                  </div>
                )}

                {mode === "simple" && (
                  <div>
                    {parseResult?.ok ? (
                      <div className="mt-1">
                        <div className="sticky -top-2 z-10 flex items-center justify-between mb-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 dark:bg-gray-900 dark:border-gray-700">
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            Visual editor — click a field to edit, then use “Insert token” for placeholders. Changes are stored when you save.
                          </span>
                        </div>
                        <BlockEditor blocks={blocks} onChange={handleBlocksChange} category={template.category} />
                      </div>
                    ) : (
                      <div className="mt-1 border border-amber-300 rounded-lg bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30">
                        <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">
                          This template's layout is too custom to edit visually.
                        </p>
                        <p className="text-xs text-amber-700 mt-1 dark:text-amber-300">
                          Switch to <strong>Advanced</strong> mode to edit the raw HTML. Nothing has been changed.
                        </p>
                      </div>
                    )}
                  </div>
                )}
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
                  {saving ? "Saving..." : "Save as new version"}
                </button>
              </div>
            </form>
          </div>

          <div className="space-y-6">
            {/* Send test email */}
            <div className="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2 dark:text-gray-50">
                <Send className="w-4 h-4 text-gray-400 dark:text-gray-500" /> Send test
              </h3>
              <div className="flex gap-2">
                <input
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="test@email.com"
                  className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 dark:border-gray-600"
                />
                <button
                  onClick={handleSendTest}
                  disabled={!testEmail || sending}
                  className="border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-300 rounded-lg px-3 py-2 text-sm font-medium flex items-center gap-1 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
              {testSent && (
                <p className="mt-2 text-xs text-emerald-600 flex items-center gap-1 dark:text-emerald-300">
                  <CheckCircle2 className="w-3 h-3" /> Test logged (no real email sent)
                </p>
              )}
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                This does not send a real email — it resolves the template and logs a test row.
              </p>
            </div>

            {/* Version history */}
            <div className="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center justify-between w-full text-sm font-semibold text-gray-900 dark:text-gray-50"
              >
                <span className="flex items-center gap-2"><Clock className="w-4 h-4 text-gray-400 dark:text-gray-500" /> History ({history.length})</span>
                <span className="text-gray-400 dark:text-gray-500">{showHistory ? "▲" : "▼"}</span>
              </button>
              {showHistory && (
                <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
                  {history.map((h) => (
                    <div
                      key={h.id}
                      className={`text-xs p-2 rounded ${
                        h.id === template.id ? "bg-brand-50 border border-brand-200 dark:bg-brand-700/40 dark:border-brand-700" : "bg-gray-50 dark:bg-gray-950"
                      }`}
                    >
                      <div className="font-medium text-gray-700 dark:text-gray-200">
                        v{h.version} {h.id === template.id ? "(current)" : ""}
                      </div>
                      <div className="text-gray-400 mt-0.5 truncate dark:text-gray-500">{h.subject}</div>
                      <div className="text-gray-400 dark:text-gray-500">
                        {h.isActive ? "Active" : "Inactive"} · {h.createdAt.toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent notification logs */}
            {notificationLogs.length > 0 && (
              <div className="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2 dark:text-gray-50">
                  <Send className="w-4 h-4 text-gray-400 dark:text-gray-500" /> Recent sends ({notificationLogs.length})
                </h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {notificationLogs.map((log) => (
                    <div key={log.id} className="text-xs p-2 rounded bg-gray-50 dark:bg-gray-950">
                      <div className="flex items-center gap-1.5">
                        {statusIcon[log.status] ?? null}
                        <span className="text-gray-700 dark:text-gray-200">{log.recipientEmail}</span>
                      </div>
                      <div className="text-gray-400 mt-0.5 dark:text-gray-500">{log.createdAt.toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
