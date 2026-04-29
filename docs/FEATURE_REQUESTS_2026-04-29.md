# MatFlow — Feature Requests & Bug Reports (2026-04-29)

Captured from a single owner walkthrough of the production deployment. Items grouped by surface, severity-tagged, with cross-references to existing docs where the work overlaps.

Severity legend:
- **P0** = launch-blocking bug or security issue
- **P1** = clear user-facing bug or important missing feature
- **P2** = product feature / UX improvement
- **P3** = polish / nice-to-have

---

## Login & sign-in flow

### LOGIN-1 — Club logo + colour scheme should appear after club code  *(P1 — bug)*
After typing the club code (e.g. `totalbjj`), the next step (email/password) should already render with the gym's logo at the top and the gym's primary/secondary colours applied. Currently the login screen stays on MatFlow's default dark theme until you actually log in.

**Likely fix:** in [app/login/page.tsx](app/login/page.tsx) `GymCodeStep.onSuccess`, save the returned branding (logoUrl, primaryColor, secondaryColor, textColor) into local state and pass to `LoginStep` (the password step) for header rendering.

### LOGIN-2 — Sign-in speed  *(P2)*
"Sign-in should be very quick." Likely points at the bcrypt cost factor (12, ~250ms on bcryptjs pure-JS) and the multi-roundtrip flow (POST /api/tenant/{slug} → POST credentials → page navigation). Investigate:
- Switch to native `bcrypt` package (3× faster) — already in audit P3 backlog.
- Cache club-code lookup so it doesn't refetch on remount.
- Pre-warm the credentials endpoint.

### LOGIN-3 — "Sign in with email code"  *(P2 — feature)*
Already on the todo list as **WP1 magic-link login**. Schema (`MagicLinkToken`) was added in commit `e9a8756`; endpoints + UI mode not yet built. The token + email path goes through Resend, so this also depends on `RESEND_API_KEY` being set.

### LOGIN-4 — Multiple accounts logged in simultaneously  *(P2)*
A staff member should be able to log in to two different gyms in two different browser tabs at once. NextAuth uses a single cookie name per origin, so two sessions on the same origin overwrite each other. Options:
- Use a different cookie name per session via Profiles (lighter — adds session-name suffix).
- Browser profiles / incognito (no code change needed; user education).

### LOGIN-5 — Owner & member sign-in pages must be separate  *(P1 — security & UX)*
> "There should be a place where I can get the club's sign in page — see how TeamUp does login page, as it shouldn't have any connection to the owners page, and the owners page should be completely restricted to that owner, there should be no cache and cookie exploits."

Two interpretations:
1. **Visual separation:** member login at `/checkin/{slug}` or `/m/{slug}` looks branded for the gym, doesn't expose `/login` route prominently (which can lead anyone to the owner login).
2. **Cookie isolation:** the owner session cookie shouldn't survive into a member context. Right now both share `__Host-authjs.csrf-token`. Fix: separate cookie names via NextAuth callback, or use subdomains per role.

This is a meaningful security ask — flag for review.

---

## Member portal

### MEM-1 — Billing & payment should be at the bottom of member pages, owner-controlled  *(P1)*
Already in todo list as **`Tenant.memberSelfBilling` flag**. Per saved memory: billing is owner-managed by default. The flag should:
- Default `false` → member sees only contact info (link or email) for billing/cancellation
- Set to `true` → member sees Stripe Customer Portal link and can self-manage

Settings should add: `Tenant.billingContactEmail`, `Tenant.billingContactUrl`, plus the `memberSelfBilling` toggle.

### MEM-2 — Privacy policy should reference the owner  *(P1)*
> "The privacy policy links take it to the site and the owner, it should have a properly written message with a link to the owner's site saying they are responsible for etc, the club owner is responsible."

The current `/legal/privacy` page is MatFlow-generic. Update to clearly state:
- The gym (`{tenantName}`) is the data controller for member data
- MatFlow is the data processor (sub-processor list at `/legal/subprocessors`)
- Each gym's own privacy / refund / cancellation contact details

Probably wants a `Tenant.privacyContactEmail` and `Tenant.privacyPolicyUrl` so owners can link to their own page or rely on MatFlow's template.

### MEM-3 — Sub-accounts (kids/dependents) should not have delete X  *(P1)*
> "I shouldn't be able to just delete a child of an account, remove x's. I should just be able to click and open a sub-account detail under my account and access their page where I can see their stats and etc."

