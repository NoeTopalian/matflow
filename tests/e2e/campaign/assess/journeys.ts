// The journey manifest — the spine of the break-the-system loop (plan PART X-12 §4.1).
//
// One row per journey a club or a member can take. `primaryRole` is who Lane A0
// drives it as, once, on a fresh club; every other role is a cell for the lane
// that owns the journey's group: ALLOWED cells are driven through the UI and
// proven by a row, REFUSED cells at the API and proven by status, body and an
// unchanged count, N/A only where the role has neither a screen nor a route.
// Routes are `app/api/**` paths without the `/api` prefix, with the verb where
// it matters. Lanes may extend a row (a missed route, a corrected role) but
// must say so in their report — never contradict the manifest silently.

export type Role =
  | "owner"
  | "manager"
  | "coach"
  | "admin"
  | "member"
  | "parent"
  | "child"
  | "anonymous"
  | "kiosk"
  | "operator";

export const ROLES: readonly Role[] = [
  "owner", "manager", "coach", "admin", "member", "parent", "child", "anonymous", "kiosk", "operator",
] as const;

export type Group = "L-A" | "L-B" | "L-C" | "L-D" | "L-E" | "L-F" | "L-G";

export type Journey = {
  id: string;
  name: string;
  group: Group;
  primaryRole: Role;
  /** Roles that may perform the journey (driven through the UI as ALLOWED cells). */
  allowed: readonly Role[];
  /** Roles with neither a screen nor a route to reach it; everything else not allowed is REFUSED. */
  na?: readonly Role[];
  /** `VERB path` under /api, or a page path starting with `/`. */
  routes: readonly string[];
  note?: string;
};

const STAFF: readonly Role[] = ["owner", "manager", "coach", "admin"];
const OM: readonly Role[] = ["owner", "manager"];
const ACCOUNTS: readonly Role[] = ["owner", "manager", "coach", "admin", "member", "parent"];
const NOT_TENANT: readonly Role[] = ["child", "kiosk", "operator"];

