"use client";

import { useEffect, useState, useRef } from "react";
import { signIn, getSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff, Loader2, ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import Image from "next/image";
import { lookupTenantWithAbort } from "@/lib/login-lookup";
import type { GymBranding } from "@/lib/login-lookup";

const codeSchema = z.object({ code: z.string().min(1, "Enter your club code") });
const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
const forgotSchema = z.object({ email: z.string().email("Enter a valid email") });
const resetSchema = z
  .object({
    token: z.string().length(6, "Enter the 6-digit code"),
    password: z
      .string()
      .min(10, "At least 10 characters")
      .max(128)
      .regex(/[A-Z]/, "Must include an uppercase letter")
      .regex(/[a-z]/, "Must include a lowercase letter")
      .regex(/[0-9]/, "Must include a number"),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    message: "Passwords don't match",
    path: ["confirm"],
  });

type CodeForm = z.infer<typeof codeSchema>;
type LoginForm = z.infer<typeof loginSchema>;
type ForgotForm = z.infer<typeof forgotSchema>;
type ResetForm = z.infer<typeof resetSchema>;

// ─── Step 1: Club Code ────────────────────────────────────────────────────────

function GymCodeStep({
  onSuccess,
  onLookupError,
}: {
  onSuccess: (g: GymBranding) => void;
  onLookupError: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CodeForm>({ resolver: zodResolver(codeSchema) });

  async function lookup(raw: string) {
    const code = raw.toLowerCase().replace(/\s/g, "");
    if (!code) return;

    // Abort any in-flight request before starting a new one
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    const result = await lookupTenantWithAbort(code, controller);

    // If this request was superseded, do nothing
    if (result.aborted) return;

    setLoading(false);

    if (result.error) {
      setError(result.error);
      onLookupError();
      return;
    }

    if (result.branding) {
      onSuccess(result.branding);
    }
  }

  async function onSubmit({ code }: CodeForm) {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    await lookup(code);
  }

  // Strip non-alphanumeric, force uppercase, auto-submit after 600ms pause at ≥4 chars
  function onCodeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const clean = e.target.value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    e.target.value = clean;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    if (clean.length >= 4) {
      autoTimer.current = setTimeout(() => lookup(clean), 600);
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#111111" }}>
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {/* MatFlow logo */}
        <div className="mb-12 flex flex-col items-center">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: "#3b82f6" }}
          >
            <span className="text-white font-black text-3xl tracking-tighter leading-none">M</span>
          </div>
          <span className="text-white font-bold text-2xl tracking-tight">MatFlow</span>
          <span className="text-sm mt-1.5" style={{ color: "rgba(255,255,255,0.4)" }}>
            Martial Arts Gym Management
          </span>
        </div>

        <div className="w-full max-w-[360px]">
          <h2 className="text-white text-xl font-semibold text-center mb-2">
            Enter your club code
          </h2>
          <p className="text-sm text-center mb-8 leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>
            Your gym owner will have given you a unique code to get started
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
            <input
              {...register("code")}
              placeholder="e.g. TOTALBJJ"
              autoComplete="off"
              autoFocus
              autoCapitalize="characters"
              inputMode="text"
              onChange={onCodeChange}
              className="w-full rounded-xl px-4 py-4 text-white text-sm outline-none transition-all tracking-widest font-mono font-semibold uppercase"
              style={{
                background: "#1c1c1c",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
              onFocus={(e) => {
                e.target.style.borderColor = "#3b82f6";
                e.target.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.15)";
              }}
              onBlur={(e) => {
                e.target.style.borderColor = "rgba(255,255,255,0.1)";
                e.target.style.boxShadow = "none";
              }}
            />
            {(error || errors.code) && (
              <p className="text-red-400 text-xs pl-1">{error ?? errors.code?.message}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 active:scale-[0.99]"
              style={{ background: "#3b82f6" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#2563eb"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#3b82f6"; }}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <span>Continue</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>

      <div className="text-center pb-8 space-y-3">
        <div>
          <a
            href="/apply"
            className="inline-flex items-center gap-1.5 text-sm font-medium rounded-xl px-5 py-2.5 transition-all"
            style={{
              color: "rgba(255,255,255,0.6)",
              border: "1px solid rgba(255,255,255,0.1)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.25)";
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.85)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.1)";
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.6)";
            }}
          >
            Apply for Account Creation
          </a>
        </div>
        <p className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>
          Already applied?{" "}
          <a
            href="mailto:hello@matflow.io"
            className="transition-colors underline underline-offset-2"
            style={{ color: "rgba(255,255,255,0.5)" }}
          >
            Contact us
          </a>
        </p>
      </div>
    </div>
  );
}

// ─── Step 2: Club Login ───────────────────────────────────────────────────────

function LoginStep({
  gym,
  onBack,
  onForgot,
  initialEmail = "",
}: {
  gym: GymBranding;
  onBack: () => void;
  onForgot: (email: string) => void;
  initialEmail?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const primary = gym.primaryColor;

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: initialEmail, password: "" },
  });

  const currentEmail = watch("email");

  async function onSubmit(data: LoginForm) {
    setLoading(true);
    setError(null);
    if (gym.demo) {
      setLoading(false);
      router.push("/member/home");
      return;
    }
    const result = await signIn("credentials", {
      tenantSlug: gym.slug,
      ...data,
      redirect: false,
    });
    if (result?.error) {
      setError("Incorrect email or password.");
      setLoading(false);
    } else {
      const session = await getSession();
      setLoading(false);
      if (session?.user?.totpPending) {
        router.push("/login/totp");
      } else {
        router.push(session?.user?.role === "member" ? "/member/home" : "/dashboard");
      }
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#111111" }}>
      <div
        className="flex items-center px-6 py-5 border-b"
        style={{ borderColor: "rgba(255,255,255,0.08)" }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 transition-colors text-sm"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.8)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.4)"; }}
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <div className="w-full max-w-[360px]">
          {/* Club logo */}
          <div className="flex flex-col items-center mb-10">
            {gym.logoUrl ? (
              <Image
                src={gym.logoUrl}
                alt={gym.name}
                width={80}
                height={80}
                className="rounded-2xl object-contain mb-4"
              />
            ) : (
              <div
                className="w-20 h-20 rounded-2xl flex items-center justify-center font-black text-3xl mb-4"
                style={{
                  background: primary + "20",
                  color: primary,
                  border: `1.5px solid ${primary}35`,
                }}
              >
                {gym.name.charAt(0).toUpperCase()}
              </div>
            )}
            <h2 className="text-white text-xl font-bold tracking-tight">{gym.name}</h2>
            <p className="text-xs mt-1" style={{ color: "rgba(255,255,255,0.35)" }}>{gym.slug}</p>
          </div>

          <p className="text-sm text-center mb-6" style={{ color: "rgba(255,255,255,0.45)" }}>
            Sign in to your account
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
            <div>
              <input
                {...register("email")}
                type="email"
                placeholder="Email address"
                autoComplete="email"
                autoFocus
                className="w-full rounded-xl px-4 py-4 text-white text-sm outline-none transition-all"
                style={{
                  background: "#1c1c1c",
                  border: `1px solid ${errors.email ? "#ef4444" : "rgba(255,255,255,0.1)"}`,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = primary;
                  e.target.style.boxShadow = `0 0 0 3px ${primary}20`;
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors.email ? "#ef4444" : "rgba(255,255,255,0.1)";
                  e.target.style.boxShadow = "none";
                }}
              />
              {errors.email && (
                <p className="text-red-400 text-xs mt-1 pl-1">{errors.email.message}</p>
              )}
            </div>

            <div>
              <div className="relative">
                <input
                  {...register("password")}
                  type={showPw ? "text" : "password"}
                  placeholder="Password"
                  autoComplete="current-password"
                  className="w-full rounded-xl px-4 py-4 pr-12 text-white text-sm outline-none transition-all"
                  style={{
                    background: "#1c1c1c",
                    border: `1px solid ${errors.password ? "#ef4444" : "rgba(255,255,255,0.1)"}`,
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = primary;
                    e.target.style.boxShadow = `0 0 0 3px ${primary}20`;
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = errors.password ? "#ef4444" : "rgba(255,255,255,0.1)";
                    e.target.style.boxShadow = "none";
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: "rgba(255,255,255,0.3)" }}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.password && (
                <p className="text-red-400 text-xs mt-1 pl-1">{errors.password.message}</p>
              )}
            </div>

            {error && (
              <div
                className="rounded-xl px-4 py-3 text-xs border"
                style={{ color: "#f87171", background: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.2)" }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:opacity-90 active:scale-[0.99] mt-1"
              style={{ background: primary }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sign in"}
            </button>

            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => onForgot(currentEmail)}
                className="text-xs font-medium transition-colors hover:opacity-70"
                style={{ color: primary }}
              >
                Forgot password?
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: Forgot Password ──────────────────────────────────────────────────

function ForgotStep({
  gym,
  onBack,
  onSent,
}: {
  gym: GymBranding;
  onBack: () => void;
  onSent: (email: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primary = gym.primaryColor;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotForm>({ resolver: zodResolver(forgotSchema) });

  async function onSubmit({ email }: ForgotForm) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, tenantSlug: gym.slug }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Something went wrong.");
        setLoading(false);
        return;
      }
      onSent(email);
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#111111" }}>
      <div
        className="flex items-center px-6 py-5 border-b"
        style={{ borderColor: "rgba(255,255,255,0.08)" }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 transition-colors text-sm"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.8)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.4)"; }}
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <div className="w-full max-w-[360px]">
          {/* Club logo (small) */}
          <div className="flex justify-center mb-8">
            {gym.logoUrl ? (
              <Image
                src={gym.logoUrl}
                alt={gym.name}
                width={52}
                height={52}
                className="rounded-xl object-contain"
              />
            ) : (
              <div
                className="w-13 h-13 rounded-xl flex items-center justify-center font-bold text-xl"
                style={{ background: primary + "20", color: primary }}
              >
                {gym.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>

          <h2 className="text-white text-xl font-bold mb-2">Forgot your password?</h2>
          <p className="text-sm mb-8 leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>
            Enter your email and we&apos;ll send you a one-time code to reset it.
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
            <input
              {...register("email")}
              type="email"
              placeholder="Your email address"
              autoComplete="email"
              autoFocus
              className="w-full rounded-xl px-4 py-4 text-white text-sm outline-none transition-all"
              style={{
                background: "#1c1c1c",
                border: `1px solid ${errors.email ? "#ef4444" : "rgba(255,255,255,0.1)"}`,
              }}
              onFocus={(e) => {
                e.target.style.borderColor = primary;
                e.target.style.boxShadow = `0 0 0 3px ${primary}20`;
              }}
              onBlur={(e) => {
                e.target.style.borderColor = errors.email ? "#ef4444" : "rgba(255,255,255,0.1)";
                e.target.style.boxShadow = "none";
              }}
            />
            {errors.email && (
              <p className="text-red-400 text-xs pl-1">{errors.email.message}</p>
            )}
            {error && <p className="text-red-400 text-xs pl-1">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:opacity-90 active:scale-[0.99]"
              style={{ background: primary }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send reset code"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Step 4: Enter OTP + New Password ────────────────────────────────────────

function ResetStep({
  gym,
  email,
  onDone,
}: {
  gym: GymBranding;
  email: string;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const primary = gym.primaryColor;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetForm>({ resolver: zodResolver(resetSchema) });

  async function onSubmit({ token, password }: ResetForm) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email, tenantSlug: gym.slug, password }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Invalid or expired code. Request a new one.");
        setLoading(false);
        return;
      }
      setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: "#111111" }}>
        <div className="w-full max-w-[360px] flex flex-col items-center text-center">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mb-6"
            style={{ background: primary + "20" }}
          >
            <CheckCircle2 className="w-8 h-8" style={{ color: primary }} />
          </div>
          <h2 className="text-white text-xl font-bold mb-2">Password updated</h2>
          <p className="text-sm mb-8" style={{ color: "rgba(255,255,255,0.45)" }}>
            You can now sign in with your new password.
          </p>
          <button
            onClick={onDone}
            className="w-full py-4 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.99]"
            style={{ background: primary }}
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#111111" }}>
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <div className="w-full max-w-[360px]">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mb-8"
            style={{ background: primary + "20" }}
          >
            <span className="text-xl" style={{ color: primary }}>✉</span>
          </div>

          <h2 className="text-white text-xl font-bold mb-2">Check your email</h2>
          <p className="text-sm mb-8 leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>
            We sent a 6-digit code to{" "}
            <span className="text-white font-medium">{email}</span>. Enter it below — the code
            expires in <span className="text-white font-semibold">2 minutes</span>.
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
            {/* ── OTP section ── */}
            <div>
              <input
                {...register("token")}
                placeholder="6-digit code"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                className="w-full rounded-xl px-4 py-4 text-white text-base outline-none transition-all text-center tracking-[0.4em] font-mono font-semibold"
                style={{
                  background: "#1c1c1c",
                  border: `1px solid ${errors.token ? "#ef4444" : "rgba(255,255,255,0.1)"}`,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = primary;
                  e.target.style.boxShadow = `0 0 0 3px ${primary}20`;
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors.token ? "#ef4444" : "rgba(255,255,255,0.1)";
                  e.target.style.boxShadow = "none";
                }}
              />
              {errors.token && (
                <p className="text-red-400 text-xs mt-1 pl-1">{errors.token.message}</p>
              )}
            </div>

            {/* ── Reset Password section ── */}
            <div className="pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <p className="text-xs font-medium mb-3 uppercase tracking-wider" style={{ color: "rgba(255,255,255,0.3)" }}>
                New Password
              </p>
            </div>

            <div>
              <input
                {...register("password")}
                type="password"
                placeholder="New password (min. 10 characters)"
                className="w-full rounded-xl px-4 py-4 text-white text-sm outline-none transition-all"
                style={{
                  background: "#1c1c1c",
                  border: `1px solid ${errors.password ? "#ef4444" : "rgba(255,255,255,0.1)"}`,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = primary;
                  e.target.style.boxShadow = `0 0 0 3px ${primary}20`;
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors.password ? "#ef4444" : "rgba(255,255,255,0.1)";
                  e.target.style.boxShadow = "none";
                }}
              />
              {errors.password && (
                <p className="text-red-400 text-xs mt-1 pl-1">{errors.password.message}</p>
              )}
            </div>

            <div>
              <input
                {...register("confirm")}
                type="password"
                placeholder="Confirm new password"
                className="w-full rounded-xl px-4 py-4 text-white text-sm outline-none transition-all"
                style={{
                  background: "#1c1c1c",
                  border: `1px solid ${errors.confirm ? "#ef4444" : "rgba(255,255,255,0.1)"}`,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = primary;
                  e.target.style.boxShadow = `0 0 0 3px ${primary}20`;
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors.confirm ? "#ef4444" : "rgba(255,255,255,0.1)";
                  e.target.style.boxShadow = "none";
                }}
              />
              {errors.confirm && (
                <p className="text-red-400 text-xs mt-1 pl-1">{errors.confirm.message}</p>
              )}
            </div>

            {error && (
              <div
                className="rounded-xl px-4 py-3 text-xs border"
                style={{ color: "#f87171", background: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.2)" }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:opacity-90 active:scale-[0.99]"
              style={{ background: primary }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Set new password"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const [gym, setGym] = useState<GymBranding | null>(null);
  const [step, setStep] = useState<"login" | "forgot" | "reset">("login");
  const [resetEmail, setResetEmail] = useState("");
  const [autoSending, setAutoSending] = useState(false);
  const [initialEmail] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("email") ?? "";
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const club = params.get("club");
    if (!club || gym) return;
    fetch(`/api/tenant/${encodeURIComponent(club)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setGym(data);
      })
      .catch(() => {});
  }, [gym]);

  async function handleForgot(email: string) {
    // If email is valid, auto-send OTP and skip straight to OTP page
    if (email && z.string().email().safeParse(email).success) {
      setAutoSending(true);
      try {
        const res = await fetch("/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, tenantSlug: gym!.slug }),
        });
        if (res.ok) {
          setResetEmail(email);
          setStep("reset");
          return;
        }
      } catch { /* fall through */ }
      setAutoSending(false);
    }
    // No valid email — show the email entry page
    setStep("forgot");
  }

  if (!gym) return <GymCodeStep onSuccess={setGym} onLookupError={() => setGym(null)} />;

  if (autoSending) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: "#111111" }}>
        <Loader2 className="w-8 h-8 animate-spin mb-4" style={{ color: gym.primaryColor }} />
        <p className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>Sending reset code…</p>
      </div>
    );
  }

  if (step === "forgot")
    return (
      <ForgotStep
        gym={gym}
        onBack={() => setStep("login")}
        onSent={(e) => {
          setResetEmail(e);
          setStep("reset");
        }}
      />
    );
  if (step === "reset")
    return <ResetStep gym={gym} email={resetEmail} onDone={() => setStep("login")} />;
  return <LoginStep gym={gym} initialEmail={initialEmail} onBack={() => setGym(null)} onForgot={handleForgot} />;
}
