/**
 * GET /api/member/home?date=YYYY-MM-DD
 *
 * Audit Lane 4 A15: consolidates the member home screen's 4 mount-time
 * fetches (/api/member/me, /api/member/schedule?date=, /api/member/me/children
 * ?include=timetable, /api/announcements) into ONE serverless invocation and
 * ONE withTenantContext transaction. The four sub-payload shapes are exactly
 * the standalone routes' shapes — both sides call the same builders in
 * lib/member-home.ts, so they cannot drift.
 *
 * Response: { me, schedule, children, announcements }
 *   me            — /api/member/me GET shape (or null if the member row is gone)
 *   schedule      — /api/member/schedule GET array
 *   children      — /api/member/me/children?include=timetable GET array
 *   announcements — /api/announcements GET object ({ announcements: [...] })
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import {
  buildMemberMeData,
  buildMemberSchedule,
  buildMemberChildren,
  buildAnnouncementsData,
} from "@/lib/member-home";

// ─── Demo fallback (mirrors the standalone routes' demo constants — those live
// in route files, which may only export HTTP handlers, so they can't be
// imported here) ─────────────────────────────────────────────────────────────

const DEMO_ME = {
  id: "demo-member",
  name: "Alex Johnson",
  email: "alex@example.com",
  phone: null,
  membershipType: "Monthly",
  status: "active",
  joinedAt: "2025-09-01T00:00:00.000Z",
  primaryColor: "#3b82f6",
  onboardingCompleted: false,
  classReminders: true,
  beltPromotions: true,
  gymAnnouncements: true,
  belt: {
    name: "Blue Belt",
    color: "#3b82f6",
    stripes: 3,
    achievedAt: "2026-02-01T00:00:00.000Z",
    promotedBy: "Coach Mike",
  },
  rankTimeline: [],
  stats: {
    thisWeek: 3,
    thisMonth: 9,
    thisYear: 47,
    streakWeeks: 8,
    totalClasses: 47,
    attendanceByClass: [
      { id: "demo-c1", name: "Beginner BJJ", count: 18 },
      { id: "demo-c2", name: "No-Gi", count: 12 },
      { id: "demo-c3", name: "Open Mat", count: 9 },
    ],
    avgClassesPerWeek: 3.2,
  },
  nextClass: {
    id: "demo-inst-1",
    classId: "demo-c1",
    name: "Beginner BJJ",
    coach: "Coach Mike",
    location: "Mat 1",
    date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    startTime: "18:00",
    endTime: "19:00",
  },
};

const DEMO_CLASSES = [
  { id: "m1",  name: "Fundamentals BJJ", startTime: "09:30", endTime: "10:30", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 1, color: "#3b82f6" },
  { id: "m2",  name: "No-Gi",            startTime: "18:00", endTime: "19:00", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 1, color: "#8b5cf6" },
  { id: "m3",  name: "Open Mat",         startTime: "20:00", endTime: "21:30", coach: "Open",        location: "Main Mat", capacity: null, dayOfWeek: 1, color: "#10b981" },
  { id: "t1",  name: "Beginner BJJ",     startTime: "10:00", endTime: "11:00", coach: "Coach Sarah", location: "Mat 1",    capacity: 16, dayOfWeek: 2, color: "#3b82f6" },
  { id: "t2",  name: "Open Mat",         startTime: "12:00", endTime: "14:00", coach: "Coach Sarah", location: "Main Mat", capacity: null, dayOfWeek: 2, color: "#10b981" },
  { id: "w1",  name: "Kids BJJ",         startTime: "17:00", endTime: "17:45", coach: "Coach Emma",  location: "Mat 2",    capacity: 12, dayOfWeek: 3, color: "#f97316" },
  { id: "w2",  name: "Advanced BJJ",     startTime: "19:00", endTime: "20:15", coach: "Coach Mike",  location: "Mat 1",    capacity: 18, dayOfWeek: 3, color: "#ef4444" },
  { id: "th1", name: "No-Gi",            startTime: "18:00", endTime: "19:00", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 4, color: "#8b5cf6" },
  { id: "th2", name: "Beginners",        startTime: "19:15", endTime: "20:15", coach: "Coach Sarah", location: "Mat 2",    capacity: 14, dayOfWeek: 4, color: "#3b82f6" },
  { id: "f1",  name: "Beginner BJJ",     startTime: "10:00", endTime: "11:00", coach: "Coach Sarah", location: "Mat 1",    capacity: 16, dayOfWeek: 5, color: "#3b82f6" },
  { id: "f2",  name: "Open Mat",         startTime: "18:00", endTime: "20:00", coach: "Open",        location: "Main Mat", capacity: null, dayOfWeek: 5, color: "#10b981" },
  { id: "s1",  name: "Saturday Session", startTime: "10:00", endTime: "12:00", coach: "Coach Mike",  location: "Main Mat", capacity: 30, dayOfWeek: 6, color: "#0ea5e9" },
  { id: "s2",  name: "Kids BJJ",         startTime: "09:00", endTime: "09:45", coach: "Coach Emma",  location: "Mat 2",    capacity: 12, dayOfWeek: 6, color: "#f97316" },
];

const DEMO_ANNOUNCEMENTS = [
  {
    id: "demo-ann-1",
    title: "Regional Championship — Register Now",
    body: "The regional BJJ championship is coming up next month. Spots are limited — register through the link below. All belts welcome. Let's represent Total BJJ on the podium!",
    pinned: true,
    imageUrl: "https://images.unsplash.com/photo-1555597673-b21d5c935865?w=600&q=80",
    createdAt: new Date().toISOString(),
  },
  {
    id: "demo-ann-2",
    title: "New No-Gi Class Starting Monday",
    body: "We're adding a No-Gi fundamentals class every Monday at 18:00. Perfect for grapplers looking to compete without the kimono. No experience needed.",
    pinned: false,
    imageUrl: null,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: "demo-ann-3",
    title: "Holiday Closure — Dec 25–26",
    body: "The gym will be closed on Christmas Day and Boxing Day. Normal classes resume on the 27th. Enjoy the break and stay active!",
    pinned: false,
    imageUrl: null,
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  },
];

function demoHome(name?: string | null) {
  return {
    me: { ...DEMO_ME, name: name ?? DEMO_ME.name },
    schedule: DEMO_CLASSES,
    children: [],
    announcements: { announcements: DEMO_ANNOUNCEMENTS },
  };
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get("date"); // YYYY-MM-DD, optional

  const memberId = session.user.memberId as string | undefined;

  // Demo fallback — same semantics as /api/member/me.
  if (session.user.tenantId === "demo-tenant" || !memberId) {
    return NextResponse.json(demoHome(session.user.name));
  }

  try {
    const payload = await withTenantContext(session.user.tenantId, async (tx) => {
      const me = await buildMemberMeData(tx, {
        memberId,
        tenantId: session.user.tenantId,
        primaryColor: session.user.primaryColor ?? "#3b82f6",
      });
      const schedule = await buildMemberSchedule(tx, {
        tenantId: session.user.tenantId,
        memberId,
        dateParam,
      });
      const children = await buildMemberChildren(tx, {
        tenantId: session.user.tenantId,
        memberId,
        includeTimetable: true,
      });
      const announcements = await buildAnnouncementsData(tx, {
        tenantId: session.user.tenantId,
        role: session.user.role,
        memberId,
        take: 50,
      });
      return { me, schedule, children, announcements };
    });

    // no-store: the announcements sub-payload carries per-member `unseen`
    // flags that must not survive a mark-as-seen POST (matches the standalone
    // /api/announcements route).
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    // UI-RULES §7: an HTTP error is never an empty state — surface a real 500
    // so the client renders its retry banner instead of an empty gym.
    console.error("[member/home GET] DB error", e);
    return NextResponse.json({ error: "Failed to load home data" }, { status: 500 });
  }
}