export const JOURNEYS: readonly Journey[] = [
  // ── Admission and identity (L-A) ──────────────────────────────────────────
  { id: "J01", name: "Apply as a new club", group: "L-A", primaryRole: "anonymous", allowed: ["anonymous"], na: [...ACCOUNTS, ...NOT_TENANT], routes: ["POST apply", "/apply"] },
  { id: "J02", name: "Approve or reject an application", group: "L-A", primaryRole: "operator", allowed: ["operator"], na: ["child", "kiosk"], routes: ["GET admin/applications", "POST admin/applications/[id]/approve", "POST admin/applications/[id]/reject", "POST admin/create-tenant"] },
  { id: "J03", name: "Owner activation link to password", group: "L-A", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["GET magic-link/verify", "/onboarding"], note: "first_time_signup token from the approve response; the row stores only tokenHash" },
  { id: "J04", name: "Password login, lockout at ten, owner unlock", group: "L-A", primaryRole: "owner", allowed: ACCOUNTS, na: ["child", "kiosk"], routes: ["POST auth/[...nextauth]", "POST members/[id]/unlock", "POST auth/staff-unlock/[id]", "/login"], note: "member unlock is owner/manager; staff unlock is owner-only; a lockout is not a 429" },
  { id: "J05", name: "Magic-link request and verify", group: "L-A", primaryRole: "member", allowed: ACCOUNTS, na: ["child", "kiosk", "operator"], routes: ["POST magic-link/request", "GET magic-link/verify"], note: "verify filters purpose since b5d189f; a token is host-independent" },
  { id: "J06", name: "Google callback at the route", group: "L-A", primaryRole: "owner", allowed: ["owner", "member"], na: [...NOT_TENANT, "anonymous"], routes: ["GET auth/[...nextauth]", "POST account/pending-tenant"] },
  { id: "J07", name: "Forgot and reset password", group: "L-A", primaryRole: "owner", allowed: ACCOUNTS, na: ["child", "kiosk", "operator"], routes: ["POST auth/forgot-password", "POST auth/reset-password"], note: "PasswordResetToken, not MagicLinkToken" },
  { id: "J08", name: "2FA enrol, TOTP login, recovery code", group: "L-A", primaryRole: "owner", allowed: ACCOUNTS, na: ["child", "kiosk", "operator"], routes: ["GET auth/totp/setup", "POST auth/totp/verify", "POST auth/totp/recover", "GET auth/totp/recovery-codes", "POST auth/totp/disable", "GET member/totp/setup", "POST member/totp/verify", "POST member/totp/recover", "GET member/totp/recovery-codes"] },
  { id: "J09", name: "Sign out everywhere; removed staff cookie refused", group: "L-A", primaryRole: "owner", allowed: ACCOUNTS, na: ["child", "kiosk", "operator"], routes: ["POST auth/logout-all", "GET auth/disown-login/[token]", "DELETE staff/[id]"] },
  { id: "J10", name: "Tenant states across every door", group: "L-A", primaryRole: "operator", allowed: ["operator"], routes: ["POST admin/customers/[id]/suspend", "POST admin/customers/[id]/soft-delete", "POST auth/[...nextauth]", "GET magic-link/verify", "GET kiosk/[token]/members", "POST kiosk/[token]/checkin", "POST waiver/kiosk-request", "POST stripe/webhook", "GET tenant/[slug]"], note: "throwaway tenant only; the kiosk is not admission-gated today" },

  // ── Club setup and staff (L-B) ────────────────────────────────────────────
  { id: "J11", name: "Onboarding wizard end to end", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["PATCH settings", "POST classes", "POST ranks", "POST onboarding/csv-handoff", "GET auth/totp/setup", "POST owner/reset-onboarding", "/onboarding"], note: "nine gated steps; waiver, kiosk and tiers are not wizard steps" },
  { id: "J12", name: "Branding save and reload; stubbed 500 honest", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["GET settings", "PATCH settings", "/dashboard/settings"], note: "clear localStorage gym-settings before every reload" },
  { id: "J13", name: "Kiosk enable and rotate", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["GET settings/kiosk", "POST settings/kiosk", "DELETE settings/kiosk"], note: "rotate a throwaway tenant only" },
  { id: "J14", name: "Waiver text adult and parent to the kiosk gate", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["PATCH settings", "GET waiver", "GET waiver/kiosk-status"] },
  { id: "J15", name: "Payment rail, memberSelfBilling, currency", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["PATCH settings", "GET member/shop-config", "GET me/gym"] },
  { id: "J16", name: "Tenant timezone honoured by Register and the check-in window", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["PATCH settings", "GET coach/today", "POST checkin"] },
  { id: "J17", name: "Add manager, coach, admin with typed passwords", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["GET staff", "POST staff", "GET staff/assignable"], note: "assert SELECT role equals what was typed; admin is the schema default" },
  { id: "J18", name: "Nav, page gate and API agree for every route", group: "L-B", primaryRole: "owner", allowed: STAFF, na: ["child", "kiosk", "operator"], routes: ["/dashboard", "/dashboard/timetable", "/dashboard/checkin", "/dashboard/members", "/dashboard/attendance", "/dashboard/ranks", "/dashboard/promotions", "/dashboard/notifications", "/dashboard/reports", "/dashboard/memberships", "/dashboard/payments", "/dashboard/analysis", "/dashboard/settings"], note: "/dashboard/payments is a known nav-vs-gate disagreement (routes.ts:57 vs payments/page.tsx:22)" },
  { id: "J19", name: "Remove staff; owner cannot remove self; staff mutation is owner-only", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["PATCH staff/[id]", "DELETE staff/[id]"] },
  { id: "J20", name: "Transfer ownership", group: "L-B", primaryRole: "operator", allowed: ["operator"], na: ["child", "kiosk"], routes: ["POST admin/customers/[id]/transfer-ownership"] },
  { id: "J21", name: "Impersonate with attribution on every audit row", group: "L-B", primaryRole: "operator", allowed: ["operator"], na: ["child", "kiosk"], routes: ["POST admin/impersonate", "DELETE admin/impersonate", "GET audit-log"], note: "metadata->>'actingAs' holds an Operator.id; only app/api/admin/** sites pass it today" },

  // ── Members (L-C) ─────────────────────────────────────────────────────────
  { id: "J22", name: "Add, edit, search members; counts agree", group: "L-C", primaryRole: "owner", allowed: STAFF, na: ["child", "kiosk", "operator"], routes: ["GET members", "POST members", "GET members/[id]", "PATCH members/[id]", "DELETE members/[id]", "/dashboard/members"], note: "write allow-lists per route; stale updatedAt → record 409 or last-write-wins" },
  { id: "J23", name: "Parent adds children from the portal", group: "L-C", primaryRole: "parent", allowed: ["parent"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST member/children", "GET member/me/children", "PATCH member/children/[id]", "POST members/[id]/link-child", "POST members/[id]/unlink-child"], note: "kids under 13, junior 13-17; one DOB exactly 13 today in the club zone" },
  { id: "J24", name: "CSV import preview then commit", group: "L-C", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST admin/import/upload", "POST admin/import/[id]/preview", "POST admin/import/[id]/commit", "GET admin/import/[id]"] },
  { id: "J25", name: "Bulk invite; accept invite; under-13 refusal", group: "L-C", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator"], routes: ["POST members/bulk-invite", "POST members/accept-invite", "/login/accept-invite"], note: "accept-invite is anonymous with a first_time_signup token" },
  { id: "J26", name: "Waiver link, anonymous signing, parent signs for a child", group: "L-C", primaryRole: "owner", allowed: [...STAFF, "member", "parent", "anonymous"], na: ["child", "kiosk", "operator"], routes: ["POST members/[id]/waiver-link", "GET waiver/open", "POST waiver/open", "POST waiver/sign", "POST waiver/sign-for-child", "POST members/[id]/waiver/sign", "GET waiver/[signedWaiverId]/signature", "POST waiver/kiosk-request", "GET waiver/kiosk-status"] },
  { id: "J27", name: "Photo upload served only through the blob proxy", group: "L-C", primaryRole: "owner", allowed: [...STAFF, "member", "parent"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST upload", "POST members/[id]/profile-picture", "POST members/[id]/photos", "GET blob-image", "POST upload/delete-orphan", "POST member/children/[id]/photos", "DELETE member/children/[id]/photos/[photoId]"] },
  { id: "J28", name: "Print the card sheet in every mode; tokens decode", group: "L-C", primaryRole: "owner", allowed: STAFF, na: ["child", "kiosk", "operator", "anonymous"], routes: ["/print/member-cards", "GET blob-image", "POST checkin/card"] },
  { id: "J29", name: "Revoke a card; reprint accepted", group: "L-C", primaryRole: "owner", allowed: STAFF, na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST members/[id]/card/revoke", "POST checkin/card"], note: "never a seeded member's card" },
  { id: "J30", name: "Profile pills, DSAR export, erase, cancel, rejoin, promote to adult", group: "L-C", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "anonymous"], routes: ["GET admin/dsar/export", "POST admin/dsar/erase", "PATCH members/[id]", "POST members/[id]/promote-to-adult", "GET members/promotion-alerts", "POST members/[id]/totp-reset"], note: "dsar routes are tenant-session routes despite the path" },

  // ── Timetable and attendance (L-D) ────────────────────────────────────────
  { id: "J31", name: "Create a class: minimum enforced, blanks saved, 56 days minted", group: "L-D", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST classes", "GET classes", "/dashboard/timetable"] },
  { id: "J32", name: "Edit a time (instances reconciled), archive, Generate", group: "L-D", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["PATCH classes/[id]", "DELETE classes/[id]", "POST classes/[id]/instances", "POST instances/generate"] },
  { id: "J33", name: "Cancel a session", group: "L-D", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST classes/[id]/instances", "PATCH classes/[id]/instances/[instanceId]", "GET coach/today"], note: "round 3: the writer landed. isCancelled had five readers and no writer, and the only trace of the intent was a dead cancelSchema. Owner and manager only; foreign instance is a bare 404; idempotent; un-cancel clears the reason. The register SHOWS a cancelled session struck through rather than hiding it" },
  { id: "J34", name: "Rank gate and comp-class roster; roster on create", group: "L-D", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET classes/[id]/roster", "POST classes/[id]/roster", "DELETE classes/[id]/roster/[memberId]", "POST checkin"] },
  { id: "J35", name: "Today's sessions exist on Register, now-first, preselected", group: "L-D", primaryRole: "coach", allowed: STAFF, na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET coach/today", "/dashboard/checkin"] },
  { id: "J36", name: "Tick names, walk-in, un-tick, credits restored, audit rows", group: "L-D", primaryRole: "coach", allowed: STAFF, na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST checkin", "DELETE checkin", "GET checkin/members", "GET coach/instances/[id]/register", "POST coach/instances/[id]/attendance"], note: "the hub marks through POST checkin; the coach attendance upsert is unattributed and used by no screen" },
  { id: "J37", name: "Scan cards: native and frame decoder, duplicate, revoked, other club", group: "L-D", primaryRole: "coach", allowed: STAFF, na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST checkin/card", "/dashboard/checkin?mode=scan"] },
  { id: "J38", name: "Kiosk: search without PII, tap, second tap, parent to child, waiver gate, token replay", group: "L-D", primaryRole: "kiosk", allowed: ["kiosk"], na: ["operator"], routes: ["GET kiosk/[token]/members", "GET kiosk/[token]/classes", "POST kiosk/[token]/checkin", "POST waiver/kiosk-request", "GET waiver/kiosk-status", "/kiosk/[token]"], note: "harvest and replay kioskMemberToken; key-set allow-list; 768 px geometry" },
  { id: "J39", name: "Member self check-in: 402, 201 with a pack, 409, outside the window", group: "L-D", primaryRole: "member", allowed: ["member"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST checkin", "GET member/classes"] },
  { id: "J40", name: "Every attendance reader agrees", group: "L-D", primaryRole: "owner", allowed: [...STAFF, "member"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET dashboard/stats", "/dashboard/attendance", "/dashboard", "GET member/home", "GET member/me", "GET coach/instances/[id]/register"] },
  { id: "J41", name: "Coach on a phone: Register centre tab, every class, marks into another coach's class", group: "L-D", primaryRole: "coach", allowed: ["coach"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET coach/today", "POST checkin", "/dashboard/checkin", "/dashboard/scan", "/dashboard/coach"] },

  // ── Money on the pay-at-desk rail (L-E) ───────────────────────────────────
  { id: "J42", name: "Tier then cash: due date, outstanding, requestId once, comp, other needs notes", group: "L-E", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET memberships", "POST memberships", "PATCH memberships/[id]", "DELETE memberships/[id]", "PATCH members/[id]", "POST payments/manual", "GET payments/outstanding", "GET payments", "GET payments/desk-orders", "POST orders/[id]/mark-paid", "GET members/[id]/payments", "/dashboard/payments", "/dashboard/memberships"], note: "the payments hub is three tabs: outstanding, the desk-order queue, history" },
  { id: "J43", name: "Chase and export CSV", group: "L-E", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST payments/chase", "GET payments/export.csv"], note: "manager gets 200; ten exports an hour; chase answers 502 with no mail key" },
  { id: "J44", name: "Refund: cash refused honestly; Stripe pack credits per lib/pack-refund", group: "L-E", primaryRole: "owner", allowed: ["owner"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST payments/[id]/refund", "POST stripe/webhook"], note: "the double revocation on the webhook echo is an ERROR (X-7 Task 4)" },
  { id: "J45", name: "Class pack: create, sell, redeem, refund, kiosk refuses refunded", group: "L-E", primaryRole: "owner", allowed: ["owner", "member", "kiosk"], na: ["child", "operator", "anonymous"], routes: ["GET class-packs", "POST class-packs", "PATCH class-packs/[id]", "DELETE class-packs/[id]", "GET member/class-packs", "POST member/class-packs/buy", "POST member/checkout", "POST stripe/webhook", "POST kiosk/[token]/checkin", "POST payments/[id]/refund"], note: "idempotency is the StripeEvent table" },
  { id: "J46", name: "The signed Stripe webhooks and the dispute lifecycle", group: "L-E", primaryRole: "anonymous", allowed: ["anonymous"], na: [...ACCOUNTS, ...NOT_TENANT], routes: ["POST stripe/webhook", "GET cron/stripe-reconcile"], note: "signed payloads only; an unsigned POST is 400" },
  { id: "J47", name: "memberSelfBilling off refuses subscriptions, the shop and pack purchase", group: "L-E", primaryRole: "member", allowed: ["member", "parent"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST member/subscriptions/start", "POST member/subscriptions/cancel", "POST member/subscriptions/start-for-kid", "POST member/subscriptions/cancel-for-kid", "GET stripe/portal", "GET me/gym", "POST member/checkout", "POST member/class-packs/buy"], note: "X-6 G-26 says the shop and pack purchase do not honour it — record" },
  { id: "J48", name: "Subscribe surfaces honest when the rail is inert", group: "L-E", primaryRole: "owner", allowed: ["owner", "member"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST stripe/create-subscription", "GET stripe/subscription-plans", "POST members/[id]/payment-method", "POST payments/intent", "POST members/[id]/charge", "POST member/subscriptions/start", "GET stripe/connect", "GET stripe/connect/callback", "GET stripe/connect/health", "POST stripe/disconnect"] },

  // ── Member portal and month-end (L-F) ─────────────────────────────────────
  { id: "J49", name: "Schedule: book, cancel a booking, waitlist", group: "L-F", primaryRole: "member", allowed: ["member", "parent"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET member/schedule", "GET member/classes", "POST member/class-subscriptions/[classId]", "DELETE member/class-subscriptions/[classId]", "/member/schedule"], note: "ClassWaitlist has no writer — record" },
  { id: "J50", name: "Billing: subscribe, cancel, payment methods, honest when inert", group: "L-F", primaryRole: "member", allowed: ["member", "parent"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET member/me/subscriptions", "GET member/me/payments", "POST stripe/portal", "POST member/subscriptions/cancel", "/member/billing"], note: "stripe/portal exports POST only (route.ts:11) — was listed as GET (L-F round 1)" },
  { id: "J51", name: "Shop to a pay-at-desk order, settled from the payments hub", group: "L-F", primaryRole: "member", allowed: ["member", "owner"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET member/products", "GET member/shop-config", "POST member/checkout", "GET products", "POST products", "PATCH products/[id]", "DELETE products/[id]", "GET payments/desk-orders", "POST orders/[id]/mark-paid", "/member/shop"], note: "X-6 K13 closed in round 3: GET payments/desk-orders feeds the payments hub At-the-desk tab and mark-paid is wired to it. Settling does NOT mint a Payment row — the Stripe rail does, so the two rails still disagree" },
  { id: "J52", name: "Profile: own phone and photo; family: child, per-child billing, child on the kiosk", group: "L-F", primaryRole: "member", allowed: ["member", "parent"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET member/me", "PATCH member/me", "GET member/family/[id]/billing", "GET member/family/[id]/billing/portal", "PATCH member/children/[id]", "/member/profile", "/member/family/[childId]"] },
  { id: "J53", name: "Progress, actions list, announcements seen and expired", group: "L-F", primaryRole: "member", allowed: ["member", "parent"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET member/tasks", "POST member/tasks/[id]/complete", "POST member/me/mark-announcements-seen", "GET member/me/recent-demotion", "/member/progress", "/member/actions"] },
  { id: "J54", name: "Every member page on desktop and at 390 px; a stubbed 500 is never an empty state", group: "L-F", primaryRole: "member", allowed: ["member", "parent"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["/member/home", "/member/schedule", "/member/billing", "/member/profile", "/member/progress", "/member/shop", "/member/actions", "/member/family/[childId]", "GET member/home"] },
  { id: "J55", name: "Reports: two numbers by SQL; a stubbed 500 is an error, never zeros", group: "L-F", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET reports", "POST reports/generate", "GET revenue/summary", "GET audit-log", "/dashboard/reports", "/dashboard/analysis"], note: "revenue/summary is owner-only by design" },
  { id: "J56", name: "Promotion candidates; award and demote; the belt on the card", group: "L-F", primaryRole: "owner", allowed: ["owner", "manager", "coach"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET promotions/candidates", "POST members/[id]/rank", "POST members/[id]/rank/demote", "GET ranks", "POST ranks", "PATCH ranks/[id]", "DELETE ranks/[id]", "/dashboard/ranks", "/dashboard/promotions"], note: "promote and demote share STAFF_ROLES (members/[id]/rank/route.ts:63, rank/demote/route.ts:24) — the W4 'disjoint allow-lists' finding is stale (L-F round 1)" },
  { id: "J57", name: "Dashboard action list tick and un-tick", group: "L-F", primaryRole: "owner", allowed: STAFF, na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET tasks", "POST tasks", "POST tasks/[id]/complete", "/dashboard"] },
  { id: "J58", name: "Post an announcement to member home; expire it", group: "L-F", primaryRole: "owner", allowed: OM, na: ["child", "kiosk", "operator", "anonymous"], routes: ["GET announcements", "POST announcements", "PATCH announcements/[id]", "DELETE announcements/[id]", "/dashboard/notifications", "GET member/home"] },
  { id: "J59", name: "Push and notifications: advertised against delivered", group: "L-F", primaryRole: "owner", allowed: ["owner", "member"], na: ["child", "kiosk", "operator", "anonymous"], routes: ["POST push/subscribe", "/dashboard/notifications"], note: "push delivery is not live; an advertised unreachable feature is an ERROR" },

  // ── Operator and machines (L-G) ───────────────────────────────────────────
  { id: "J60", name: "Operator: login, tenants, the nine customer mutations with CSRF, reset effects", group: "L-G", primaryRole: "operator", allowed: ["operator"], na: ["child", "kiosk"], routes: ["POST admin/auth/login", "POST admin/auth/logout", "POST admin/auth/operator-login", "POST admin/auth/operator-totp", "POST admin/auth/operator-totp/setup", "GET admin/activity", "POST admin/email/test", "POST admin/customers/[id]/force-password-reset", "POST admin/customers/[id]/totp-reset", "POST admin/customers/[id]/member-totp-reset", "POST admin/customers/[id]/suspend", "POST admin/customers/[id]/soft-delete", "POST admin/customers/[id]/transfer-ownership", "POST admin/create-tenant", "POST admin/impersonate", "DELETE admin/impersonate", "/admin"], note: "the x-admin-secret header is a second door with no identity; the cookie value is the secret. admin/email/test sits on this prefix but is gated by requireApiOwner — it is a TENANT-owner route, refused to the operator" },
  { id: "J61", name: "Crons and machine routes with the test bearer", group: "L-G", primaryRole: "anonymous", allowed: ["anonymous"], na: [...ACCOUNTS, ...NOT_TENANT], routes: ["GET cron/class-instances", "GET cron/retention", "GET cron/monthly-reports", "GET cron/stripe-reconcile", "GET health", "POST webhooks/resend", "GET tenant/[slug]"], note: "idempotent re-run; 503 without the secret; status derived from results" },

  // ── Added by the controller so every route file is owned ──────────────────
  { id: "J62", name: "Integrations and initiatives (Google Drive, dashboard initiatives)", group: "L-B", primaryRole: "owner", allowed: ["owner"], na: [...NOT_TENANT, "anonymous"], routes: ["GET drive/status", "GET drive/connect", "GET drive/callback", "POST drive/disconnect", "GET drive/folders", "POST drive/select-folder", "POST drive/index", "GET initiatives", "POST initiatives", "PATCH initiatives/[id]", "DELETE initiatives/[id]", "POST initiatives/[id]/attachments"], note: "the Drive OAuth cannot be driven without a live provider — the callback and status routes are asserted, the grant is UNCOVERED by name" },
];

export type CellKind = "ALLOWED" | "REFUSED" | "N/A";

export function cellsFor(j: Journey): { role: Role; kind: CellKind }[] {
  return ROLES.map((role) => ({
    role,
    kind: j.allowed.includes(role) ? "ALLOWED" : j.na?.includes(role) ? "N/A" : "REFUSED",
  }));
}

export function journeysFor(group: Group): Journey[] {
  return JOURNEYS.filter((j) => j.group === group);
}

/** Every distinct `app/api` path the manifest names, for the coverage tally against `find app/api -name route.ts`. */
export function apiPaths(): string[] {
  const out = new Set<string>();
  for (const j of JOURNEYS) for (const r of j.routes) if (!r.startsWith("/")) out.add(r.replace(/^[A-Z]+ /, ""));
  return [...out].sort();
}
