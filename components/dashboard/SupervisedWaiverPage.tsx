"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import SignaturePad, { SignaturePadHandle } from "@/components/ui/SignaturePad";

interface Props {
  memberId: string;
  memberName: string;
  tenantName: string;
  waiverTitle: string;
  waiverContent: string;
  primaryColor: string;
  ownerName: string;
}

export default function SupervisedWaiverPage({
  memberId,
  memberName,
  tenantName,
  waiverTitle,
  waiverContent,
  primaryColor,
  ownerName,
}: Props) {
  const router = useRouter();
  const sigRef = useRef<SignaturePadHandle>(null);

  const [agreed, setAgreed] = useState(false);
  const [signerName, setSignerName] = useState(memberName);
  const [sigEmpty, setSigEmpty] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = agreed && signerName.trim().length > 0 && !sigEmpty && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    const dataUrl = sigRef.current?.getDataUrl() ?? "";
    if (!dataUrl) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/members/${memberId}/waiver/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signatureDataUrl: dataUrl,
          signerName: signerName.trim(),
          agreedTo: true,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? "Failed to save signature. Please try again.");
        return;
      }

      // Success — redirect back to the member profile
      router.push(`/dashboard/members/${memberId}?waiver=signed`);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-start py-10 px-4" style={{ background: "#f8f9fa" }}>
      <div className="w-full max-w-2xl">

        {/* Gym header */}
        <div className="flex flex-col items-center gap-2 mb-8 text-center">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold"
            style={{ background: primaryColor }}
          >
            {tenantName.charAt(0).toUpperCase()}
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{tenantName}</h1>
          <p className="text-sm text-gray-500">Membership waiver — please read carefully before signing</p>
        </div>

        {/* Waiver card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden mb-5">

          {/* Title */}
          <div className="px-6 py-4 border-b border-gray-100" style={{ background: `${primaryColor}10` }}>
            <h2 className="text-lg font-semibold text-gray-900">{waiverTitle}</h2>
            <p className="text-sm text-gray-500 mt-0.5">Member: {memberName}</p>
          </div>

          {/* Scrollable waiver text */}
          <div
            className="px-6 py-5 overflow-y-auto text-sm text-gray-700 leading-relaxed whitespace-pre-wrap border border-gray-200 rounded-lg mx-4 my-4"
            style={{ maxHeight: 280, background: "#fafafa" }}
          >
            {waiverContent}
          </div>

          {/* Agreement */}
          <div className="px-6 pb-5 space-y-5">
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="relative mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="sr-only"
                />
                <div
                  className="w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all"
                  style={{
                    borderColor: agreed ? primaryColor : "#d1d5db",
                    background: agreed ? primaryColor : "white",
                  }}
                >
                  {agreed && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
                </div>
              </div>
              <span className="text-sm text-gray-700 leading-snug">
                I have read and understood the full waiver above. I voluntarily agree to its terms and accept the associated risks.
              </span>
            </label>

            {/* Typed name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Full name <span className="text-gray-400 font-normal">(type your name to confirm)</span>
              </label>
              <input
                type="text"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="Your full name"
                className="w-full px-4 py-3 rounded-xl border border-gray-200 text-gray-900 text-base focus:outline-none focus:ring-2 transition-all"
                style={{ "--tw-ring-color": primaryColor } as React.CSSProperties}
                autoComplete="name"
              />
            </div>

            {/* Signature pad */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Draw your signature below
              </label>
              <SignaturePad
                ref={sigRef}
                height={200}
                strokeColor="#111827"
                background="#ffffff"
                onChange={(empty) => setSigEmpty(empty)}
              />
            </div>

            {/* Error */}
            {error && (
              <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full py-4 rounded-xl font-semibold text-white text-base transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ background: primaryColor }}
            >
              {submitting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Saving signature…
                </>
              ) : (
                <>
                  <Check className="w-5 h-5" />
                  Sign waiver
                </>
              )}
            </button>

            {!agreed && (
              <p className="text-center text-xs text-gray-400">
                Please read the waiver and tick the checkbox before signing.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-gray-400 pb-6">
          Powered by MatFlow &mdash; supervised by {ownerName}
        </p>
      </div>
    </div>
  );
}
