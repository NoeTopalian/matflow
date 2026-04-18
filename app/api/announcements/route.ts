import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";

export const createSchema = z.object({
  title:    z.string().min(1).max(120),
  body:     z.string().min(1).max(2000),
  imageUrl: z.string().url().optional().nullable(),
  pinned:   z.boolean().optional(),
});

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
  {
    id: "demo-ann-4",
    title: "Seminar: Bernardo Faria — Saturday 10am",
    body: "World champion Bernardo Faria is coming to Total BJJ this Saturday for a 2-hour seminar. Topics: over/under passing, back takes, and competition strategy. Don't miss it!",
    pinned: false,
    imageUrl: null,
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  },
  {
    id: "demo-ann-5",
    title: "Welcome to MatFlow!",
    body: "Your gym management platform is ready. Start by setting up your classes and inviting members.",
    pinned: false,
    imageUrl: null,
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  },
];

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const announcements = await prisma.announcement.findMany({
      where: { tenantId: session.user.tenantId },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      take: 50,
    });
    return NextResponse.json(announcements.length > 0 ? announcements : DEMO_ANNOUNCEMENTS);
  } catch {
    return NextResponse.json(DEMO_ANNOUNCEMENTS);
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canPost = ["owner", "manager"].includes(session.user.role);
  if (!canPost) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const announcement = await prisma.announcement.create({
      data: {
        tenantId: session.user.tenantId,
        title:    parsed.data.title,
        body:     parsed.data.body,
        imageUrl: parsed.data.imageUrl ?? null,
        pinned:   parsed.data.pinned   ?? false,
      },
    });
    return NextResponse.json(announcement, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create announcement" }, { status: 500 });
  }
}
