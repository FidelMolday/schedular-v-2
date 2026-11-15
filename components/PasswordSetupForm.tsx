"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lock, CheckCircle, AlertCircle } from "lucide-react";

export type TokenState =
  | { status: "loading" }
  | { status: "valid"; name: string; email: string }
  | { status: "used" }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "error"; message: string };

type SetupType = "setup" | "reset";

export function PasswordSetupForm({ token, type }: { token: string; type: SetupType }) {
  const [tokenState, setTokenState] = useState<TokenState>({ status: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const isSetup = type === "setup";

  useEffect(() => {
    if (!token) {
      setTokenState({ status: "invalid" });
      return;
    }
    fetch(`/api/auth/setup-password?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.valid) {
          setTokenState({ status: "valid", name: data.name, email: data.email });
        } else if (data.reason === "used") {
          setTokenState({ status: "used" });
        } else if (data.reason === "expired") {
          setTokenState({ status: "expired" });
        } else {
          setTokenState({ status: "invalid" });
        }
      })
      .catch(() => setTokenState({ status: "error", message: "Failed to validate link." }));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/setup-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Failed to set password.");
        return;
      }
      setDone(true);
    } catch {
      setError("Failed to set password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (tokenState.status === "loading") {
    return <p className="text-sm text-gray-500 dark:text-gray-400 text-center">Validating your link...</p>;
  }

  if (tokenState.status === "valid" && !done) {
    return (
      <>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50 text-center mb-1">
          {isSetup ? "Set your password" : "Reset your password"}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-8">
          {isSetup
            ? `Hi ${tokenState.name} — choose a password for your account.`
            : `Hi ${tokenState.name} — choose a new password for your account.`}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              New password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 12 characters"
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>
          <div>
            <label htmlFor="confirm" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              required
              minLength={12}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter your password"
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-300">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg py-2.5 flex items-center justify-center gap-2 transition-colors"
          >
            <Lock className="w-4 h-4" />
            {submitting ? (isSetup ? "Setting password..." : "Resetting password...") : (isSetup ? "Set password" : "Reset password")}
          </button>
        </form>
      </>
    );
  }

  if (done) {
    return (
      <div className="text-center">
        <div className="rounded-lg bg-green-50 dark:bg-green-900/40 border border-green-200 dark:border-green-800 p-4 mb-6 flex items-start gap-3">
          <CheckCircle className="w-5 h-5 text-green-500 dark:text-green-300 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-green-800 dark:text-green-300">
              {isSetup ? "Password set successfully" : "Password reset successfully"}
            </p>
            <p className="text-sm text-green-700 dark:text-green-300 mt-1">
              You can now sign in with your email and new password.
            </p>
          </div>
        </div>
        <Link
          href="/auth/signin"
          className="inline-block bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-lg py-2.5 px-6"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (tokenState.status === "invalid" || tokenState.status === "used" || tokenState.status === "expired") {
    return (
      <div className="text-center">
        <div className="rounded-lg bg-red-50 dark:bg-red-900/40 border border-red-200 dark:border-red-800 p-4 mb-6 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 dark:text-red-300 mt-0.5 shrink-0" />
          <div className="text-left">
            <p className="text-sm font-semibold text-red-800 dark:text-red-300">
              {tokenState.status === "used" && (isSetup ? "This setup link has already been used" : "This reset link has already been used")}
              {tokenState.status === "expired" && (isSetup ? "This setup link has expired" : "This reset link has expired")}
              {tokenState.status === "invalid" && (isSetup ? "Invalid setup link" : "Invalid reset link")}
            </p>
            <p className="text-sm text-red-700 dark:text-red-300 mt-1">
              {tokenState.status === "used" && (isSetup
                ? "This link can only be used once. Contact your organisation owner to send a new invitation."
                : "This link can only be used once. Request a new password reset link.")}
              {tokenState.status === "expired" && (isSetup
                ? "The link you clicked is no longer valid (it expires 48 hours after being sent). Ask your organisation owner to send a new invitation."
                : "The reset link you clicked is no longer valid (it expires 48 hours). Request a new password reset link.")}
              {tokenState.status === "invalid" && (isSetup
                ? "The link you clicked is not a valid setup link. Check that you copied the entire URL from your invitation email."
                : "The link you clicked is not a valid reset link. Check that you copied the entire URL from your email.")}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-center gap-4">
          {!isSetup && tokenState.status !== "invalid" && (
            <Link
              href="/auth/forgot-password"
              className="text-sm text-brand-600 hover:text-brand-700 font-medium"
            >
              Request new reset link
            </Link>
          )}
          <Link
            href="/auth/signin"
            className="text-sm text-brand-600 hover:text-brand-700 font-medium"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (tokenState.status === "error") {
    return <p className="text-sm text-red-600 dark:text-red-300 text-center">{tokenState.message}</p>;
  }

  return null;
}