Currently the member portal lets a parent delete a linked child account. Should be:
- Click child name → open child's profile (read-only or limited-write)
- Show child's stats, attendance, rank progression
- No delete affordance; ask for email change instead

### MEM-4 — Remove "Add child" button  *(P1)*
> "Add child should be removed, they would have to request a change like that by email I think."

Replace the in-app "Add Child" button with a "Need to add a child? Email {gymContactEmail}" link.

### MEM-5 — Class detail card on home page click  *(P2 — feature)*
> "When I click on a class on the home page it should pull up a hero card with info on that class — e.g. how many people signed up — and an option to sign in."

A modal/sheet that opens on tapping a class card on `/member/home`. Shows: class name, time, coach, location, capacity, currently booked count, member's own attendance status, "Check in" button (if within check-in window).

### MEM-6 — Member stats page  *(P2 — feature)*
> "Have a stats page with info like 'you've been to X classes this year' and info of your favourite class etc."

Already exists at `/member/progress` (attendance + streak). Could be enhanced with:
- Favourite class (most-attended)
- Class-type breakdown (Gi vs No-Gi, beginner vs advanced)
- Belt-progression timeline
- Year-over-year comparison

### MEM-7 — Announcements should open when clicked  *(P1 — bug)*
Currently announcements show a card but tapping doesn't expand. Add an open/expand interaction so the full text + image is readable on a small screen.

### MEM-8 — Hyperlinks should work in announcements  *(P1 — bug)*
Pasting a URL into an announcement currently renders as plain text. Fix: detect URLs in the rendering layer (regex) and convert to `<a>` tags, OR support markdown rendering (e.g. `react-markdown` with a strict plugin allowlist).

### MEM-9 — Auto-show announcements on login  *(P2)*
Show unread announcements modally / as a banner the first time the member opens `/member/home` after a new announcement is posted. Track `Member.lastAnnouncementSeenAt` to know what's new.

### MEM-10 — Light/dark mode text contrast on payment history  *(P1 — bug)*
> "Text under payment history is white, the site should be able to understand how to deal with different colours when it's on light and dark mode."

The MemberProfile.tsx payment list uses hardcoded white text. Audit P3 already lists CSS variable usage as a polish item, but this specific instance is breaking on light-mode tenants. Use `var(--member-text)` not `#ffffff`.

### MEM-11 — Club social-media + website hero card  *(P2 — feature)*
Settings should let owners add: Instagram, Facebook, TikTok, YouTube, Twitter/X, website. On the member profile, the gym name should be tappable → opens a hero card with all the gym's links and contact info.

Schema additions: `Tenant.instagramUrl`, `Tenant.facebookUrl`, `Tenant.tiktokUrl`, `Tenant.youtubeUrl`, `Tenant.twitterUrl`, `Tenant.websiteUrl` (or a single `socials` JSON field).

### MEM-12 — Payment history at bottom + accuracy  *(P1)*
Move payment history to the bottom of `/member/profile`. Ensure it shows real data from `Payment` table — not placeholder demo state. (Owner-side member detail already uses real data per US-008; member-side likely reads from `/api/member/me/payments`.)

---

## Member onboarding

### ONB-1 — First-time signup data  *(P1 — feature)*
> "When people sign up, they should give their name, email, birthday, emergency contact, phone number, and they should sign the waiver — this should be the most important stuff."

The current 7-step modal collects: belt, classes, style, heard-from, has-kids, emergency contact, medical, DOB, waiver. Steps 1–5 (belt, classes, style, heard-from, has-kids) **don't currently persist to DB** — flagged in earlier session. Restructure to:

1. Name, email (already from invite), birthday, phone, emergency contact — REQUIRED, persisted
2. Waiver (typed name + drawn signature) — REQUIRED, persisted
3. Optional: belt, style, classes-of-interest

Drop the prompts that don't deliver value (e.g. "do you have kids" — should be inferred from membership tier).

### ONB-2 — Standalone waiver page  *(P1 — feature)*
> "There should also be a just waiver page that once the person logs in they sign the waiver + there should also be an option for the admin to bypass this and create a link that's data gets saved to the person's account so the admin can open up a device."

