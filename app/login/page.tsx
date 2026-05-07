"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { signIn, getSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff, Loader2, ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { lookupTenantWithAbort } from "@/lib/login-lookup";
import type { GymBranding } from "@/lib/login-lookup";

const codeSchema = z.object({ code: z.string().min(1, "Enter your club code") });
const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
const magicLinkSchema = z.object({
  email: z.string().email("Enter a valid email"),
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
type MagicLinkForm = z.infer<typeof magicLinkSchema>;
type ForgotForm = z.infer<typeof forgotSchema>;
type ResetForm = z.infer<typeof resetSchema>;

const FONT_IMPORTS: Record<string, string> = {
  Inter: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  Montserrat: "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap",
  Oswald: "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap",
  "Plus Jakarta Sans": "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
  Barlow: "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap",
  "Space Grotesk": "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
  "DM Sans": "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap",
  Teko: "https://fonts.googleapis.com/css2?family=Teko:wght@400;500;600;700&display=swap",
  Poppins: "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap",
  Outfit: "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap",
  Raleway: "https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700;800&display=swap",
  Saira: "https://fonts.googleapis.com/css2?family=Saira:wght@400;500;600;700&display=swap",
};

function extractFontName(fontFamily: string) {
  const match = fontFamily.match(/['"]?([^'",]+)['"]?/);
  return match ? match[1].trim() : "Inter";
}

function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s);
}

function isSafeFontFamily(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9 ,'"_-]+$/.test(s) && s.length < 100;
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function mergeLocalBranding(branding: GymBranding) {
  if (typeof window === "undefined") return branding;
  try {
    const raw = localStorage.getItem("gym-settings");
    if (!raw) return branding;
    const local = JSON.parse(raw) as {
      slug?: unknown;
      logoUrl?: unknown;
      primaryColor?: unknown;
      secondaryColor?: unknown;
      textColor?: unknown;
      bgColor?: unknown;
      fontFamily?: unknown;
    };
    if (typeof local.slug !== "string" || local.slug.toLowerCase() !== branding.slug.toLowerCase()) {
      return branding;
    }

    return {
      ...branding,
      logoUrl: typeof local.logoUrl === "string" && local.logoUrl.length > 0 ? local.logoUrl : branding.logoUrl,
      primaryColor: isHexColor(local.primaryColor) ? local.primaryColor : branding.primaryColor,
      secondaryColor: isHexColor(local.secondaryColor) ? local.secondaryColor : branding.secondaryColor,
      textColor: isHexColor(local.textColor) ? local.textColor : branding.textColor,
      bgColor: isHexColor(local.bgColor) ? local.bgColor : branding.bgColor,
      fontFamily: isSafeFontFamily(local.fontFamily) ? local.fontFamily : branding.fontFamily,
    };
  } catch {
    return branding;
  }
}

function getLoginTheme(gym?: GymBranding | null) {
  const primary = isHexColor(gym?.primaryColor) ? gym!.primaryColor : "#3b82f6";
  const appBg = isHexColor(gym?.bgColor) ? gym!.bgColor! : "#111111";
  const appFont = isSafeFontFamily(gym?.fontFamily) ? gym!.fontFamily! : "'Inter', sans-serif";

  const bgInt = parseInt((appBg.replace("#", "") + "000000").slice(0, 6), 16);
  const bgR = (bgInt >> 16) & 255;
  const bgG = (bgInt >> 8) & 255;
  const bgB = bgInt & 255;
  const bgLuma = (bgR * 299 + bgG * 587 + bgB * 114) / 1000;
  const isLight = bgLuma > 160;

  return {
    primary,
    appBg,
    appFont,
    isLight,
    textMain: isLight ? "#0f172a" : "#ffffff",
    textMuted: isLight ? "#64748b" : "rgba(255,255,255,0.45)",
    textSoft: isLight ? "rgba(15,23,42,0.6)" : "rgba(255,255,255,0.35)",
    surface: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)",
    surfaceStrong: isLight ? "#f8fafc" : "#0e1013",
    border: isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)",
    borderSoft: isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)",
    dangerBorder: "rgba(239,68,68,0.2)",
    dangerText: "#f87171",
    dangerBg: "rgba(239,68,68,0.08)",
  };
}

