"use client";

import { useState } from "react";
import { Loader2, MailWarning } from "lucide-react";
import { dashboardFetch } from "@/lib/dashboardFetch";

export default function ConfirmEmailBanner({ email }: { email: string }) {
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const handleResend = async () => {
    setLoading(true);
    setNotice("");
    setError("");
    try {
      const res = await dashboardFetch("/api/clients/me/resend-verification", {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "Couldn't send the email.");
      setNotice("We've sent a new confirmation link. Check your inbox and spam folder.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the email.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-8 flex gap-3 rounded-2xl border border-customPurple-200 bg-white p-5">
      <MailWarning size={22} className="mt-0.5 shrink-0 text-customPurple-700" />
      <div>
        <h2 className="font-bold text-gray-900">Confirm your email</h2>
        <p className="mt-1 text-sm text-gray-600">
          We sent a link to {email}. Open it to see your plots and documents here, then refresh
          this page.
        </p>
        <button
          onClick={handleResend}
          disabled={loading}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-customPurple-200 bg-customPurple-50 px-3.5 py-2 text-xs font-bold text-customPurple-700 transition-colors hover:bg-customPurple-100 disabled:opacity-60"
        >
          {loading && <Loader2 size={13} className="animate-spin" />}
          Resend email
        </button>
        {notice && (
          <p role="status" className="mt-2 text-sm text-gray-600">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-500">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
