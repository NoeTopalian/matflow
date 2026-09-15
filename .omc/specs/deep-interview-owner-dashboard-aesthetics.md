# Deep Interview Spec: Owner Dashboard Aesthetic Overhaul

## Metadata
- Interview ID: di-2026-08-17-owner-dashboard-aesthetics
- Rounds: 5 (+ Round 0 topology gate)
- Final Ambiguity Score: 15.5%
- Type: brownfield
- Generated: 2026-08-17
- Threshold: 0.2 (20%)
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.35 | 0.298 |
| Constraint Clarity | 0.80 | 0.25 | 0.200 |
| Success Criteria | 0.85 | 0.25 | 0.213 |
| Context Clarity | 0.90 | 0.15 | 0.135 |
| **Total Clarity** | | | **0.845** |
| **Ambiguity** | | | **0.155** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| Audit report | active — DELIVERED | Evidence-based diagnosis of what makes the dashboard look unprofessional | In artifact "Back Office Restyle" (F1–F10, file:line evidence) |
| Visual examples | active — DELIVERED | 4 contrasting concept restyles of the real dashboard home | Artifact concepts A Blueprint / B Clubhouse / C Ledger / D Marquee |
| Preference template | active — DELIVERED | Per-axis like/dislike capture (9 axes) producing a copyable picks string | Artifact section 2; Noe replies with the string |
| Implementation | active, gated | Apply synthesised hybrid staff-wide | Awaits Noe's picks → hybrid → home-screenshot sign-off → rollout |

Artifact: https://claude.ai/code/artifact/82aa6c1b-d3b4-4f33-a11a-9b04ef2f6eb1

## Goal
Diagnose why the light staff/owner dashboard reads as unprofessional, present four contrasting concept restyles of the real dashboard home (examples first — Noe's stated processing order), capture per-axis preferences via a template, synthesise the winning hybrid, and in a later gated phase apply it across the whole staff area — without changing layout/structure or the light theme.

## Constraints
- Sacred: layout & structure (shell, stat row, panel arrangement, information hierarchy) and the light staff theme (locked decision D1)
- Fair game: navy accent strategy, rounded look, typography treatment, colour system, depth, density, micro-labels, icon chips
- Real data only in examples (UI-RULES §7); Geist stays the staff face (UI-RULES §3)
- Concepts may propose UI-RULES §1.5 amendments; Noe holds the veto; picked amendments get written back into UI-RULES.md during implementation
- Implementation respects UI-RULES: tokens not hex, primitives, lint ratchet, British English

## Non-Goals
- No layout/IA redesign; no dark staff theme; no member-portal/kiosk changes; no new heavy dependencies

## Acceptance Criteria
- [x] Audit report delivered, examples-first, every finding with file:line evidence
- [x] 4 concept treatments, same skeleton, contrasting along the template axes
- [x] Per-axis template producing a copyable picks summary (9 axes)
- [ ] Hybrid applied to dashboard home; Noe approves screenshot
- [ ] Staff-wide rollout; `npm run lint && npm test && npm run build` + Playwright matrix green

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| A reference product defines "professional" | R1: which dashboards do you rate? | None named — concepts extract the preference |
| Scope = the screenshot page | R2: one page or ~15 routes? | Whole staff area; home is the exemplar |
| Everything current is sacred | R3: what survives? | Only layout/structure + light theme |
| One concept wins wholesale | R4 (Contrarian): what if the best is a mix? | Per-axis mix; hybrid synthesised from axis verdicts |
| "Done" is self-evident | R5: sign-off mechanism? | Home screenshot approval gates staff-wide rollout |

## Technical Context (audit root causes — full report in the artifact)
1. **F1 Font bug:** `app/layout.tsx:54` puts Geist variables on `<body>`; `app/globals.css:279` applies `font-sans` on `<html>` → var undefined → invalid at computed-value time → whole app renders in Times New Roman. One-line fix; ship ahead of any restyle.
2. **F2 Accent sprawl:** hardcoded `#f59e0b`/`#ef4444`/`#a78bfa`/`#22c55e` in `DashboardStats.tsx`; six role hues + glows in `Topbar.tsx:30-66`; violates UI-RULES §1.5.3 + §2; inline `hex()` duplicates `lib/color.ts`.
3. **F3 Dark residue:** `hover:border-white/20`/`focus:ring-white/20` (`DashboardStats.tsx:139`), `text-amber-400` + `hover:text-white` (`SetupBanner.tsx:49,57`), 56%-black menu shadow (`Topbar.tsx:218`), glows/gradients (`Sidebar.tsx:59`, Topbar avatars).
4. F4 amber means five things at once (incl. Owner badge); F5 `--tx-4` 18%/`--tx-3` 35% alpha fail WCAG contrast; F6 radius/tracking/size drift vs ratified 12px; F7 flat hierarchy (h1 = stat number size, all-bold); F8 multicolour tinted icon chips = template look; F9 incoherent depth story; F10 JS hover handlers in `Sidebar.tsx:174-179`.
- Keep: token architecture, lucide icons, spacing rhythm, copy voice, layout.

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| StaffArea | core surface | ~15 /dashboard routes, shared shell | contains DashboardHome; governed by UI-RULES |
| DashboardHome | exemplar | banners, greeting, stat row, panels | instantiates ConceptVariant treatments |
| DesignTokens | supporting | --sf/--tx/--bd/--r/--hue | implement DesignPhilosophy |
| DesignPhilosophy | concept | UI-RULES §1.5 language | amendable by Noe only |
| AuditReport | deliverable | F1–F10 findings | evidences ConceptVariants |
| ConceptVariant | deliverable | A Blueprint, B Clubhouse, C Ledger, D Marquee | scored via PreferenceTemplate |
| PreferenceTemplate | deliverable | 9 axes, picks string | drives hybrid synthesis |
| UI-RULES | constraint doc | docs/UI-RULES.md | enforced by lint ratchet |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 7 | 7 | - | - | - |
| 2 | 8 | 1 | 1 | 6 | 87.5% |
| 3 | 8 | 0 | 0 | 8 | 100% |
| 4 | 8 | 0 | 0 | 8 | 100% |
| 5 | 8 | 0 | 0 | 8 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds + topology)</summary>

### Round 0 — Topology
**Q:** Four components — audit report, visual examples, preference template, implementation (deferred)?
**A:** "do in correct order" → all four active, strict pipeline order, implementation last and execution-gated.

### Round 1
**Q:** Which real dashboards read as "professional" to you (Stripe / Linear / Notion / can't name one)?
**A:** "Can't name one — show me, build examples and i will determine which one looks best."
**Ambiguity:** 49%

### Round 2
**Q:** Scope — dashboard home only, whole staff area, or shell+home first?
**A:** Whole staff area (home as exemplar).
**Ambiguity:** 40%

### Round 3
**Q:** What is sacred in the "current design philosophy"?
**A:** Layout & structure + light theme; "I just want concepts of different ideas that could be used to determine the improvements that need to be made."
**Ambiguity:** 32%

### Round 4 (Contrarian)
**Q:** What if no single concept wins — wholesale winner, per-axis mix, or shortlist-then-refine?
**A:** Per-axis mix.
**Ambiguity:** 25%

### Round 5
**Q:** What counts as "done" for implementation — home screenshot first, route-by-route, or hands-off?
**A:** Home screenshot first, then staff-wide rollout against existing gates.
**Ambiguity:** 15.5% — threshold met.
</details>
