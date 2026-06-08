-- Lane 1 iter-1 P-02 [Critical] fix: covering index for the
-- `/dashboard/members` page sort.
--
-- The members list is the single highest-traffic owner-side page. Its
-- SSR fetch runs `findMany({ where: { tenantId }, orderBy: { name: 'asc' } })`.
-- Before this index Postgres seq-scanned the tenant slice + sorted in memory
-- — measurable from ~300 members upward (50–500 ms range). With this index
-- the planner uses an index scan + index-ordered output, eliminating the
-- separate sort node.
--
-- Idempotent.

DROP INDEX IF EXISTS "Member_tenantId_name_idx";
CREATE INDEX "Member_tenantId_name_idx" ON "Member" ("tenantId", "name");