Two parts, both already on the todo list:
1. **Standalone waiver page** for members who already onboarded but haven't signed the waiver (e.g. waiver was added later). New route `/member/waiver`.
2. **Admin-supervised waiver flow** — already tracked as **WP3** in todo list. Owner clicks "Open waiver on this device" on a member's profile, hands the iPad to the member, they sign there. Same `SignaturePad` component. Records `collectedBy = "admin_device:{userId}"`.

### ONB-3 — Owner first-login wizard expansion  *(P1)*
> "When the owner logs in for the first time it should open up the necessary forms asking the owner all necessary info — what membership options they want, club info, emails, socials, timetable, logo etc."

The 6-step `OwnerOnboardingWizard` already exists at `/onboarding`. Expand to capture:
- Membership tiers (currently happens later in Settings)
- Billing contact email + URL (MEM-1)
- Social links (MEM-11)
- Timetable preview (already step 4)

Make it harder to skip — currently the wizard can be dismissed. Should require completion before `/dashboard` is reachable.

---

## Owner dashboard & owner-side bugs

### OWN-1 — Owner To-Do should remove completed items  *(P1 — bug)*
> "Under the owner's site under to do, for overdue payments it shouldn't still be on the to do — it should be done, and not appear. To do should be empty if all is done."

The To-Do drawer counts come from server-side aggregations (`stats.paymentsDue`, `stats.waiverMissing`, etc.). When a payment is marked paid, the count should drop to 0 on the next dashboard reload — currently does, but the **list still shows the line item even at count 0**.

Fix: in `DashboardStats.tsx`, filter `todoItems` to only include rows where `count > 0`. If all four are zero, show an empty-state ("All caught up!") instead of the to-do panel.

### OWN-2 — Owner To-Do should open its own card / walkthrough  *(P1)*
> "Should open its own card where the owner can go through and ensure everything is dealt with."

The drawer (added in `f36d091`) is a good start. Each item in the drawer should also be clickable to drill INTO that specific issue:
- "5 missing waivers" → expands inline to show which 5 members → "Send waiver link to all" button
- "3 overdue payments" → list of names + "Mark paid" inline buttons
- etc.

### OWN-3 — Admin can change membership tier  *(P1 — feature)*
> "On admin page I should be able to change people's membership if I need to and there should be a page where I can define all memberships."

Membership tiers are currently free-text on `Member.membershipType`. Two changes:
1. New page `/dashboard/memberships` (or Settings → Memberships tab) where the owner defines tiers (name, price, currency, billing cycle, includes).
2. On `/dashboard/members/[id]`, the membership-tier dropdown becomes a real selector backed by the tier list.

This also feeds into the kids tag (MEM-13).

### OWN-4 — Kids tag on memberships  *(P2)*
A boolean `MembershipTier.isKids` so kids' classes auto-filter to under-18 members and the right tier. Also surfaces a "Kids" filter on the members list.

### OWN-5 — Belt-level + course gating  *(P1 — feature)*
> "Tag on level — e.g. in this club there will be white belts and white belts in the beginner course, and so when someone becomes a normal white belt they should not see the beginner course info, and neither should members above."

Each `Class` should have a `requiredRank` AND a `maxRank` (or `level: "beginner" | "intermediate" | "advanced"`). When a member's current rank is above the `maxRank`, they don't see that class on `/member/schedule` or `/member/home`.

`Class.requiredRankId` already exists — add `Class.maxRankId` and filter logic in `/api/member/classes`.

### OWN-6 — Coaches see classes they teach  *(P1 — feature)*
> "Coaches should be able to see what classes they are teaching if explicitly put."

`Class.coachName` is currently a free-text string. To wire this:
1. Add `Class.coachUserId` (FK to `User`)
2. `/dashboard/coach` filters `where: { coachUserId: session.user.id }` for coach-role users
3. Coaches can be assigned via the timetable manager

### OWN-7 — Belt promotion notifications removed  *(P1 — bug / scope removal)*
> "Remove belt promotion notifications."

Find any `Notification` writes triggered by belt promotion and remove them. The promotion event should still fire an email (OWN-8) — just remove the in-app notification.

### OWN-8 — Promotion emails on belt + course promotion  *(P2 — feature)*
When `MemberRank` is created or updated to a higher rank, OR when a member moves from beginner course to a more advanced one, send an email via Resend ("Congrats on your promotion to {rankName}!"). New email template in `lib/email.ts`.

