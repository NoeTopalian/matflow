"use client";

/**
 * Settings → Overview → Public page (T9c, Q9 — Noe 17 Oct 2026).
 *
 * The owner decides whether the club's short URL (matflow.studio/<slug>) is a
 * public, searchable page or stays the login door it has always been. OFF by
 * default. What the page shows: the club's name, logo and colours, the live
 * weekly timetable, the description and contact details entered here, the
 * club's website and social links, and the prices of the memberships ticked
 * below. Nothing about members.
 *
 * UI-RULES §7: a failed read renders an error with a retry, never an empty
 * form an owner could save over their real settings.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Globe, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";

type TierOption = { id: string; name: string; price: string; priceKnown: boolean; showOnPublicPage: boolean };

type PublicPageSettings = {
  enabled: boolean;
  enabledAt: string | null;
  description: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  url: string;
  path: string;
  reviewLocked: boolean;
  /** A logo is set but the public page cannot show it (legacy blob or external). */
  logoNotPublic?: boolean;
  tiers: TierOption[];
};

/** Owner-facing names for the API's field keys (UI-RULES §10: no internals). */
const FIELD_LABELS: Record<string, string> = {
  enabled: "Public page switch",
  description: "Short description",
  email: "Public email",
  phone: "Public phone",
  address: "Address",
  publicTierIds: "Membership prices",
};

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

const fieldCls = "w-full bg-transparent border rounded-xl px-3 py-2.5 text-sm placeholder:text-[var(--tx-4)] transition-colors";
const fieldStyle = { borderColor: "var(--bd-default)", color: "var(--tx-1)" } as const;

