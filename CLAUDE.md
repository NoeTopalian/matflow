# CLAUDE.md — MatFlow

## Stack
Next.js 15 + TypeScript + Tailwind + shadcn/ui + Prisma + Neon Postgres + NextAuth v5. Multi-tenant. PWA via Serwist.

## Database

**Connection:** Neon Postgres. URL in `.env` as `DATABASE_URL`. Always pooled in production (`?pgbouncer=true&connection_limit=1`).

**Always use the singleton client.** Never `new PrismaClient()`.

```ts
import { prisma } from "@/lib/prisma";
```

**For tenant-scoped reads/writes**, use the RLS-aware wrapper. Postgres RLS policies (migration `20260503100000_rls_policies_foundation`) act as a backstop — the application-layer `where: { tenantId }` filter is still required.

```ts
import { withTenantContext } from "@/lib/prisma-tenant";

const ctx = await requireStaff();
const members = await withTenantContext(ctx.tenantId, (tx) =>
  tx.member.findMany({ where: { tenantId: ctx.tenantId } }),
);
```

**Inspecting the DB ad-hoc:**
- `npx prisma studio` — GUI browser, opens on :5555
- `npx prisma db pull --print` — confirm schema matches DB
- For raw SQL: use `prisma.$queryRaw` in a one-off script under `scripts/`, never psql against prod

**Schema changes:**
- Always `npx prisma migrate dev --name <change>` — never `db push` (it skips migration history)
- Migrations live in `prisma/migrations/`
- Run `npx prisma generate` after schema edits if the dev server doesn't pick it up

**Stale `prisma/dev.db`:** leftover from earlier SQLite phase. Ignore — provider is `postgresql`. Safe to delete if it bothers you.

## Reports

The reports feature is real and uses live DB data:

- API: `app/api/reports/route.ts` (GET, weeks param 4–24) and `app/api/reports/generate/route.ts`
- Data layer: `lib/reports.ts` exports `getReportsData(tenantId, { weeksBack })`
- UI: `app/dashboard/reports/page.tsx`
- Access: `owner` and `manager` roles only

When asked for analytics, gym stats, or "a report on X":
1. Query via `getReportsData` if the metric exists there — extend it rather than duplicate
2. For one-off analytics, query through `withTenantContext` so RLS applies
3. Never fabricate numbers — if the data isn't queryable, say so

## Multi-tenancy

Every model with tenant data carries `tenantId`. Every query that touches tenant data must filter on it. RLS is the backstop, not the primary defence — application-layer filters come first.

Auth helpers in `auth.ts` and `lib/authz.ts`:
- `requireSession()` — any authenticated user
- `requireStaff()` — owner or manager
- `requireOwner()` — owner only

## Conventions

- British English in user-facing copy
- Prefer editing existing files over creating new ones
- Keep new components in `components/` mirroring the route structure
- Tests live in `tests/{unit,integration}/` — Vitest
- Run before claiming done: `npm run lint && npm test && npm run build`

## Don't

- Don't `git add -A` — sensitive files exist in repo root
- Don't run migrations against production from local
- Don't bypass `withTenantContext` for tenant-scoped data
- Don't commit `.env`
