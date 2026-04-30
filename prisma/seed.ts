/**
 * Seed script — creates a fully-populated demo gym for development/testing.
 *
 * Run with:  npx prisma db seed
 * Or:        npx ts-node prisma/seed.ts
 *
 * Login after seeding:
 *   Club code:  totalbjj
 *   Email:      owner@totalbjj.com
 *   Password:   password123
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to seed");
}
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Seeding MatFlow database...\n");

  // ─── 1. Tenant ──────────────────────────────────────────────────────────────
  const tenant = await prisma.tenant.upsert({
    where: { slug: "totalbjj" },
    update: {},
    create: {
      name: "Total BJJ",
      slug: "totalbjj",
      primaryColor: "#3b82f6",
      secondaryColor: "#2563eb",
      textColor: "#ffffff",
      subscriptionStatus: "active",
      subscriptionTier: "pro",
    },
  });
  console.log(`✅ Tenant: ${tenant.name} (slug: ${tenant.slug})`);

  // ─── 2. Staff users ──────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash("password123", 12);

  const owner = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "owner@totalbjj.com" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "owner@totalbjj.com",
      passwordHash,
      name: "Noe Romero",
      role: "owner",
    },
  });
  console.log(`✅ Owner: ${owner.name} (${owner.email})`);

  const coach = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "coach@totalbjj.com" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "coach@totalbjj.com",
      passwordHash,
      name: "Coach Mike",
      role: "coach",
    },
  });
  console.log(`✅ Coach: ${coach.name} (${coach.email})`);

  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "admin@totalbjj.com" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "admin@totalbjj.com",
      passwordHash,
      name: "Sarah Admin",
      role: "admin",
    },
  });
  console.log(`✅ Admin: ${admin.name} (${admin.email})`);

  // ─── 3. Rank system (BJJ) ────────────────────────────────────────────────────
  const bjjBelts = [
    { name: "White Belt",  order: 0, color: "#e5e7eb", stripes: 4 },
    { name: "Blue Belt",   order: 1, color: "#3b82f6", stripes: 4 },
    { name: "Purple Belt", order: 2, color: "#8b5cf6", stripes: 4 },
    { name: "Brown Belt",  order: 3, color: "#92400e", stripes: 4 },
    { name: "Black Belt",  order: 4, color: "#111111", stripes: 6 },
  ];

  const rankMap: Record<string, string> = {};
  for (const belt of bjjBelts) {
    const rank = await prisma.rankSystem.upsert({
      where: { tenantId_discipline_order: { tenantId: tenant.id, discipline: "BJJ", order: belt.order } },
      update: {},
      create: {
        tenantId: tenant.id,
        discipline: "BJJ",
        name: belt.name,
        order: belt.order,
        color: belt.color,
        stripes: belt.stripes,
      },
    });
    rankMap[belt.name] = rank.id;
  }
  console.log("✅ BJJ rank system created (5 belts)");

  // ─── 4. Classes ──────────────────────────────────────────────────────────────
  const classData = [
    {
      name: "Fundamentals BJJ",
      coachName: "Coach Mike",
      location: "Mat 1",
      duration: 60,
      maxCapacity: 20,
      color: "#3b82f6",
      schedules: [{ dayOfWeek: 1, startTime: "09:30", endTime: "10:30" }, { dayOfWeek: 3, startTime: "09:30", endTime: "10:30" }],
    },
    {
      name: "No-Gi",
      coachName: "Coach Mike",
      location: "Mat 1",
      duration: 60,
      maxCapacity: 20,
      color: "#8b5cf6",
      schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }, { dayOfWeek: 4, startTime: "18:00", endTime: "19:00" }],
    },
    {
      name: "Beginner BJJ",
      coachName: "Sarah Admin",
      location: "Mat 1",
      duration: 60,
      maxCapacity: 16,
      color: "#22c55e",
      schedules: [{ dayOfWeek: 2, startTime: "10:00", endTime: "11:00" }, { dayOfWeek: 5, startTime: "10:00", endTime: "11:00" }],
    },
    {
      name: "Advanced BJJ",
      coachName: "Coach Mike",
      location: "Mat 1",
      duration: 75,
      maxCapacity: 18,
      color: "#ef4444",
      schedules: [{ dayOfWeek: 3, startTime: "19:00", endTime: "20:15" }],
    },
    {
      name: "Kids BJJ",
      coachName: "Sarah Admin",
      location: "Mat 2",
      duration: 45,
      maxCapacity: 12,
      color: "#f97316",
      schedules: [{ dayOfWeek: 3, startTime: "17:00", endTime: "17:45" }, { dayOfWeek: 6, startTime: "09:00", endTime: "09:45" }],
    },
    {
      name: "Open Mat",
      coachName: "Coach Mike",
      location: "Main Mat",
      duration: 120,
      maxCapacity: null,
      color: "#6b7280",
      schedules: [{ dayOfWeek: 5, startTime: "18:00", endTime: "20:00" }, { dayOfWeek: 6, startTime: "10:00", endTime: "12:00" }],
    },
  ];

  const classIds: Record<string, string> = {};
  for (const cls of classData) {
    const { schedules, ...rest } = cls;
    const created = await prisma.class.upsert({
      where: { id: `seed-${tenant.id}-${cls.name.replace(/\s/g, "")}` },
      update: {},
      create: {
        id: `seed-${tenant.id}-${cls.name.replace(/\s/g, "")}`,
        tenantId: tenant.id,
        ...rest,
        schedules: { create: schedules.map((s) => ({ ...s, startDate: new Date() })) },
      },
    });
    classIds[cls.name] = created.id;
  }
  console.log(`✅ ${classData.length} classes created`);

  // ─── 5. Generate class instances (60 days back + 4 weeks forward) ───────────
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const pastStart = new Date(today); pastStart.setDate(today.getDate() - 60);
  const endDate = new Date(today); endDate.setDate(today.getDate() + 28);

  const allClasses = await prisma.class.findMany({
    where: { tenantId: tenant.id, isActive: true },
    include: { schedules: { where: { isActive: true } } },
  });

  let instanceCount = 0;
  for (const cls of allClasses) {
    for (const sched of cls.schedules) {
      // Start from 60 days ago, walk forward to 4 weeks from now
      const current = new Date(pastStart);
      while (current.getDay() !== sched.dayOfWeek) current.setDate(current.getDate() + 1);
      while (current <= endDate) {
        await prisma.classInstance.upsert({
          where: {
            id: `inst-${cls.id}-${current.toISOString().split("T")[0]}-${sched.startTime}`,
          },
          update: {},
          create: {
            id: `inst-${cls.id}-${current.toISOString().split("T")[0]}-${sched.startTime}`,
            classId: cls.id,
            date: new Date(current),
            startTime: sched.startTime,
            endTime: sched.endTime,
          },
        });
        instanceCount++;
        current.setDate(current.getDate() + 7);
      }
    }
  }
  console.log(`✅ ${instanceCount} class instances generated (60d back + 4 weeks forward)`);

  // ─── 6. Members ──────────────────────────────────────────────────────────────
  const memberData = [
    { name: "Alex Johnson",    email: "alex@example.com",    membershipType: "Monthly Unlimited", beltName: "Blue Belt",   stripes: 3, daysAgo: 180 },
    { name: "Sam Williams",    email: "sam@example.com",     membershipType: "Monthly Unlimited", beltName: "White Belt",  stripes: 2, daysAgo: 150 },
    { name: "Jordan Lee",      email: "jordan@example.com",  membershipType: "Taster (1 week)",   beltName: "White Belt",  stripes: 0, daysAgo: 5   },
    { name: "Taylor Brown",    email: "taylor@example.com",  membershipType: "Annual",            beltName: "Purple Belt", stripes: 1, daysAgo: 400 },
    { name: "Chris Davis",     email: "chris@example.com",   membershipType: "Monthly Unlimited", beltName: "Blue Belt",   stripes: 0, daysAgo: 270 },
    { name: "Casey Martinez",  email: "casey@example.com",   membershipType: "Monthly Unlimited", beltName: "Blue Belt",   stripes: 2, daysAgo: 390 },
    { name: "Jamie Thomas",    email: "jamie@example.com",   membershipType: "Annual",            beltName: "Brown Belt",  stripes: 2, daysAgo: 730 },
    { name: "Dakota Walker",   email: "dakota@example.com",  membershipType: "Monthly Unlimited", beltName: "White Belt",  stripes: 2, daysAgo: 100 },
    { name: "Reese Hall",      email: "reese@example.com",   membershipType: "Complimentary",     beltName: "Black Belt",  stripes: 0, daysAgo: 2190 },
    { name: "Avery Clark",     email: "avery@example.com",   membershipType: "Monthly Unlimited", beltName: "Blue Belt",   stripes: 1, daysAgo: 120 },
    { name: "Morgan Wilson",   email: "morgan@example.com",  membershipType: "Taster (1 week)",   beltName: "White Belt",  stripes: 1, daysAgo: 7   },
    { name: "Drew Harris",     email: "drew@example.com",    membershipType: "Taster (2 weeks)",  beltName: "White Belt",  stripes: 0, daysAgo: 3   },
  ];

  let memberCount = 0;
  const memberIds: string[] = [];

  for (const m of memberData) {
    const joinedAt = new Date(); joinedAt.setDate(joinedAt.getDate() - m.daysAgo);
    const member = await prisma.member.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: m.email } },
      update: {},
      create: {
        tenantId: tenant.id,
        email: m.email,
        passwordHash,
        name: m.name,
        membershipType: m.membershipType,
        joinedAt,
      },
    });
    memberIds.push(member.id);

    // Assign rank
    if (rankMap[m.beltName]) {
      await prisma.memberRank.upsert({
        where: { memberId_rankSystemId: { memberId: member.id, rankSystemId: rankMap[m.beltName] } },
        update: { stripes: m.stripes },
        create: {
          memberId: member.id,
          rankSystemId: rankMap[m.beltName],
          stripes: m.stripes,
        },
      });
    }
    memberCount++;
  }
  console.log(`✅ ${memberCount} members created with ranks`);

  // ─── 7. Sample attendance (last 60 days) ─────────────────────────────────────
  const recentInstances = await prisma.classInstance.findMany({
    where: {
      class: { tenantId: tenant.id },
      date: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), lt: today },
    },
    take: 80,
    orderBy: { date: "desc" },
  });

  let attendanceCount = 0;
  for (const instance of recentInstances) {
    // Randomly check in 5-12 members per class
    const shuffled = [...memberIds].sort(() => Math.random() - 0.5);
    const attending = shuffled.slice(0, Math.floor(Math.random() * 8) + 5);
    for (const memberId of attending) {
      try {
        await prisma.attendanceRecord.upsert({
          where: { memberId_classInstanceId: { memberId, classInstanceId: instance.id } },
          update: {},
          create: {
            tenantId: tenant.id,
            memberId,
            classInstanceId: instance.id,
            checkInMethod: ["admin", "qr", "self"][Math.floor(Math.random() * 3)],
            checkInTime: new Date(instance.date.getTime() + parseInt(instance.startTime.split(":")[0]) * 3600000),
          },
        });
        attendanceCount++;
      } catch { /* skip duplicates */ }
    }
  }
  console.log(`✅ ${attendanceCount} attendance records created`);

  // ─── 8. Announcements ────────────────────────────────────────────────────────
  const announcements = [
    {
      id: `seed-ann-${tenant.id}-1`,
      title: "Welcome to MatFlow!",
      body: "Your gym management platform is ready. Start by setting up your classes and inviting members.",
      pinned: false,
    },
    {
      id: `seed-ann-${tenant.id}-2`,
      title: "Regional Championship — Register Now",
      body: "The regional BJJ championship is coming up next month. Spots are limited — register through the link below. All belts welcome. Let's represent Total BJJ on the podium!",
      pinned: true,
      imageUrl: "https://images.unsplash.com/photo-1555597673-b21d5c935865?w=600&q=80",
    },
    {
      id: `seed-ann-${tenant.id}-3`,
      title: "New No-Gi Class Starting Monday",
      body: "We're adding a No-Gi fundamentals class every Monday at 18:00. Perfect for grapplers looking to compete without the kimono. No experience needed.",
      pinned: false,
    },
    {
      id: `seed-ann-${tenant.id}-4`,
      title: "Holiday Closure — Dec 25–26",
      body: "The gym will be closed on Christmas Day and Boxing Day. Normal classes resume on the 27th. Enjoy the break and stay active!",
      pinned: false,
    },
    {
      id: `seed-ann-${tenant.id}-5`,
      title: "Seminar: Bernardo Faria — Saturday 10am",
      body: "World champion Bernardo Faria is coming to Total BJJ this Saturday for a 2-hour seminar. Topics: over/under passing, back takes, and competition strategy. Don't miss it!",
      pinned: false,
    },
    {
      id: `seed-ann-${tenant.id}-6`,
      title: "Founding Member Deal — 20% Off Annual Membership",
      body: "For a limited time, founding members can lock in an annual membership at 20% off. Speak to the front desk or email us to claim your discount before it expires.",
      pinned: false,
    },
  ];

  for (const ann of announcements) {
    await prisma.announcement.upsert({
      where: { id: ann.id },
      update: {},
      create: { tenantId: tenant.id, ...ann },
    });
  }
  console.log(`✅ ${announcements.length} announcements created`);

  // ─── 9. Store products (B9) ──────────────────────────────────────────────────
  // Backfills the legacy lib/products.ts catalogue into the per-tenant
  // Product table so the seeded gym has a working store on first run.
  const seedProducts = [
    { id: `seed-prod-${tenant.id}-tshirt`,    name: "Club T-Shirt",  pricePence: 2500, category: "clothing",  symbol: "👕", description: "100% cotton club T-shirt with embroidered logo",       inStock: true  },
    { id: `seed-prod-${tenant.id}-rashguard`, name: "Rashguard",     pricePence: 4000, category: "clothing",  symbol: "🥋", description: "Compression rashguard, short sleeve",                  inStock: true  },
    { id: `seed-prod-${tenant.id}-shake`,     name: "Protein Shake", pricePence:  400, category: "drink",     symbol: "🥤", description: "Post-training protein shake — vanilla or chocolate",   inStock: true  },
    { id: `seed-prod-${tenant.id}-bar`,       name: "Energy Bar",    pricePence:  200, category: "food",      symbol: "🍫", description: "High protein energy bar",                              inStock: false },
    { id: `seed-prod-${tenant.id}-mouth`,     name: "Mouth Guard",   pricePence: 1200, category: "equipment", symbol: "🦷", description: "Boil-and-bite mouth guard",                            inStock: true  },
    { id: `seed-prod-${tenant.id}-hoodie`,    name: "Club Hoodie",   pricePence: 4500, category: "clothing",  symbol: "🧥", description: "Premium club hoodie with back print",                  inStock: true  },
    { id: `seed-prod-${tenant.id}-tape`,      name: "Sports Tape",   pricePence:  500, category: "equipment", symbol: "🏥", description: "Athletic zinc oxide tape, 2.5cm",                      inStock: true  },
    { id: `seed-prod-${tenant.id}-bottle`,    name: "Water Bottle",  pricePence: 1500, category: "equipment", symbol: "💧", description: "1L stainless steel club water bottle",                inStock: true  },
  ];
  for (const p of seedProducts) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: {},
      create: { tenantId: tenant.id, ...p },
    });
  }
  console.log(`✅ ${seedProducts.length} store products seeded`);

  console.log("\n🎉 Seed complete!\n");
  console.log("─────────────────────────────────────────────────");
  console.log("  Login at: http://localhost:3000/login");
  console.log("  Club code:  totalbjj");
  console.log("  Owner:      owner@totalbjj.com / password123");
  console.log("  Coach:      coach@totalbjj.com / password123");
  console.log("  Admin:      admin@totalbjj.com / password123");
  console.log("  Member:     alex@example.com   / password123");
  console.log("  Member:     sam@example.com    / password123");
  console.log("─────────────────────────────────────────────────\n");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