export default function PublicPageSection() {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState<PublicPageSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [tierIds, setTierIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((d: PublicPageSettings) => {
    setLoaded(d);
    setEnabled(d.enabled);
    setDescription(d.description ?? "");
    setEmail(d.email ?? "");
    setPhone(d.phone ?? "");
    setAddress(d.address ?? "");
    setTierIds(new Set(d.tiers.filter((t) => t.showOnPublicPage).map((t) => t.id)));
  }, []);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/settings/public-page");
      if (!res.ok) { setLoadError(true); return; }
      apply((await res.json()) as PublicPageSettings);
    } catch {
      setLoadError(true);
    }
  }, [apply]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/public-page", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, description, email, phone, address, publicTierIds: [...tierIds] }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
      if (!res.ok) {
        const field = data.details?.fieldErrors
          ? Object.entries(data.details.fieldErrors).find(([, msgs]) => msgs && msgs.length > 0)
          : undefined;
        if (field) {
          setError(`${FIELD_LABELS[field[0]] ?? "One of the fields"}: ${field[1][0]}`);
        } else if (data.error && data.error !== "Invalid data") {
          setError(data.error);
        } else {
          setError("Couldn't save the public page settings. Check the details above and try again.");
        }
        return;
      }
      const wasEnabled = loaded?.enabled ?? false;
      toast(
        enabled && !wasEnabled
          ? "Your public page is live."
          : !enabled && wasEnabled
            ? "Your public page is off. The short link goes to your login again."
            : "Public page saved.",
        "success",
      );
      await load();
    } catch {
      setError("Couldn't reach MatFlow — nothing has changed.");
    } finally {
      setSaving(false);
    }
  }

  // The switch and fields only take effect on Save; say so while they differ
  // from what was loaded, so nobody leaves believing the page is live (or off).
  const dirty =
    loaded !== null &&
    (enabled !== loaded.enabled ||
      description.trim() !== (loaded.description ?? "") ||
      email.trim() !== (loaded.email ?? "") ||
      phone.trim() !== (loaded.phone ?? "") ||
      address.trim() !== (loaded.address ?? "") ||
      !sameSet(tierIds, new Set(loaded.tiers.filter((t) => t.showOnPublicPage).map((t) => t.id))));

  function toggleTier(id: string, on: boolean) {
    setTierIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div
      className="rounded-2xl border p-5 space-y-4"
      style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
      data-testid="public-page-section"
    >
      <div className="flex items-start gap-3">
        <Globe className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" style={{ color: "var(--tx-3)" }} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Public page</p>
          <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>
            Turn your club&apos;s short link into a page anyone can find on Google: your name, logo, live timetable,
            the details below and the prices you choose. Off, the link goes straight to your members&apos; login.
            Member details are never shown.
          </p>
        </div>
      </div>

      {loadError ? (
        <div role="alert"><ErrorState message="Could not load the public page settings — tap to retry" onRetry={load} /></div>
      ) : loaded === null ? (
        <p className="text-xs" style={{ color: "var(--tx-3)" }} aria-busy>Loading public page settings…</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5" style={{ borderColor: "var(--bd-default)" }}>
            <div className="min-w-0">
              <p id="public-page-switch-label" className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>
                Show a public page at {loaded.url.replace(/^https:\/\//, "")}
              </p>
              <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                Search engines may keep a copy for a while after you turn it off.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-labelledby="public-page-switch-label" />
          </div>

          {loaded.logoNotPublic && (
            <p className="text-xs" style={{ color: "var(--hue-warning-ink)" }} data-testid="public-page-logo-note">
              Your logo won&apos;t show on the public page, so your club&apos;s initial is shown instead. Upload the logo
              again under Branding to fix this.
            </p>
          )}

          <label className="block text-xs font-medium" style={{ color: "var(--tx-3)" }}>
            Short description
            <textarea
              aria-label="Short description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={600}
              rows={3}
              placeholder="What you teach and who it's for"
              className={`mt-1 ${fieldCls}`}
              style={fieldStyle}
            />
          </label>

          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block text-xs font-medium" style={{ color: "var(--tx-3)" }}>
              Public email
              <input aria-label="Public email" type="email" maxLength={120} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hello@yourclub.com" className={`mt-1 ${fieldCls}`} style={fieldStyle} />
            </label>
            <label className="block text-xs font-medium" style={{ color: "var(--tx-3)" }}>
              Public phone
              <input aria-label="Public phone" type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 115 000 0000" className={`mt-1 ${fieldCls}`} style={fieldStyle} />
            </label>
          </div>
          <label className="block text-xs font-medium" style={{ color: "var(--tx-3)" }}>
            Address
            <textarea aria-label="Public address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} rows={2} placeholder="Street, town, postcode" className={`mt-1 ${fieldCls}`} style={fieldStyle} />
          </label>
          <p className="text-xs" style={{ color: "var(--tx-3)" }}>
            &quot;Join / book a trial&quot; on the page uses the email, or the phone if there is no email, or your website.
            Website and social links come from Branding.
          </p>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>Show these membership prices</legend>
            <p className="text-xs" style={{ color: "var(--tx-3)" }}>
              Each ticked membership shows its name and price, with a Kids label on kids&apos; plans. Membership
              descriptions are never shown.
            </p>
            {loaded.reviewLocked && (
              <p className="text-xs" style={{ color: "var(--hue-warning-ink)" }}>
                Your club is in review mode, so no prices are shown on the public page until review ends.
              </p>
            )}
            {loaded.tiers.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                No active memberships yet. Add them under{" "}
                <Link href="/dashboard/memberships" className="underline underline-offset-2" style={{ color: "var(--tx-2)" }}>
                  Memberships
                </Link>
                .
              </p>
            ) : (
              <ul className="space-y-1.5">
                {loaded.tiers.map((t) => (
                  <li key={t.id} className="flex items-center gap-3">
                    <Checkbox
                      id={`public-tier-${t.id}`}
                      checked={tierIds.has(t.id)}
                      onCheckedChange={(on) => toggleTier(t.id, on)}
                      disabled={!t.priceKnown}
                      aria-label={`Show ${t.name} price`}
                    />
                    <label htmlFor={`public-tier-${t.id}`} className="text-sm" style={{ color: "var(--tx-1)" }}>
                      {t.name} <span style={{ color: "var(--tx-3)" }}>· {t.price}</span>
                      {!t.priceKnown && <span className="text-xs" style={{ color: "var(--tx-3)" }}> (set a price to show it)</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          {error && <p role="alert" className="text-xs text-[var(--hue-danger-ink)]">{error}</p>}
          {dirty && !error && (
            <p role="status" className="text-xs font-medium" style={{ color: "var(--hue-warning-ink)" }} data-testid="public-page-unsaved">
              {enabled !== loaded.enabled
                ? enabled
                  ? "Unsaved changes. Press Save to publish your page."
                  : "Unsaved changes. Press Save to take your page down."
                : "Unsaved changes. Press Save to update your page."}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={saving} size="compact">
              {saving ? "Saving…" : "Save public page"}
            </Button>
            {/* The preview shows the last SAVED settings, to this owner only;
                anyone else opening the link gets the login door. */}
            <a
              href={loaded.enabled ? loaded.path : `${loaded.path}?preview=1`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2"
              style={{ color: "var(--tx-2)" }}
              data-testid="public-page-preview-link"
            >
              {loaded.enabled ? "View your public page" : "Preview your page (only you can see it)"}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>
        </>
      )}
    </div>
  );
}