function LogoMark({ gym, size = 120 }: { gym: GymBranding; size?: number }) {
  const theme = getLoginTheme(gym);

  if (gym.logoUrl) {
    // Render image logos frameless — the gym's logo design carries its own
    // visual weight; the surrounding card/page surface is enough container.
    return (
      <div className="flex items-center justify-center" style={{ height: size }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={gym.logoUrl}
          alt={gym.name}
          className="object-contain"
          style={{
            width: "auto",
            height: size,
            maxWidth: Math.min(size * 3.5, 280),
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl flex items-center justify-center font-black"
      style={{
        width: size,
        height: size,
        background: hex(theme.primary, theme.isLight ? 0.12 : 0.16),
        color: theme.primary,
        border: `1.5px solid ${hex(theme.primary, theme.isLight ? 0.28 : 0.22)}`,
        fontSize: size * 0.42,
      }}
    >
      {gym.name.charAt(0).toUpperCase()}
    </div>
  );
}

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

  const lookup = useCallback(async (raw: string) => {
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
      onSuccess(mergeLocalBranding(result.branding));
    }
  }, [onLookupError, onSuccess]);

  const onSubmit = useCallback(async ({ code }: CodeForm) => {
    await lookup(code);
  }, [lookup]);

  // Strip non-alphanumeric, force uppercase, auto-submit after 600ms pause at ≥4 chars
  const onCodeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const clean = e.target.value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    e.target.value = clean;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    if (clean.length >= 4) {
      autoTimer.current = setTimeout(() => lookup(clean), 600);
    }
  }, [lookup]);

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

          {/* eslint-disable-next-line react-hooks/refs */}
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
  const [magicMode, setMagicMode] = useState(false);
  const [magicSent, setMagicSent] = useState<string | null>(null);
  // Resend cooldown after sending a magic link. Server enforces 3-per-15-min
  // anyway, but a visible countdown prevents users from refreshing the page
  // and re-typing their email when the email is just delayed.
  const [resendCountdown, setResendCountdown] = useState(0);
  const [resending, setResending] = useState(false);
  const theme = getLoginTheme(gym);

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

  const {
    register: registerMagic,
    handleSubmit: handleSubmitMagic,
    formState: { errors: magicErrors },
    reset: resetMagic,
  } = useForm<MagicLinkForm>({
    resolver: zodResolver(magicLinkSchema),
    defaultValues: { email: initialEmail },
  });

  // Carry the password-form email forward when the user opens the magic-link screen,
  // so they don't have to retype it.
  useEffect(() => {
    if (magicMode && currentEmail) {
      resetMagic({ email: currentEmail });
    }
  }, [magicMode, currentEmail, resetMagic]);

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

  async function onSubmitMagic(data: MagicLinkForm) {
    setLoading(true);
    setError(null);
    try {
      await fetch("/api/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.email, tenantSlug: gym.slug }),
      });
      // Always show success — no enumeration on client side either
      setMagicSent(data.email);
      setResendCountdown(60);
    } catch {
      // Still show success to avoid enumeration
      setMagicSent(data.email);
      setResendCountdown(60);
    } finally {
      setLoading(false);
    }
  }

  async function onResendMagic() {
    if (!magicSent || resendCountdown > 0 || resending) return;
    setResending(true);
    try {
      await fetch("/api/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: magicSent, tenantSlug: gym.slug }),
      });
    } catch { /* silent — same anti-enumeration stance */ }
    setResending(false);
    setResendCountdown(60);
  }

  // Countdown ticker for the resend button — runs only while > 0.
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const t = setTimeout(() => setResendCountdown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCountdown]);

  const header = (
    <div
      className="flex items-center px-6 py-5 border-b"
      style={{ borderColor: theme.borderSoft }}
    >
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 transition-colors text-sm"
        style={{ color: theme.textSoft }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = theme.textMain; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = theme.textSoft; }}
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>
    </div>
  );

  const logoBlock = (
    <div className="flex flex-col items-center mb-10">
      <div className="mb-4">
        <LogoMark gym={gym} />
      </div>
      <h2 className="text-xl font-bold tracking-tight text-center" style={{ color: theme.textMain }}>{gym.name}</h2>
      <p className="text-xs mt-1" style={{ color: theme.textSoft }}>{gym.slug}</p>
    </div>
  );

  // Magic-link sent confirmation
  if (magicSent) {
    return (
      <div className="min-h-screen flex flex-col" style={{ background: theme.appBg, fontFamily: theme.appFont }}>
        {header}
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
          <div className="w-full max-w-[360px] flex flex-col items-center text-center">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mb-6"
              style={{ background: hex(theme.primary, 0.16) }}
            >
              <CheckCircle2 className="w-8 h-8" style={{ color: theme.primary }} />
            </div>
            <h2 className="text-xl font-bold mb-2" style={{ color: theme.textMain }}>Check your inbox</h2>
            <p className="text-sm mb-2 leading-relaxed" style={{ color: theme.textMuted }}>
              A sign-in link has been sent to{" "}
              <span style={{ color: theme.textMain, fontWeight: 500 }}>{magicSent}</span>.
            </p>
            <p className="text-sm mb-6" style={{ color: theme.textMuted }}>
              The link expires in <span style={{ color: theme.textMain, fontWeight: 600 }}>30 minutes</span>.
            </p>

            {/* Resend control — disabled with a countdown for the first 60s
                so users don't spam the API while the email is just delayed. */}
            <button
              type="button"
              onClick={onResendMagic}
              disabled={resendCountdown > 0 || resending}
              className="w-full py-2.5 mb-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
              style={{
                color: theme.textMain,
                background: theme.surface,
                border: `1px solid ${theme.border}`,
              }}
            >
              {resending
                ? "Sending…"
                : resendCountdown > 0
                  ? `Resend link in ${resendCountdown}s`
                  : "Resend link"}
            </button>

            <button
              onClick={() => { setMagicSent(null); setMagicMode(false); setResendCountdown(0); }}
              className="text-xs font-medium transition-colors hover:opacity-70"
              style={{ color: theme.primary }}
            >
              Use password instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Magic-link email entry form
  if (magicMode) {
    return (
      <div className="min-h-screen flex flex-col" style={{ background: theme.appBg, fontFamily: theme.appFont }}>
        {header}
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
          <div className="w-full max-w-[360px]">
            {logoBlock}
            <p className="text-sm text-center mb-6" style={{ color: theme.textMuted }}>
              Enter your email and we&apos;ll send you a sign-in link.
            </p>
            <form onSubmit={handleSubmitMagic(onSubmitMagic)} className="space-y-3">
              <div>
                <input
                  {...registerMagic("email")}
                  type="email"
                  placeholder="Email address"
                  autoComplete="email"
                  autoFocus
                  className="w-full rounded-xl px-4 py-4 text-sm outline-none transition-all"
                  style={{
                    color: theme.textMain,
                    background: theme.surfaceStrong,
                    border: `1px solid ${magicErrors.email ? "#ef4444" : theme.border}`,
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = theme.primary;
                    e.target.style.boxShadow = `0 0 0 3px ${hex(theme.primary, 0.15)}`;
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = magicErrors.email ? "#ef4444" : theme.border;
                    e.target.style.boxShadow = "none";
                  }}
                />
                {magicErrors.email && (
                  <p className="text-red-400 text-xs mt-1 pl-1">{magicErrors.email.message}</p>
                )}
              </div>

              {error && (
                <div
                  className="rounded-xl px-4 py-3 text-xs border"
                  style={{ color: theme.dangerText, background: theme.dangerBg, borderColor: theme.dangerBorder }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:opacity-90 active:scale-[0.99]"
                style={{ background: theme.primary }}
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send sign-in link"}
              </button>

              <button
                type="button"
                onClick={() => setMagicMode(false)}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ color: theme.textMain, background: theme.surface, border: `1px solid ${theme.border}` }}
              >
                Use password instead
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Default: password form
  return (
    <div className="min-h-screen flex flex-col" style={{ background: theme.appBg, fontFamily: theme.appFont }}>
      {header}

      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <div className="w-full max-w-[360px]">
          {logoBlock}

          <p className="text-sm text-center mb-6" style={{ color: theme.textMuted }}>
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
                className="w-full rounded-xl px-4 py-4 text-sm outline-none transition-all"
                style={{
                  color: theme.textMain,
                  background: theme.surfaceStrong,
                  border: `1px solid ${errors.email ? "#ef4444" : theme.border}`,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = theme.primary;
                  e.target.style.boxShadow = `0 0 0 3px ${hex(theme.primary, 0.15)}`;
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors.email ? "#ef4444" : theme.border;
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
                  className="w-full rounded-xl px-4 py-4 pr-12 text-sm outline-none transition-all"
                  style={{
                    color: theme.textMain,
                    background: theme.surfaceStrong,
                    border: `1px solid ${errors.password ? "#ef4444" : theme.border}`,
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = theme.primary;
                    e.target.style.boxShadow = `0 0 0 3px ${hex(theme.primary, 0.15)}`;
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = errors.password ? "#ef4444" : theme.border;
                    e.target.style.boxShadow = "none";
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: theme.textSoft }}
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
                style={{ color: theme.dangerText, background: theme.dangerBg, borderColor: theme.dangerBorder }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:opacity-90 active:scale-[0.99] mt-1"
              style={{ background: theme.primary }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sign in"}
            </button>

            <button
              type="button"
              onClick={() => setMagicMode(true)}
              className="w-full py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
              style={{ color: theme.textMain, background: theme.surface, border: `1px solid ${theme.border}` }}
            >
              Email me a sign-in link
            </button>

            {process.env.NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH === "true" && (
              <button
                type="button"
                onClick={async () => {
                  setLoading(true);
                  setError(null);
                  try {
                    // Pin the tenant via signed cookie BEFORE the OAuth round-trip.
                    // The auth.ts signIn callback rejects the Google response if the
                    // returned email isn't a User/Member in this tenant.
                    const r = await fetch("/api/account/pending-tenant", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tenantSlug: gym.slug }),
                    });
                    if (!r.ok) {
                      setError("Could not start Google sign-in. Try email + password.");
                      setLoading(false);
                      return;
                    }
                    await signIn("google", { callbackUrl: "/dashboard" });
                  } catch {
                    setError("Could not start Google sign-in. Try email + password.");
                    setLoading(false);
                  }
                }}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 hover:opacity-90"
                style={{ color: theme.textMain, background: theme.surface, border: `1px solid ${theme.border}` }}
              >
                <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                  <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
                </svg>
                Continue with Google
              </button>
            )}

            <div className="flex flex-col items-center pt-1 gap-2">
              <button
                type="button"
                onClick={() => onForgot(currentEmail)}
                className="text-xs font-medium transition-colors hover:opacity-70"
                style={{ color: theme.primary }}
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
  const theme = getLoginTheme(gym);

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
    <div className="min-h-screen flex flex-col" style={{ background: theme.appBg, fontFamily: theme.appFont }}>
      <div
        className="flex items-center px-6 py-5 border-b"
        style={{ borderColor: theme.borderSoft }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 transition-colors text-sm"
          style={{ color: theme.textSoft }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = theme.textMain; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = theme.textSoft; }}
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <div className="w-full max-w-[360px]">
          {/* Club logo (small) */}
          <div className="flex justify-center mb-8">
            <LogoMark gym={gym} size={52} />
          </div>

          <h2 className="text-xl font-bold mb-2" style={{ color: theme.textMain }}>Use an email code</h2>
          <p className="text-sm mb-8 leading-relaxed" style={{ color: theme.textMuted }}>
            Enter your email and we&apos;ll send you a one-time code so you can reset your password and continue.
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
            <input
              {...register("email")}
              type="email"
              placeholder="Your email address"
              autoComplete="email"
              autoFocus
              className="w-full rounded-xl px-4 py-4 text-sm outline-none transition-all"
              style={{
                color: theme.textMain,
                background: theme.surfaceStrong,
                border: `1px solid ${errors.email ? "#ef4444" : theme.border}`,
              }}
              onFocus={(e) => {
                e.target.style.borderColor = theme.primary;
                e.target.style.boxShadow = `0 0 0 3px ${hex(theme.primary, 0.15)}`;
              }}
              onBlur={(e) => {
                e.target.style.borderColor = errors.email ? "#ef4444" : theme.border;
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
              style={{ background: theme.primary }}
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
  const theme = getLoginTheme(gym);

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
      <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: theme.appBg, fontFamily: theme.appFont }}>
        <div className="w-full max-w-[360px] flex flex-col items-center text-center">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mb-6"
            style={{ background: hex(theme.primary, 0.16) }}
          >
            <CheckCircle2 className="w-8 h-8" style={{ color: theme.primary }} />
          </div>
          <h2 className="text-xl font-bold mb-2" style={{ color: theme.textMain }}>Password updated</h2>
          <p className="text-sm mb-8" style={{ color: theme.textMuted }}>
            You can now sign in with your new password.
          </p>
          <button
            onClick={onDone}
            className="w-full py-4 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.99]"
            style={{ background: theme.primary }}
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: theme.appBg, fontFamily: theme.appFont }}>
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <div className="w-full max-w-[360px]">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mb-8"
            style={{ background: hex(theme.primary, 0.16) }}
          >
            <span className="text-xl" style={{ color: theme.primary }}>✉</span>
          </div>

          <h2 className="text-xl font-bold mb-2" style={{ color: theme.textMain }}>Check your email</h2>
          <p className="text-sm mb-8 leading-relaxed" style={{ color: theme.textMuted }}>
            We sent a 6-digit code to{" "}
            <span style={{ color: theme.textMain, fontWeight: 500 }}>{email}</span>. Enter it below — the code
            expires in <span style={{ color: theme.textMain, fontWeight: 600 }}>2 minutes</span>.
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
                className="w-full rounded-xl px-4 py-4 text-base outline-none transition-all text-center tracking-[0.4em] font-mono font-semibold"
                style={{
                  color: theme.textMain,
                  background: theme.surfaceStrong,
                  border: `1px solid ${errors.token ? "#ef4444" : theme.border}`,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = theme.primary;
                  e.target.style.boxShadow = `0 0 0 3px ${hex(theme.primary, 0.15)}`;
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors.token ? "#ef4444" : theme.border;
                  e.target.style.boxShadow = "none";
                }}
              />
              {errors.token && (
                <p className="text-red-400 text-xs mt-1 pl-1">{errors.token.message}</p>
              )}
            </div>

            {/* ── Reset Password section ── */}
            <div className="pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <p className="text-xs font-medium mb-3 uppercase tracking-wider" style={{ color: theme.textSoft }}>
                New Password
              </p>
            </div>

            <div>
              <input
                {...register("password")}
                type="password"
                placeholder="New password (min. 10 characters)"
                className="w-full rounded-xl px-4 py-4 text-sm outline-none transition-all"
                style={{
                  color: theme.textMain,
                  background: theme.surfaceStrong,
                  border: `1px solid ${errors.password ? "#ef4444" : theme.border}`,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = theme.primary;
                  e.target.style.boxShadow = `0 0 0 3px ${hex(theme.primary, 0.15)}`;
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors.password ? "#ef4444" : theme.border;
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
                className="w-full rounded-xl px-4 py-4 text-sm outline-none transition-all"
                style={{
                  color: theme.textMain,
                  background: theme.surfaceStrong,
                  border: `1px solid ${errors.confirm ? "#ef4444" : theme.border}`,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = theme.primary;
                  e.target.style.boxShadow = `0 0 0 3px ${hex(theme.primary, 0.15)}`;
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors.confirm ? "#ef4444" : theme.border;
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
                style={{ color: theme.dangerText, background: theme.dangerBg, borderColor: theme.dangerBorder }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:opacity-90 active:scale-[0.99]"
              style={{ background: theme.primary }}
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
        if (data) setGym(mergeLocalBranding(data));
      })
      .catch(() => {});
  }, [gym]);

  useEffect(() => {
    if (!gym?.fontFamily) return;
    const fontName = extractFontName(gym.fontFamily);
    const url = FONT_IMPORTS[fontName];
    if (!url) return;
    const id = `login-gfont-${fontName.replace(/\s/g, "-").toLowerCase()}`;
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = url;
      document.head.appendChild(link);
    }
  }, [gym?.fontFamily]);

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
      } catch { /* fall through */ } finally {
        // Always clear the spinner — without this the success-return path leaves
        // autoSending=true and the page is stuck on "Sending reset code…".
        setAutoSending(false);
      }
    }
    // No valid email — show the email entry page
    setStep("forgot");
  }

  if (!gym) return <GymCodeStep onSuccess={setGym} onLookupError={() => setGym(null)} />;

  if (autoSending) {
    const theme = getLoginTheme(gym);
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: theme.appBg, fontFamily: theme.appFont }}>
        <Loader2 className="w-8 h-8 animate-spin mb-4" style={{ color: theme.primary }} />
        <p className="text-sm" style={{ color: theme.textMuted }}>Sending reset code…</p>
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
