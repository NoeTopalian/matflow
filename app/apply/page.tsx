"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Loader2, CheckCircle2, ChevronDown } from "lucide-react";
import Link from "next/link";

const SPORTS = [
  "Brazilian Jiu-Jitsu (BJJ)",
  "Mixed Martial Arts (MMA)",
  "Muay Thai / Kickboxing",
  "Wrestling",
  "Judo",
  "Boxing",
  "No-Gi Grappling",
  "Multiple disciplines",
  "Other",
];

const schema = z.object({
  gymName: z.string().min(2, "Enter your gym name"),
  ownerName: z.string().min(2, "Enter your name"),
  email: z.string().email("Enter a valid email"),
  phone: z.string().min(7, "Enter a valid phone number"),
  sport: z.string().min(1, "Select a discipline"),
  memberCount: z.string().min(1, "Select your member count"),
  message: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

export default function ApplyPage() {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  async function onSubmit(data: FormData) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed");
      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please email us at hello@matflow.io");
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-xl px-4 py-3.5 text-gray-900 text-sm outline-none transition-all placeholder-gray-300 border border-gray-200 bg-white focus:border-gray-900 focus:ring-4 focus:ring-gray-900/5";
  const labelClass = "block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5";
  const errorClass = "text-red-500 text-xs mt-1 pl-1";

  if (submitted) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-[420px] text-center">
          <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-8 h-8 text-green-500" />
          </div>
          <h2 className="text-gray-900 text-2xl font-bold mb-3">Application received</h2>
          <p className="text-gray-400 text-sm leading-relaxed mb-8">
            Thanks for applying. We review every application and will be in touch within 1 business
            day with your gym code and login details.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
        <Link
          href="/login"
          className="flex items-center gap-1.5 text-gray-400 hover:text-gray-700 transition-colors text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-black flex items-center justify-center">
            <span className="text-white font-black text-xs">M</span>
          </div>
          <span className="text-gray-900 font-semibold text-sm">MatFlow</span>
        </div>
      </div>

      <div className="max-w-[520px] mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-gray-900 text-2xl font-bold tracking-tight mb-2">
            Get your gym on MatFlow
          </h1>
          <p className="text-gray-400 text-sm leading-relaxed">
            Fill in the form below and we&apos;ll set up your account and send you your gym code
            within 1 business day.
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          {/* Gym name */}
          <div>
            <label className={labelClass}>Gym name</label>
            <input {...register("gymName")} placeholder="e.g. Total BJJ Nottingham" className={inputClass} />
            {errors.gymName && <p className={errorClass}>{errors.gymName.message}</p>}
          </div>

          {/* Owner name */}
          <div>
            <label className={labelClass}>Your name</label>
            <input {...register("ownerName")} placeholder="First and last name" className={inputClass} />
            {errors.ownerName && <p className={errorClass}>{errors.ownerName.message}</p>}
          </div>

          {/* Email + Phone */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Email</label>
              <input {...register("email")} type="email" placeholder="you@yourgym.com" className={inputClass} />
              {errors.email && <p className={errorClass}>{errors.email.message}</p>}
            </div>
            <div>
              <label className={labelClass}>Phone</label>
              <input {...register("phone")} type="tel" placeholder="+44 7700 900000" className={inputClass} />
              {errors.phone && <p className={errorClass}>{errors.phone.message}</p>}
            </div>
          </div>

          {/* Sport */}
          <div>
            <label className={labelClass}>Primary discipline</label>
            <div className="relative">
              <select
                {...register("sport")}
                className={`${inputClass} appearance-none pr-10 cursor-pointer`}
                defaultValue=""
              >
                <option value="" disabled>Select discipline...</option>
                {SPORTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
            {errors.sport && <p className={errorClass}>{errors.sport.message}</p>}
          </div>

          {/* Member count */}
          <div>
            <label className={labelClass}>Approximate member count</label>
            <div className="relative">
              <select
                {...register("memberCount")}
                className={`${inputClass} appearance-none pr-10 cursor-pointer`}
                defaultValue=""
              >
                <option value="" disabled>Select range...</option>
                <option>Under 20</option>
                <option>20–50</option>
                <option>50–100</option>
                <option>100–200</option>
                <option>200+</option>
              </select>
              <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
            {errors.memberCount && <p className={errorClass}>{errors.memberCount.message}</p>}
          </div>

          {/* Message */}
          <div>
            <label className={labelClass}>Anything else? <span className="normal-case font-normal text-gray-400">(optional)</span></label>
            <textarea
              {...register("message")}
              rows={3}
              placeholder="Tell us anything useful — current software, specific needs, questions..."
              className={`${inputClass} resize-none`}
            />
          </div>

          {error && (
            <div className="rounded-xl px-4 py-3 text-xs text-red-600 bg-red-50 border border-red-100">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 hover:bg-gray-800 active:scale-[0.99]"
            style={{ background: "#0a0a0a", color: "white" }}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit application"}
          </button>
        </form>

        <p className="text-center text-gray-400 text-xs mt-8">
          By applying you agree to our{" "}
          <Link href="/legal/terms" className="text-gray-600 hover:text-gray-900 underline underline-offset-2">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/legal/privacy" className="text-gray-600 hover:text-gray-900 underline underline-offset-2">
            Privacy Policy
          </Link>
        </p>
      </div>
    </div>
  );
}
