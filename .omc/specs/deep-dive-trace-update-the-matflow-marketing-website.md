# Deep Dive Trace: update-the-matflow-marketing-website

Date: 2026-08-22 (Bali). Request: make the marketing site higher quality and more professional, make the system clear, explain all features, add a competitor comparison page — from a gym owner's perspective.

## Observed Result

The public surface is a single landing page (`app/page.tsx` + `components/landing/*`, "Dark Precision" redesign, last touched 16–17 Aug) plus `/apply` and four legal pages. It reads well but undersells a deep product, makes several unbacked commercial claims, and has no indexable pages for the queries a gym owner actually searches.

## Ranked Hypotheses

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | Content–product gap: the site explains ~6 features of a product with 171 API routes and several genuine differentiators; no /features, /pricing, /compare routes exist | High | Strong (route + component audit) | The product is much better than the site; "explain all features" is a real gap, not a polish task |
| 2 | Professionalism gap: unbacked claims (trial/chat/150-cap), contrast failures on trust-critical fine print, /preview publicly crawlable with fabricated data, no OG image, positioning contradictions | High | Strong (verified per-claim against code) | These are the things a diligent gym owner notices and bounces on |
| 3 | Competitive positioning gap: the martial-arts niche is contested (Martialytics, Gymdesk, Zen Planner vertical, PushPress entering); MatFlow has no comparison content and no stated wedge | High | Strong (7 vendors' own pricing pages, retrieved 2026-08-22) | A comparison page is viable and the honest wedge is clear: BJJ-only + branded portal included + GBP + no revenue cut |

## Evidence Summary by Hypothesis

**H1 — Content–product gap.** Landing shows 6 feature cards. The verified inventory (agent report, 2026-08-22) found: belt/stripe tracking with promotion queue + demotions + rank-gated classes; kids/family accounts with per-kid billing (DB-enforced invariants); kiosk with revocable HMAC token; 4 payment rails on Stripe Connect with **zero platform fee** (no `application_fee` anywhere — verifiable); live churn/retention/payment-health reports; AI-drafted monthly analysis; GDPR DSAR export/erase + nightly retention cron; CSV importers (MindBody/Glofox/Wodify/generic) + bulk invite; per-tenant branding incl. fonts and avatar tints; installable PWA; no trackers/analytics at all. None of the distinctive items are explained on the site. No standalone /pricing or /features → nothing ranks for high-intent queries; footer contact is a `mailto:`.

**H2 — Professionalism gap.** Verified against code: "30-day free trial" (×3) has zero implementation; "Email and chat support" — no chat exists; "up to 150 members" unenforced; £89/mo has no billing product behind it and contradicts the locked spec decision (£99/£149/£199 manual invoicing, `deep-dive-matflow-sellable-product.md:11`). Hero mock ships four invented members + "Apex Academy". `/preview` is public, not robots-disallowed, and full of fabricated data ("Coach Mike", fake activity feed, "AI prediction"). Three fine-print tiers fail WCAG contrast (2.77:1, 2.32:1, 1.94:1) — and they are the trust-critical lines. No OG image; no metadataBase; `summary` twitter card; `lang="en"` not `en-GB`; three different product descriptions across layout/page/manifest. "Five fields, two minutes" vs a six-field form. "UK BJJ academies only" vs a 9-discipline apply dropdown. 62 hex literals + 120 inline styles vs UI-RULES §1/§2/§5/§11 (grandfathered in the ratchet baseline, not exempt).

**H3 — Competitive positioning.** All prices from vendors' own pages, retrieved 2026-08-22: Martialytics $69–$199 (martial-arts-only, 1,295 schools, zero payment markup); Gymdesk $75–$200 + $100/mo branded app (4,500+ gyms); Zen Planner from $99 + $99 website + $249 Engage; PushPress free tier at 4.99%+$0.30 card or $159/$229 (BJJ logos: Alliance, Roger Gracie, 10th Planet); TeamUp $189 @101–200 band (+$99 branded app, entry price slider-gated/unverified); Mindbody "starting at $79" with all tiers sales-gated; WodBoard £90–£180 (+£100 white label). Best-practice comparison page (Gymdesk vs Mindbody): 9-axis table, worked cost example, "when to choose them" concession block, published-vs-reported claim separation — its one gap is no retrieval dates. Anti-pattern (PushPress blog): undated numbers contradicting the competitor's live page.

## Evidence Against / Missing Evidence

- **H1**: The copy voice is genuinely good and a prior "honest claims" pass (`fe1cf86`) already ran — the gap is coverage and structure, not prose quality.
- **H2**: No lorem ipsum, no fake testimonials, no fabricated review counts. British English consistent. §3 landing fonts are explicitly sanctioned by UI-RULES. The failures are specific and enumerable, not systemic rot.
- **H3**: MatFlow has zero paying gyms — brand-trust axis is a guaranteed loss; a comparison page pre-launch could read as punching up. Mitigated by the concession-block pattern.

## Per-Lane Critical Unknowns

- **Lane 1 (content–product)**: Which price is true — the live £89/mo or the locked £99/£149/£199 manual-invoice decision? And is "30-day free trial" a real commercial commitment to keep (reworded as a service promise) or cut?
- **Lane 2 (professionalism)**: Is the positioning "UK BJJ academies only" (hero) or broader martial arts (apply form, root layout, manifest)? Every page's copy hangs on this.
- **Lane 3 (competitive)**: Appetite for naming competitors on a public dated comparison page pre-launch — and is the recommended subset (Martialytics, Gymdesk, Zen Planner, Mindbody as the opacity foil; deliberately excluding PushPress/Glofox/TeamUp) right?

## Lane 3 Misplacement / SoT Ownership Scope

Not applicable — no MOVE candidates; this trace investigated a marketing surface, not artefact placement.

## Rebuttal Round

- Best rebuttal to leader (H1): "The site doesn't need more pages — it needs the existing page to stop overclaiming (H2); a gym owner bounces on the first false note, not on missing depth."
- Why the leader held: the two are not rivals — H2's fixes are a subset of the work and mostly one-line edits; H1 explains why the site fails the *positive* case (owner can't find out what the system does, how kiosk/portal/billing fit together, or what it costs vs alternatives). The request explicitly asks for "all features explained" and a comparison page, which only H1+H3 deliver.