### OWN-9 — Rank promotion section text invisible behind white box  *(P1 — bug)*
> "For the assign/promote rank section the text is not visible behind the white box. It should be visible when I'm looking at the options section."

Look at `MemberProfile.tsx` rank-assignment drawer. Likely a hardcoded `text-white` on a white-bg dropdown. Use the same theme-aware variables as the rest of the app.

---

## QR check-in / standalone club sign-in page

### CHECKIN-1 — Standalone, themed, auto-updating  *(P1 — feature)*
> "When I get a link it should be on its own separate area that and this can be on an iPad or a device so people can log in like this https://matflow-nine.vercel.app/checkin/totalbjj. This page should update with time and not need to be refreshed and it should accurately work + have no connection to the actual owners page."

The route `/checkin/[slug]` already exists. Currently shows today's classes (after the recent fix). Improvements:
1. **No owner-session leakage** — page already works without auth (public). Confirm it also CLEARS any leaked owner cookies for this device (kiosk mode).
2. **Auto-updating** — poll every 30 seconds OR use SSE to refresh class status (starting soon / ongoing / past) without manual reload.
3. **Theming** — apply gym primary/secondary/text colours and logo at the top.
4. **Class status badges** — "Starting in 5 min", "Ongoing", "Ended", with the current/upcoming class auto-highlighted.
5. **Light/dark respect** — same as MEM-10, use CSS variables not hardcoded white.

### CHECKIN-2 — Sign-in must be quick  *(P2)*
Already covered in LOGIN-2.

---

## Cross-cutting infrastructure

### INFRA-1 — Light/dark mode contrast  *(P2)*
Multiple references to white text breaking on light mode (MEM-10, OWN-9). Bigger underlying issue: the codebase has hardcoded `#ffffff`, `text-white`, `rgba(255,255,255,…)` in many places. The audit's WP-G has a partial fix queued but should expand.

### INFRA-2 — Light/dark mode auto-detect  *(P3)*
Mentioned earlier in this session: owner-selectable light/dark per tenant, possibly auto-follow OS preference. Combined with INFRA-1.

### INFRA-3 — Multi-account logins  *(P2)*
LOGIN-4 covered above.

### INFRA-4 — Cache/cookie exploit hardening  *(P1 — security)*
LOGIN-5 raised this. Specifically check:
- Owner-only routes have `Cache-Control: private, no-store` headers (audit S-3 in PRODUCTION_QA_AUDIT.md).
- Cookies are scoped properly between owner / member roles.
- Logout clears all session data (logout-all already works).

---

## Cross-references to existing docs / todos

| Item | Existing reference |
|---|---|
| LOGIN-3 magic-link | TODO #7 — WP1 magic-link login |
| ONB-2 supervised waiver | TODO #8 — WP3 supervised waiver flow |
| MEM-1 billing visibility | TODO #9 — Tenant.memberSelfBilling flag (saved project memory) |
| OWN-7 belt notifications | NEW — not yet in todos |
| OWN-8 promotion emails | NEW |
| OWN-3 membership tiers | NEW |
| OWN-5 course gating | NEW |
| OWN-6 coach assignment | NEW |
| MEM-11 club socials | NEW |
| MEM-7/8/9 announcement UX | NEW |
| MEM-3/4 sub-account UX | NEW |
| CHECKIN-1 standalone kiosk | NEW |
| INFRA-1 light/dark mode | Audit P3 backlog WP-G partial |

---

## Suggested priority order for next sprint

If we could do ~10 items in a focused sprint, this is the order I'd recommend:

1. **OWN-1** Owner To-Do empty when count=0 (5-line fix)
2. **OWN-9** Rank-promote text visibility (CSS fix)
3. **MEM-10** Payment-history light-mode contrast (CSS fix)
4. **OWN-7** Remove belt-promotion notifications (deletion)
5. **MEM-8** Hyperlinks in announcements (~half day)
6. **MEM-7** Announcements open card on click (~half day)
7. **LOGIN-1** Logo + colours after club code (~1 hour)
8. **OWN-3** Membership tiers page + selector (~1 day)
9. **MEM-1 + MEM-2** Billing visibility flag + privacy contact (~1 day)
10. **CHECKIN-1** Standalone themed kiosk page (~1 day)

That's about a week of focused work and addresses every P0/P1 cosmetic + experience bug you raised. Items in P2 (magic-link, supervised waiver, course-gating, social cards, stats expansion) can follow.
