"use client";

// useSearchParams() forces this page to opt out of prerender — wrap in
// Suspense so Next.js can serve the shell while the token is read client-side.
// Without this, `npm run build` fails with a prerender error.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type WaiverContent = {
  gymName: string;
  waiverTitle: string;
  waiverContent: string;
};

type PageState = "loading" | "ready" | "signing" | "done" | "error";

export default function WaiverOpenPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" style={{ background: "#f9fafb" }} />}>
      <WaiverOpenForm />
    </Suspense>
  );
}

function WaiverOpenForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [state, setState] = useState<PageState>("loading");
  const [content, setContent] = useState<WaiverContent | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [signerName, setSignerName] = useState("");

  useEffect(() => {
    if (!token) {
      setErrorMsg("No waiver link found. Please use the link from your email.");
      setState("error");
      return;
    }
    fetch(`/api/waiver/open?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setErrorMsg(data.error);
          setState("error");
        } else {
          setContent(data as WaiverContent);
          setState("ready");
        }
      })
      .catch(() => {
        setErrorMsg("Could not load waiver. Check your connection and try again.");
        setState("error");
      });
  }, [token]);

  async function handleSign(e: React.FormEvent) {
    e.preventDefault();
    if (!signerName.trim()) return;
    setState("signing");
    try {
      const res = await fetch("/api/waiver/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, signerName: signerName.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setState("done");
      } else {
        setErrorMsg(data?.error ?? "Signing failed. Please try again.");
        setState("error");
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
      setState("error");
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#f9fafb" }}>
      <div className="max-w-lg mx-auto w-full px-5 py-10 flex-1">

        {state === "loading" && (
          <div className="flex items-center justify-center h-40">
            <p className="text-gray-500">Loading waiver…</p>
          </div>
        )}

        {state === "error" && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
            <p className="text-red-700 font-medium mb-2">Something went wrong</p>
            <p className="text-red-600 text-sm">{errorMsg}</p>
          </div>
        )}

        {state === "done" && (
          <div className="text-center py-16">
            <div className="w-20 h-20 mx-auto rounded-full bg-green-100 flex items-center justify-center mb-5 text-3xl">
              ✓
            </div>
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">Waiver signed</h1>
            <p className="text-gray-500">
              Return to the kiosk — it will detect your signature in a few seconds.
            </p>
          </div>
        )}

        {(state === "ready" || state === "signing") && content && (
          <form onSubmit={handleSign} className="space-y-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1">
                {content.gymName}
              </p>
              <h1 className="text-2xl font-semibold text-gray-900">{content.waiverTitle}</h1>
            </div>

            <div
              className="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-600 leading-relaxed"
              style={{ maxHeight: "40vh", overflowY: "auto", whiteSpace: "pre-wrap" }}
            >
              {content.waiverContent}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Sign with your full name
              </label>
              <input
                type="text"
                autoComplete="name"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="Full name"
                required
                disabled={state === "signing"}
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 text-base focus:outline-none focus:border-gray-500 transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={state === "signing" || !signerName.trim()}
              className="w-full py-4 rounded-xl font-semibold text-white text-base transition-opacity disabled:opacity-50"
              style={{ background: "#111827" }}
            >
              {state === "signing" ? "Signing…" : "I accept and sign this waiver"}
            </button>

            <p className="text-xs text-gray-400 text-center">
              By signing you confirm you have read and agree to the waiver above.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
