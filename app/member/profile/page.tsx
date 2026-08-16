"use client";

import { useState, useEffect, useRef } from "react";
import { signOut } from "next-auth/react";
import { User, Mail, Phone, Bell, LogOut, Camera, Globe, ExternalLink, X, Loader2 } from "lucide-react";
import MemberBillingTab from "@/components/member/MemberBillingTab";
import ClassPacksWidget from "@/components/member/ClassPacksWidget";
import FamilySection from "@/components/member/FamilySection";
import { Switch } from "@/components/ui/switch";

// Pre-fetch fallback accent only — replaced by the tenant's real colour from
// /api/me/gym as soon as it resolves. Never render fabricated member data
// (docs/UI-RULES.md §7): the former MILESTONES / BEGINNER_CARD / DEMO_MEMBER
// constants showed every member an invented belt history and syllabus.

const FALLBACK_ACCENT = "#3b82f6";

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase() || "·";
}

export default function MemberProfilePage() {
  // "Class reminders" was removed deliberately: no scheduler exists to send
  // them, and the UI must not promise what no code delivers (UI-RULES §7).
  const [notifications, setNotifications] = useState({
    promotions: true,
    announcements: true,
  });
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
  // null = falls back to initials; non-null = renders the uploaded image.
  // pictureUploading gates the Camera button while the two-step
  // (POST /api/upload → PUT /api/members/:id/profile-picture) is in flight.
  const [profilePictureUrl, setProfilePictureUrl] = useState<string | null>(null);
  const [pictureUploading, setPictureUploading] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const pictureInputRef = useRef<HTMLInputElement | null>(null);
  const [belt, setBelt] = useState<{ name: string; color: string; stripes: number } | null>(null);
  const [membershipType, setMembershipType] = useState<string | null>(null);
  const [memberSince, setMemberSince] = useState<string | null>(null);
  // 2FA-optional spec (2026-05-07): only members with a password can enrol.
  // Magic-link-only members + kid accounts never see the row.
  const [hasPassword, setHasPassword] = useState(false);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
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
      .then((data: { id?: string; name?: string; email?: string; phone?: string | null; belt?: { name: string; color: string; stripes: number } | null; membershipType?: string | null; joinedAt?: string; beltPromotions?: boolean; gymAnnouncements?: boolean; totpEnabled?: boolean; hasPassword?: boolean; profilePictureUrl?: string | null } | null) => {
        if (data?.id) setMemberId(data.id);
        if (data?.name)  setMemberName(data.name);
        if (data?.email) setMemberEmail(data.email);
        if (data?.phone !== undefined) setMemberPhone(data.phone ?? null);
        if (data && "profilePictureUrl" in data) setProfilePictureUrl(data.profilePictureUrl ?? null);
        // RB-005: hydrate notification prefs (defaults true if API returns nothing)
        if (data) {
          setNotifications({
            promotions:      data.beltPromotions  ?? true,
            announcements:   data.gymAnnouncements ?? true,
          });
        }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // RB-005: toggle flips local state optimistically + PATCHes the API.
  // Local UI key → server field mapping (UI uses shorter labels; API uses
  // explicit beltPromotions / gymAnnouncements to be self-documenting).
  const NOTIF_FIELD_MAP: Record<keyof typeof notifications, "beltPromotions" | "gymAnnouncements"> = {
    promotions: "beltPromotions",
    announcements: "gymAnnouncements",
  };
  const toggle = (k: keyof typeof notifications) => {
    const next = !notifications[k];
    setNotifications((p) => ({ ...p, [k]: next }));
    void fetch("/api/member/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [NOTIF_FIELD_MAP[k]]: next }),
    }).catch(() => {
      // Roll back on network failure.
      setNotifications((p) => ({ ...p, [k]: !next }));
    });
  };

  return (
    <div className="px-4 pt-4 pb-8">
      <h1 className="text-white text-xl font-bold tracking-tight mb-4">Profile</h1>

      {/* Load error banner */}
      {loadError && (
        <div className="mb-4 px-4 py-3 rounded-2xl flex items-center justify-between gap-3" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
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
            <img src={gymSocials.logoUrl} alt={`${gymName} logo`} className="w-9 h-9 rounded-xl object-cover shrink-0" />
          ) : (
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white font-bold text-sm"
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

      {/* ── Avatar ── */}
      {/* feat/member-profile-pictures Track A Phase A3: Camera button now wires.
          - Hidden file input below the visible button.
          - On select: POST /api/upload?purpose=profile-pic with the file +
            targetMemberId, then PUT /api/members/<me>/profile-picture with
            the returned blob URL. Both steps share the pictureUploading
            flag so the Camera + Remove buttons disable together.
          - On success, the gradient initials swap to the uploaded image (256×256
            WebP via the sharp pipeline in app/api/upload/route.ts). */}
      <div className="flex flex-col items-center mb-7">
        <div className="relative">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold text-white shadow-lg overflow-hidden"
            style={{
              background: profilePictureUrl
                ? "#0b0c0f"
                : `linear-gradient(135deg, ${primaryColor}, ${hex(primaryColor, 0.6)})`,
            }}
          >
            {profilePictureUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profilePictureUrl}
                alt={memberName}
                width={80}
                height={80}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              initials(memberName)
            )}
          </div>
          <button
            className="absolute bottom-0 right-0 w-7 h-7 rounded-full flex items-center justify-center border-2 transition-opacity disabled:opacity-50"
            style={{ background: "var(--member-elevated)", borderColor: "var(--member-elevated-border)" }}
            aria-label={profilePictureUrl ? "Change profile picture" : "Add profile picture"}
            disabled={pictureUploading || !memberId}
            onClick={() => pictureInputRef.current?.click()}
          >
            {pictureUploading ? (
              <Loader2 className="w-3.5 h-3.5 text-gray-300 animate-spin" />
            ) : (
              <Camera className="w-3.5 h-3.5 text-gray-400" />
            )}
          </button>
          <input
            ref={pictureInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={pictureUploading || !memberId}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              // Clear input value so picking the same file twice in a row
              // still fires a fresh change event.
              e.target.value = "";
              if (!file || !memberId) return;
              setPictureError(null);
              setPictureUploading(true);
              try {
                const fd = new FormData();
                fd.append("file", file);
                fd.append("targetMemberId", memberId);
                const uploadRes = await fetch("/api/upload?purpose=profile-pic", {
                  method: "POST",
                  body: fd,
                });
                if (!uploadRes.ok) {
                  const j = await uploadRes.json().catch(() => ({} as { error?: string }));
                  throw new Error(j.error || "Upload failed");
                }
                const { url } = (await uploadRes.json()) as { url: string };
                const putRes = await fetch(`/api/members/${memberId}/profile-picture`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ url }),
                });
                if (!putRes.ok) {
                  const j = await putRes.json().catch(() => ({} as { error?: string }));
                  throw new Error(j.error || "Save failed");
                }
                const { profilePictureUrl: saved } = (await putRes.json()) as {
                  profilePictureUrl: string | null;
                };
                setProfilePictureUrl(saved);
              } catch (err) {
                setPictureError(err instanceof Error ? err.message : "Couldn't upload");
              } finally {
                setPictureUploading(false);
              }
            }}
          />
        </div>
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
        {profilePictureUrl && (
          <button
            className="mt-2 text-xs text-gray-500 underline-offset-4 hover:underline disabled:opacity-50"
            disabled={pictureUploading}
            onClick={async () => {
              if (!memberId) return;
              setPictureError(null);
              setPictureUploading(true);
              try {
                const res = await fetch(`/api/members/${memberId}/profile-picture`, {
                  method: "DELETE",
                });
                if (!res.ok) throw new Error("Couldn't remove");
                setProfilePictureUrl(null);
              } catch (err) {
                setPictureError(err instanceof Error ? err.message : "Couldn't remove");
              } finally {
                setPictureUploading(false);
              }
            }}
          >
            Remove picture
          </button>
        )}
        {pictureError && (
          <p className="mt-1 text-xs" style={{ color: "#f87171" }}>{pictureError}</p>
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

      {/* ── Personal details ── */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
          Personal Details
        </p>
        {/* Each row is a wrapping <label>: the whole row is the input's hit
            area (§5a extension), so the inputs take .ui-fixed-size — without
            it the blanket 44px min-height inflates the input's box below its
            text line and the icon centres against dead space (icons floated
            high against the visible label+text). items-center now genuinely
            centres the icon on the label+input pair. */}
        <label className="flex items-center gap-3 px-4 py-3.5 cursor-text">
          <User className="w-4 h-4 text-gray-600 shrink-0" aria-hidden />
          <span className="flex-1 min-w-0">
            <span className="block text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Name</span>
            <input
              type="text"
              value={memberName}
              onChange={(e) => setMemberName(e.target.value)}
              className="ui-fixed-size w-full bg-transparent text-white text-sm outline-none"
              aria-label="Name"
            />
          </span>
        </label>
        <label className="flex items-center gap-3 px-4 py-3.5 cursor-default" style={{ borderTop: "1px solid var(--member-border)" }}>
          <Mail className="w-4 h-4 text-gray-600 shrink-0" aria-hidden />
          <span className="flex-1 min-w-0">
            <span className="block text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Email</span>
            <input
              type="email"
              value={memberEmail}
              readOnly
              disabled
              className="ui-fixed-size w-full bg-transparent text-white text-sm outline-none"
              aria-label="Email"
            />
          </span>
        </label>
        <label className="flex items-center gap-3 px-4 py-3.5 cursor-text" style={{ borderTop: "1px solid var(--member-border)" }}>
          <Phone className="w-4 h-4 text-gray-600 shrink-0" aria-hidden />
          <span className="flex-1 min-w-0">
            <span className="block text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Phone</span>
            <input
              type="tel"
              value={memberPhone ?? ""}
              onChange={(e) => setMemberPhone(e.target.value || null)}
              className="ui-fixed-size w-full bg-transparent text-white text-sm outline-none"
              aria-label="Phone"
            />
          </span>
        </label>
        {/* Save sits on its own right-aligned row; the inline save message
            slots in to its left. */}
        <div className="mt-2 flex items-center justify-end gap-3 px-4 pb-4">
          {saveMsg && (
            <span
              role="status"
              className={`text-sm font-medium ${saveMsg.type === "ok" ? "text-green-400" : "text-red-400"}`}
            >
              {saveMsg.text}
            </span>
          )}
          <button
            onClick={async () => {
              setSaving(true);
              setSaveMsg(null);
              try {
                const res = await fetch("/api/member/me", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: memberName, phone: memberPhone }),
                });
                setSaveMsg(res.ok
                  ? { type: "ok", text: "Profile saved" }
                  : { type: "err", text: "Could not save. Try again." }
                );
                setTimeout(() => setSaveMsg(null), 3000);
              } catch {
                setSaveMsg({ type: "err", text: "Could not save. Try again." });
                setTimeout(() => setSaveMsg(null), 3000);
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
            className="shrink-0 px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: primaryColor }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
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

      {/* ── Notifications ── */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
          Notifications
        </p>
        {[
          { key: "promotions"     as const, label: "Belt promotions",   desc: "When you receive a stripe or belt" },
          { key: "announcements"  as const, label: "Gym announcements", desc: "News and updates from coaches" },
        ].map(({ key, label, desc }, i) => (
          <div
            key={key}
            className="flex items-center gap-3 px-4 py-3.5"
            style={{ borderTop: i > 0 ? "1px solid var(--member-border)" : undefined }}
          >
            <Bell className="w-4 h-4 text-gray-600 shrink-0" />
            <div className="flex-1">
              <p className="text-white text-sm font-medium">{label}</p>
              <p className="text-gray-500 text-xs">{desc}</p>
            </div>
            {/* Fixed-geometry Switch primitive (UI-RULES §5a) — the previous
                hand-rolled w-14 toggle stretched with context. */}
            <Switch
              checked={notifications[key]}
              onCheckedChange={() => toggle(key)}
              aria-label={`Toggle ${label}`}
            />
          </div>
        ))}
      </div>

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
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold text-white"
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
              <img src={logoUrl} alt={`${gymName} logo`} className="w-12 h-12 rounded-2xl object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-white text-xl font-bold" style={{ background: primaryColor }}>
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
