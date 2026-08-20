"use client";

import { useState, useEffect } from "react";
import { signOut } from "next-auth/react";
import { User, Mail, Phone, LogOut, Globe, ExternalLink, X, Pencil } from "lucide-react";
import MemberBillingTab from "@/components/member/MemberBillingTab";
import ClassPacksWidget from "@/components/member/ClassPacksWidget";
import FamilySection from "@/components/member/FamilySection";
import { Button } from "@/components/ui/button";
import { AvatarUploader } from "@/components/ui/AvatarUploader";
import { toBlobProxyUrl } from "@/lib/blob-url";

// Pre-fetch fallback accent only — replaced by the tenant's real colour from
// /api/me/gym as soon as it resolves. Never render fabricated member data
// (docs/UI-RULES.md §7): the former MILESTONES / BEGINNER_CARD / DEMO_MEMBER
// constants showed every member an invented belt history and syllabus.

const FALLBACK_ACCENT = "#3b82f6";

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default function MemberProfilePage() {
  // The whole "Notifications" card was removed deliberately. "Class reminders"
  // went first (no scheduler); "Belt promotions" and "Gym announcements"
  // followed for the same reason — nothing consults Member.beltPromotions or
  // Member.gymAnnouncements on any send path, and the only push channel
  // (lib/push.ts) is dormant because no client ever subscribes and the
  // registered service worker (public/sw.js) carries no push handler. A
  // control that controls nothing is a promise the product cannot keep
  // (UI-RULES §7). The DB columns and /api/member/me PATCH fields are left in
  // place for whenever a real delivery channel ships.
  // Empty until /api/me/gym resolves — never seed a real gym's identity.
  const [gymName, setGymName]       = useState("");
  const [gymWebsite, setGymWebsite] = useState("");
  const [gymAccent, setGymAccent]   = useState<string | null>(null);
  const [gymBilling, setGymBilling] = useState<{ memberSelfBilling: boolean; billingContactEmail: string | null; billingContactUrl: string | null; name: string }>({
    memberSelfBilling: false,
    billingContactEmail: null,
    billingContactUrl: null,
    name: "your gym",
  });
  const [gymPrivacy, setGymPrivacy] = useState<{ privacyContactEmail: string | null; privacyPolicyUrl: string | null }>({
    privacyContactEmail: null,
    privacyPolicyUrl: null,
  });
  const [gymSocials, setGymSocials] = useState<{ instagramUrl: string | null; facebookUrl: string | null; tiktokUrl: string | null; youtubeUrl: string | null; twitterUrl: string | null; websiteUrl: string | null; logoUrl: string | null }>({
    instagramUrl: null,
    facebookUrl: null,
    tiktokUrl: null,
    youtubeUrl: null,
    twitterUrl: null,
    websiteUrl: null,
    logoUrl: null,
  });
  const [socialsOpen, setSocialsOpen] = useState(false);
  const [memberId, setMemberId] = useState<string>("");
  // Empty until /api/member/me resolves — skeletons render meanwhile.
  const [memberName, setMemberName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberPhone, setMemberPhone] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  // feat/member-profile-pictures Track A Phase A3: profile-picture state.
  // null = Avatar falls back to initials; non-null = renders the uploaded
  // image. The upload/remove machinery (and its in-flight and error state)
  // belongs to AvatarUploader — this page only owns the current URL.
  const [profilePictureUrl, setProfilePictureUrl] = useState<string | null>(null);
  const [belt, setBelt] = useState<{ name: string; color: string; stripes: number } | null>(null);
  const [membershipType, setMembershipType] = useState<string | null>(null);
  const [memberSince, setMemberSince] = useState<string | null>(null);
  // 2FA-optional spec (2026-05-07): only members with a password can enrol.
  // Magic-link-only members + kid accounts never see the row.
  const [hasPassword, setHasPassword] = useState(false);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  // Personal-details edit mode (2026-08-17): read-only until the Edit pencil
  // is tapped; a draft holds in-progress values so Cancel restores cleanly.
  const [editingDetails, setEditingDetails] = useState(false);
  const [draft, setDraft] = useState({ name: "", email: "", phone: "" });
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; phone?: string }>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const primaryColor = gymAccent ?? FALLBACK_ACCENT;

  function loadPageData() {
    setLoadError(null);

    // Fetch gym branding + billing + privacy + socials config (member-portal-only).
    // A non-ok response is an ERROR, not an empty state (UI-RULES §7) — throw so
    // the catch below surfaces the retry banner.
    fetch("/api/me/gym")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: {
        name?: string;
        logoUrl?: string | null;
        primaryColor?: string;
        memberSelfBilling?: boolean;
        billingContactEmail?: string | null;
        billingContactUrl?: string | null;
        privacyContactEmail?: string | null;
        privacyPolicyUrl?: string | null;
        instagramUrl?: string | null;
        facebookUrl?: string | null;
        tiktokUrl?: string | null;
        youtubeUrl?: string | null;
        twitterUrl?: string | null;
        websiteUrl?: string | null;
      } | null) => {
        if (!data) return;
        if (data.name) setGymName(data.name);
        if (data.primaryColor) setGymAccent(data.primaryColor);
        if (data.websiteUrl) setGymWebsite(data.websiteUrl);
        setGymBilling({
          memberSelfBilling: data.memberSelfBilling ?? false,
          billingContactEmail: data.billingContactEmail ?? null,
          billingContactUrl: data.billingContactUrl ?? null,
          name: data.name ?? "your gym",
        });
        setGymPrivacy({
          privacyContactEmail: data.privacyContactEmail ?? null,
          privacyPolicyUrl: data.privacyPolicyUrl ?? null,
        });
        setGymSocials({
          instagramUrl: data.instagramUrl ?? null,
          facebookUrl: data.facebookUrl ?? null,
          tiktokUrl: data.tiktokUrl ?? null,
          youtubeUrl: data.youtubeUrl ?? null,
          twitterUrl: data.twitterUrl ?? null,
          websiteUrl: data.websiteUrl ?? null,
          logoUrl: data.logoUrl ?? null,
        });
      })
      .catch(() => setLoadError("Couldn't load your gym's details — tap retry."));

    // Fetch member profile — non-ok throws (error ≠ empty, UI-RULES §7); raw
    // exception text never reaches the member.
    void fetch("/api/member/me")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { id?: string; name?: string; email?: string; phone?: string | null; belt?: { name: string; color: string; stripes: number } | null; membershipType?: string | null; joinedAt?: string; totpEnabled?: boolean; hasPassword?: boolean; profilePictureUrl?: string | null } | null) => {
        if (data?.id) setMemberId(data.id);
        if (data?.name)  setMemberName(data.name);
        if (data?.email) setMemberEmail(data.email);
        if (data?.phone !== undefined) setMemberPhone(data.phone ?? null);
        if (data && "profilePictureUrl" in data) setProfilePictureUrl(data.profilePictureUrl ?? null);
        if (data?.belt) setBelt({ name: data.belt.name, color: data.belt.color, stripes: data.belt.stripes });
        if (data?.membershipType) setMembershipType(data.membershipType);
        if (data?.joinedAt) setMemberSince(new Date(data.joinedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" }));
        // 2FA-optional spec
        setHasPassword(data?.hasPassword ?? false);
        setTotpEnabled(data?.totpEnabled ?? false);
        setProfileLoaded(true);
      })
      .catch(() => setLoadError("Couldn't load your profile — tap retry."));
  }

  useEffect(() => {
    loadPageData();
   
  }, []);

  return (
    <div className="px-4 pt-4 pb-8">
      <h1 className="text-white text-xl font-bold tracking-tight mb-4">Profile</h1>

      {/* Load error banner */}
      {loadError && (
        <div role="alert" className="mb-4 px-4 py-3 rounded-2xl flex items-center justify-between gap-3" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <p className="text-red-400 text-sm flex-1">{loadError}</p>
          <button
            onClick={loadPageData}
            className="text-xs font-semibold px-3 py-1.5 rounded-xl shrink-0"
            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Club gym card — tap to open socials modal (Sprint 3 L).
          Skeleton until /api/me/gym resolves — no placeholder gym identity. ── */}
      {gymName ? (
        <button
          onClick={() => setSocialsOpen(true)}
          className="w-full flex items-center gap-3 rounded-2xl border p-4 mb-5 transition-all active:scale-[0.99] text-left"
          style={{ background: hex(primaryColor, 0.06), borderColor: hex(primaryColor, 0.2) }}
          aria-label={`Open ${gymName} links`}
        >
          {gymSocials.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={toBlobProxyUrl(gymSocials.logoUrl) ?? gymSocials.logoUrl} alt={`${gymName} logo`} className="w-9 h-9 rounded-xl object-cover shrink-0" />
          ) : (
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-[var(--tx-on-accent)] font-bold text-sm"
              style={{ background: primaryColor }}
            >
              {gymName.charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-sm">{gymName}</p>
            {(gymSocials.websiteUrl ?? gymWebsite) && (
              <p className="text-gray-400 text-xs truncate">{(gymSocials.websiteUrl ?? gymWebsite).replace("https://", "")}</p>
            )}
          </div>
          <ExternalLink className="w-4 h-4 text-gray-500 shrink-0" />
        </button>
      ) : (
        <div className="h-[74px] rounded-2xl mb-5 animate-pulse" style={{ background: "rgba(255,255,255,0.06)" }} aria-hidden />
      )}

      {socialsOpen && (
        <GymSocialsModal
          gymName={gymName}
          logoUrl={gymSocials.logoUrl}
          socials={gymSocials}
          primaryColor={primaryColor}
          onClose={() => setSocialsOpen(false)}
        />
      )}

      {/* ── Avatar ──
          The upload flow lives in exactly one place now:
          components/ui/AvatarUploader. This page carried its own copy of it,
          and the copy had drifted in two ways that both mattered:
            - it rendered the RAW blob URL, which is unfetchable by a browser
              because uploads are stored `access: "private"` — the member saw a
              plain dark circle where their photo should be;
            - it skipped the orphan-blob cleanup AvatarUploader fires when the
              PUT fails after /api/upload has already written a file.
          Deleting the copy fixes both and removes the drift for good. ── */}
      <div className="flex flex-col items-center mb-7">
        <AvatarUploader
          memberId={memberId}
          name={memberName}
          pictureUrl={profilePictureUrl}
          colorSeed={memberId}
          size="xl"
          onChange={setProfilePictureUrl}
        />
        {profileLoaded ? (
          <p className="text-white font-semibold text-base mt-3">{memberName}</p>
        ) : (
          <div className="h-5 w-36 rounded-md mt-3 animate-pulse" style={{ background: "rgba(255,255,255,0.06)" }} aria-hidden />
        )}
        {belt && (
          <div className="flex items-center gap-2 mt-1">
            <div className="w-8 h-3 rounded-sm" style={{ background: belt.color }} />
            <p className="text-gray-400 text-xs">{belt.name} · {belt.stripes} stripe{belt.stripes !== 1 ? "s" : ""}</p>
          </div>
        )}
      </div>

      {/* ── Billing + class packs ── */}
      <div className="space-y-4 mb-7">
        <MemberBillingTab primaryColor={primaryColor} gym={gymBilling} />
        <ClassPacksWidget primaryColor={primaryColor} />
      </div>

      {/* ── My Family (parent account, real data) ──
          The former "My Journey" milestone strip and "Beginner Foundations"
          checklist were removed: they rendered hardcoded fabricated history
          ("Awarded by Coach Mike", fake syllabus) to every member of every
          tenant. Reinstate only when backed by real rank-history data
          (UI-RULES §7: never render fabricated data). ── */}
      <FamilySection
        primaryColor={primaryColor}
        billingContactEmail={gymBilling.billingContactEmail}
        gymName={gymBilling.name}
      />

      {/* ── Personal details ──
          Read-only by default; the pencil enters edit mode with a draft so
          Cancel restores cleanly. Client-side validation mirrors the server
          zod schema; server 400/409 field errors map back inline. */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider">
            Personal Details
          </p>
          {!editingDetails && (
            // Button primitive on the member shell: the layout publishes
            // --color-primary / --tx-on-accent for exactly this (same reason
            // Switch works here). `ghost` carries no background of its own, so
            // the accent tint below is the whole look; the hover class replaces
            // ghost's staff-token hover via tailwind-merge, and `compact` swaps
            // their py-1.5 for the primitive's 44px hit-area overlay (§5a).
            <Button
              type="button"
              variant="ghost"
              size="compact"
              onClick={() => {
                setDraft({ name: memberName, email: memberEmail, phone: memberPhone ?? "" });
                setFieldErrors({});
                setSaveMsg(null);
                setEditingDetails(true);
              }}
              aria-label="Edit personal details"
              className="gap-1.5 rounded-lg px-2.5 text-xs font-semibold hover:bg-[color-mix(in_srgb,var(--color-primary)_18%,transparent)]"
              style={{ color: primaryColor, background: hex(primaryColor, 0.1) }}
            >
              <Pencil className="w-3 h-3" aria-hidden />
              Edit
            </Button>
          )}
        </div>

        {!editingDetails ? (
          <>
            {/* Read-only rows */}
            {[
              { icon: User, label: "Name", value: memberName || "—" },
              { icon: Mail, label: "Email", value: memberEmail || "—" },
              { icon: Phone, label: "Phone", value: memberPhone || "Not set" },
            ].map(({ icon: Icon, label, value }, i) => (
              <div
                key={label}
                className="flex items-center gap-3 px-4 py-3.5"
                style={i > 0 ? { borderTop: "1px solid var(--member-border)" } : undefined}
              >
                <Icon className="w-4 h-4 text-gray-600 shrink-0" aria-hidden />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">{label}</p>
                  <p className="text-white text-sm truncate">{value}</p>
                </div>
              </div>
            ))}
            {saveMsg && (
              <p
                role="status"
                className={`px-4 pb-3 text-sm font-medium ${saveMsg.type === "ok" ? "text-green-400" : "text-red-400"}`}
              >
                {saveMsg.text}
              </p>
            )}
            <div className="pb-1.5" />
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              // Client-side validation mirroring lib/schemas/member.ts.
              const errs: typeof fieldErrors = {};
              if (!draft.name.trim() || draft.name.trim().length > 120) errs.name = "Enter your name";
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) errs.email = "Enter a valid email address";
              if (draft.phone.trim() && !/^\+?[\d\s\-().]{7,17}$/.test(draft.phone.trim())) errs.phone = "Enter a valid phone number";
              setFieldErrors(errs);
              if (Object.keys(errs).length > 0) return;

              setSaving(true);
              setSaveMsg(null);
              try {
                const res = await fetch("/api/member/me", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: draft.name.trim(),
                    email: draft.email.trim(),
                    phone: draft.phone.trim() || "",
                  }),
                });
                if (res.ok) {
                  setMemberName(draft.name.trim());
                  setMemberEmail(draft.email.trim().toLowerCase());
                  setMemberPhone(draft.phone.trim() || null);
                  setEditingDetails(false);
                  setSaveMsg({ type: "ok", text: "Details saved" });
                  setTimeout(() => setSaveMsg(null), 3000);
                } else {
                  const data = (await res.json().catch(() => ({}))) as { error?: string; fieldErrors?: typeof fieldErrors };
                  if (data.fieldErrors && Object.values(data.fieldErrors).some(Boolean)) {
                    setFieldErrors(data.fieldErrors);
                  } else {
                    setSaveMsg({ type: "err", text: data.error ?? "Could not save. Try again." });
                  }
                }
              } catch {
                setSaveMsg({ type: "err", text: "Could not save. Try again." });
              } finally {
                setSaving(false);
              }
            }}
          >
            {(
              [
                { key: "name" as const, icon: User, label: "Name", type: "text", autoComplete: "name", hint: undefined },
                { key: "email" as const, icon: Mail, label: "Email", type: "email", autoComplete: "email", hint: "This is the email you sign in with." },
                { key: "phone" as const, icon: Phone, label: "Phone", type: "tel", autoComplete: "tel", hint: undefined },
              ]
            ).map(({ key, icon: Icon, label, type, autoComplete, hint }, i) => (
              <label
                key={key}
                className="flex items-center gap-3 px-4 py-3.5 cursor-text"
                style={i > 0 ? { borderTop: "1px solid var(--member-border)" } : undefined}
              >
                <Icon className="w-4 h-4 text-gray-600 shrink-0" aria-hidden />
                <span className="flex-1 min-w-0">
                  <span className="block text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">{label}</span>
                  <input
                    type={type}
                    autoComplete={autoComplete}
                    value={draft[key]}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, [key]: e.target.value }));
                      if (fieldErrors[key]) setFieldErrors((f) => ({ ...f, [key]: undefined }));
                    }}
                    aria-label={label}
                    aria-invalid={!!fieldErrors[key]}
                    aria-describedby={fieldErrors[key] ? `pd-err-${key}` : hint ? `pd-hint-${key}` : undefined}
                    className="ui-fixed-size w-full bg-transparent text-white text-sm outline-none rounded-md"
                    style={fieldErrors[key] ? { boxShadow: "0 0 0 1.5px var(--hue-danger)" } : undefined}
                  />
                  {fieldErrors[key] ? (
                    <span id={`pd-err-${key}`} className="block text-xs mt-1" style={{ color: "var(--hue-danger)" }}>
                      {fieldErrors[key]}
                    </span>
                  ) : hint ? (
                    <span id={`pd-hint-${key}`} className="block text-gray-600 text-[10px] mt-1">{hint}</span>
                  ) : null}
                </span>
              </label>
            ))}
            <div className="mt-2 flex items-center justify-end gap-2 px-4 pb-4">
              {saveMsg?.type === "err" && (
                <span role="status" className="text-sm font-medium text-red-400 mr-auto">{saveMsg.text}</span>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => { setEditingDetails(false); setFieldErrors({}); setSaveMsg(null); }}
                className="rounded-xl border hover:bg-[color-mix(in_srgb,var(--member-text-muted)_10%,transparent)]"
                style={{ color: "var(--member-text-muted)", borderColor: "var(--member-border)" }}
              >
                Cancel
              </Button>
              {/* `loading` disables the button while the PATCH is in flight,
                  which is the double-submit guard §6 asks for — the hand-rolled
                  version only dimmed it. Colour comes from the shell's
                  --color-primary / --tx-on-accent, so a light tenant accent
                  gets readable dark text instead of the old fixed white. */}
              <Button type="submit" variant="primary" loading={saving} className="rounded-xl font-semibold">
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* ── Membership — rows render only from real fetched data ── */}
      {(membershipType || memberSince || gymWebsite) && (
        <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
          <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
            Membership
          </p>
          {membershipType && (
            <div className="px-4 py-3.5 flex items-center gap-3 border-t border-white/5">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--hue-success)" }} />
              <div className="flex-1">
                <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Current Plan</p>
                <p className="text-white text-sm">{membershipType}</p>
              </div>
              <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-400">Active</span>
            </div>
          )}
          {memberSince && (
            <div className="px-4 py-3.5 flex items-center gap-3 border-t border-white/5">
              <Globe className="w-4 h-4 text-gray-600 shrink-0" />
              <div className="flex-1">
                <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Member Since</p>
                <p className="text-white text-sm">{memberSince}</p>
              </div>
            </div>
          )}
          {/* App Store compliant: direct to website, no in-app payment UI */}
          {gymWebsite && (
            <a
              href={gymWebsite}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between px-4 py-3.5 border-t border-white/5 transition-colors hover:bg-white/3"
            >
              <span className="text-gray-400 text-sm">Manage subscription</span>
              <ExternalLink className="w-3.5 h-3.5 text-gray-600" />
            </a>
          )}
        </div>
      )}

      {/* ── Security (2FA-optional spec, 2026-05-07) ──
          Visible only when the member has a password. Magic-link-only
          members and kid accounts cannot enrol in 2FA. */}
      {hasPassword && (
        <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
          <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
            Security
          </p>
          <div className="px-4 py-3.5 border-t border-white/5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium">Two-factor authentication</p>
                <p className="text-gray-500 text-xs mt-0.5">
                  {totpEnabled
                    ? "Enabled. Contact your gym to reset if you lose your authenticator."
                    : "Recommended. Adds an authenticator code to password sign-ins."}
                </p>
              </div>
              {totpEnabled ? (
                <span className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-semibold" style={{ background: "rgba(16,185,129,0.12)", color: "#10b981" }}>
                  ✓ Enabled
                </span>
              ) : (
                <a
                  href="/login/totp/setup"
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--tx-on-accent)]"
                  style={{ background: primaryColor }}
                >
                  Set up
                </a>
              )}
            </div>
            <p className="text-gray-600 text-[11px] leading-relaxed mt-3">
              Note: magic-link login does not require 2FA. Use password sign-in to get full second-factor protection.
            </p>
          </div>
        </div>
      )}

      {/* ── Data & Privacy (Sprint 3 L — authed-only, gym-specific) ── */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
          Data & Privacy
        </p>
        <div className="px-4 py-3.5 border-t border-white/5">
          <p className="text-gray-400 text-xs leading-relaxed">
            <span className="text-white font-medium">{gymName}</span> is the data controller for your account information, attendance records, and waivers held under MatFlow.
          </p>
          {(gymPrivacy.privacyContactEmail || gymPrivacy.privacyPolicyUrl) && (
            <div className="mt-3 space-y-1.5">
              {gymPrivacy.privacyContactEmail && (
                <a href={`mailto:${gymPrivacy.privacyContactEmail}`} className="flex items-center gap-2 text-xs" style={{ color: primaryColor }}>
                  <Mail className="w-3.5 h-3.5 shrink-0" /> {gymPrivacy.privacyContactEmail}
                </a>
              )}
              {gymPrivacy.privacyPolicyUrl && (
                <a href={gymPrivacy.privacyPolicyUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs" style={{ color: primaryColor }}>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" /> Read {gymName}&apos;s privacy notice
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Links — only render targets that actually exist for this gym ── */}
      <div className="rounded-2xl border overflow-hidden mb-6" style={{ borderColor: "var(--member-border)" }}>
        {[
          { label: "Privacy Policy",  href: gymPrivacy.privacyPolicyUrl ?? (gymWebsite ? `${gymWebsite}/privacy` : null) },
          { label: "Terms of Service", href: gymWebsite ? `${gymWebsite}/terms` : null },
          { label: "Help & Support",  href: gymWebsite ? `${gymWebsite}/support` : null },
        ].filter((l): l is { label: string; href: string } => !!l.href).map(({ label, href }, i) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between px-4 py-3.5 transition-colors hover:bg-white/3"
            style={{ borderTop: i > 0 ? "1px solid var(--member-border)" : undefined }}
          >
            <span className="text-gray-400 text-sm">{label}</span>
            <ExternalLink className="w-3.5 h-3.5 text-gray-600" />
          </a>
        ))}
      </div>

      {/* ── Sign out ── */}
      <button
        className="w-full py-3.5 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold transition-all active:scale-[0.98]"
        style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}
        onClick={() => signOut({ callbackUrl: "/login" })}
      >
        <LogOut className="w-4 h-4" />
        Sign Out
      </button>
    </div>
  );
}

// ─── Sprint 3 L: Gym socials modal (client-side, not nav) ───────────────────

function GymSocialsModal({
  gymName,
  logoUrl,
  socials,
  primaryColor,
  onClose,
}: {
  gymName: string;
  logoUrl: string | null;
  socials: { instagramUrl: string | null; facebookUrl: string | null; tiktokUrl: string | null; youtubeUrl: string | null; twitterUrl: string | null; websiteUrl: string | null };
  primaryColor: string;
  onClose: () => void;
}) {
  const links = [
    { key: "websiteUrl", label: "Website",  url: socials.websiteUrl,  emoji: "🌐" },
    { key: "instagramUrl", label: "Instagram", url: socials.instagramUrl, emoji: "📸" },
    { key: "facebookUrl", label: "Facebook", url: socials.facebookUrl, emoji: "📘" },
    { key: "tiktokUrl", label: "TikTok",   url: socials.tiktokUrl,   emoji: "🎵" },
    { key: "youtubeUrl", label: "YouTube",  url: socials.youtubeUrl,  emoji: "▶️" },
    { key: "twitterUrl", label: "Twitter / X", url: socials.twitterUrl, emoji: "𝕏" },
  ].filter((l) => !!l.url);

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center"
        style={{ paddingBottom: "var(--member-nav-clearance)" }}
        onClick={onClose}
        aria-modal="true"
        role="dialog"
      >
        <div
          className="bg-[var(--member-elevated)] border border-[var(--member-elevated-border)] rounded-t-3xl md:rounded-3xl w-full md:max-w-sm p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 mb-4">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={toBlobProxyUrl(logoUrl) ?? logoUrl} alt={`${gymName} logo`} className="w-12 h-12 rounded-2xl object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-[var(--tx-on-accent)] text-xl font-bold" style={{ background: primaryColor }}>
                {gymName.charAt(0)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-base">{gymName}</p>
              <p className="text-gray-500 text-xs">Connect with your gym</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: "var(--member-surface)" }}
              aria-label="Close"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
          {links.length === 0 ? (
            <p className="text-gray-500 text-sm py-4">No links configured yet — ask your gym to add them in Settings.</p>
          ) : (
            <div className="space-y-2">
              {links.map((l) => (
                <a
                  key={l.key}
                  href={l.url ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-4 py-3 rounded-2xl transition-colors"
                  style={{ background: "var(--member-surface)", border: "1px solid var(--member-border)" }}
                >
                  <span className="text-lg">{l.emoji}</span>
                  <span className="flex-1 text-white text-sm font-medium">{l.label}</span>
                  <ExternalLink className="w-3.5 h-3.5 text-gray-500" />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