## Convergence / Separation Notes

H1 and H2 converge on one mechanism: **truthful specificity**. The upgrade path is the same for both — replace vague/false claims with verifiable, specific ones drawn from the feature inventory. H3 is separable (new page, new content type, legal-safety rules).

## Most Likely Explanation

The site is a well-written but shallow single page over a deep product. "Higher quality / more professional" is achieved mostly through truthful specificity and structure — dedicated feature/pricing/comparison pages built from the verified inventory, plus ~10 enumerated credibility fixes (unbacked claims, /preview, OG image, contrast, positioning contradictions) — not through a visual rewrite. The visual layer is competent; its debt (hex/inline styles) is a maintainability issue, not a perceived-quality issue.

## Critical Unknown

The pricing decision: £89 single plan (live site) vs £99/£149/£199 (locked spec). It gates the pricing section, the comparison table's cost axis, and the trial copy.

## Recommended Discriminating Probe

Ask Noe directly — it is a commercial decision, not discoverable from code.

---

### Appendix: full lane reports

Lane agents' full reports (landing audit, feature inventory with safe-to-claim table and DO-NOT-CLAIM list, competitor research with per-vendor sources retrieved 2026-08-22) are preserved in the session transcripts; their operative conclusions are inlined above. The DO-NOT-CLAIM list from the feature inventory is binding on any rewrite: no push notifications, no "works offline", no "RLS-isolated", no custom domains, no self-serve trial mechanics, no "kiosk blocks unpaid members", no per-session booking/waitlist UI, no "TeamUp import" preset, no "MatFlow Ltd" until incorporation is verified.
