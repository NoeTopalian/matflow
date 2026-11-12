-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
-- Both table locks this file needs, taken first and in the application's order (a Class row, then its Tenant row):
-- taking the Tenant lock first (it comes with the foreign key below) while a live transaction holds a Class row and
-- then updates its Tenant would deadlock. The 5 s lock_timeout covers both. If either times out, nothing of this
-- file is applied; see the recovery section of docs/readiness/CLASS-CATEGORIES-RELEASE-A-EVIDENCE-2026-11-11.md.
LOCK TABLE "Class" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;
-- The seed and the backfill below touch every club's rows. ClassCategory and Class force row-level security even
-- for the table owner, so this transaction (and only this transaction) reads and writes across clubs.
SELECT set_config('app.bypass_rls', 'on', true);

-- Club-managed class categories, Release A (11 Nov 2026).
--
-- Each club gets its own category rows. Every club starts with the eight that used to be fixed, named exactly as
-- they read today ("Open mat" included), each carrying its old key in "legacyKey". A class points at its club's row
-- through "categoryId"; the composite key ("categoryId", "tenantId") makes pointing at another club's row impossible.
--
-- "Class"."category" (the old key) and its CHECK stay. A build from before this release reads and writes only that
-- column, so the trigger below keeps the two in step whichever build writes. The design, its exact rules and the
-- supported rollback boundary are in docs/readiness/CLASS-CATEGORIES-RELEASE-A-EVIDENCE-2026-11-11.md.

-- ── Table ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ClassCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "legacyKey" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassCategory_pkey" PRIMARY KEY ("id"),
    -- Only the eight old keys may be carried; a category the club makes has none.
    CONSTRAINT "ClassCategory_legacyKey_check"
      CHECK ("legacyKey" IS NULL OR "legacyKey" IN ('fundamentals', 'gi', 'nogi', 'kids', 'competition', 'open_mat', 'private', 'other')),
    -- lib/class-category.ts CATEGORY_NAME_MAX (Noe, 11 Nov 2026), held by the database too.
    CONSTRAINT "ClassCategory_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 32)
);

CREATE INDEX "ClassCategory_tenantId_sortOrder_idx" ON "ClassCategory"("tenantId", "sortOrder");
CREATE UNIQUE INDEX "ClassCategory_id_tenantId_key" ON "ClassCategory"("id", "tenantId");
-- Archived rows keep their name: a name stays taken until the category is renamed.
CREATE UNIQUE INDEX "ClassCategory_tenantId_nameKey_key" ON "ClassCategory"("tenantId", "nameKey");
CREATE UNIQUE INDEX "ClassCategory_tenantId_legacyKey_key" ON "ClassCategory"("tenantId", "legacyKey");

-- CASCADE (as Task): a club's categories go with the club. The classes that point at them go first in every path
-- that deletes a club (lib/tenant-purge.ts step 3), so the NO ACTION key below never blocks a club deletion.
ALTER TABLE "ClassCategory" ADD CONSTRAINT "ClassCategory_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, same shape as every tenant table (rls_policies_foundation).
ALTER TABLE "ClassCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ClassCategory" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

-- ── The class's reference ───────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Class" ADD COLUMN "categoryId" TEXT;
-- When an old key last reached this class by itself (a build from before this release, or a script writing the old
-- column). Never written by this release's own code. The Release B activation gate reads max() of it.
ALTER TABLE "Class" ADD COLUMN "categoryKeyWrittenAt" TIMESTAMP(3);
CREATE INDEX "Class_categoryId_idx" ON "Class"("categoryId");
-- NO ACTION: categories are archived, never deleted, so nothing should ever try. The composite key is the database's
-- own guarantee that a class and its category belong to the same club (MATCH SIMPLE: NULL = uncategorised).
ALTER TABLE "Class" ADD CONSTRAINT "Class_categoryId_tenantId_fkey"
  FOREIGN KEY ("categoryId", "tenantId") REFERENCES "ClassCategory"("id", "tenantId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── The eight starting categories ───────────────────────────────────────────────────────────────────────────────
-- One function, used here, by the bridge (a club created by an older build) and by every club-creation path
-- (lib/class-category-store.ts seedClassCategories), so the ids, names and order can never differ between them.
-- Ids are deterministic per club and key, so running it again adds nothing. "nameKey" is lower() of an ASCII name,
-- which is what lib/class-category.ts categoryNameKey gives for these eight (tests/unit/class-category.test.ts).
-- SECURITY INVOKER (the default): it runs with the caller's rights and row-level security, so a caller acting for
-- one club can only ever insert that club's rows. search_path is pinned so no other schema's objects are used.
CREATE FUNCTION matflow_seed_class_categories(p_tenant TEXT, p_open_mat_name TEXT DEFAULT 'Open Mat')
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO "ClassCategory" ("id", "tenantId", "name", "nameKey", "legacyKey", "sortOrder", "createdAt", "updatedAt")
  SELECT 'cc_' || md5(p_tenant || ':' || d.k), p_tenant, d.n, lower(d.n), d.k, d.o, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM (VALUES
    ('fundamentals', 'Fundamentals', 0),
    ('gi', 'Gi', 1),
    ('nogi', 'No-Gi', 2),
    ('kids', 'Kids', 3),
    ('competition', 'Competition', 4),
    ('open_mat', p_open_mat_name, 5),
    ('private', 'Private', 6),
    ('other', 'Other', 7)
  ) AS d(k, n, o)
  ON CONFLICT DO NOTHING;
END
$$;

-- Every existing club keeps today's spelling, "Open mat"; a club created from now on starts with "Open Mat".
SELECT matflow_seed_class_categories("id", 'Open mat') FROM "Tenant";

-- ── Which columns a write named ─────────────────────────────────────────────────────────────────────────────────
-- A row trigger sees values, not which columns the statement named: "SET categoryId = X, category = 'gi'" on a Gi
-- class looks like "SET categoryId = X". So one marker trigger per column, `UPDATE OF` that column only, records the
-- row's id in a transaction-local setting before the bridge runs. Triggers on one row fire in name order, and both
-- markers' names sort before "Class_category_bridge". The bridge reads and clears both, so a later statement in the
-- same transaction never inherits them.
CREATE FUNCTION matflow_class_category_mark() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('matflow.class_category_' || TG_ARGV[0] || '_named', NEW."id", true);
  RETURN NEW;
END
$$;

-- ── The bridge ──────────────────────────────────────────────────────────────────────────────────────────────────
-- Keeps "category" (old key) and "categoryId" (reference) in step on every write to a class, whichever build wrote.
-- "Named" = the statement named the column (UPDATE), or set it to a value (INSERT):
--
--   both named                 they must agree (category = the row's legacyKey, both NULL, or a club-made row and
--                              a NULL key), else the write is refused: never resolved in favour of either
--   only categoryId named      if it changed: category := that row's legacyKey (NULL for a club-made category)
--   only category named        if it changed: categoryId := the club's row with that key (NULL clears both), and
--                              categoryKeyWrittenAt := now (only old builds and scripts take this path)
--   neither                    the trigger does not fire (UPDATE OF), so an unrelated edit changes nothing
--
-- A NEW assignment to an archived category is refused; a class that already has it keeps it through any other edit.
-- The target row is read FOR SHARE, so an archive of it (an UPDATE) and this assignment wait for each other: the
-- second to commit sees the first. Errors carry an MF_CLASS_CATEGORY_* code in the message (lib/class-category-store.ts
-- classCategoryDbError) and SQLSTATE P0001; the write is refused whole.
-- SECURITY INVOKER: it reads and seeds as the writer, under row-level security, scoped to NEW."tenantId".
CREATE FUNCTION matflow_class_category_bridge() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ref_named BOOLEAN;
  key_named BOOLEAN;
  ref_changed BOOLEAN;
  key_changed BOOLEAN;
  t_id TEXT;
  t_key TEXT;
  t_archived TIMESTAMP(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    ref_named := NEW."categoryId" IS NOT NULL;
    key_named := NEW."category" IS NOT NULL;
    ref_changed := ref_named;
    key_changed := key_named;
  ELSE
    ref_named := coalesce(current_setting('matflow.class_category_ref_named', true) = NEW."id", false);
    key_named := coalesce(current_setting('matflow.class_category_key_named', true) = NEW."id", false);
    PERFORM set_config('matflow.class_category_ref_named', '', true);
    PERFORM set_config('matflow.class_category_key_named', '', true);
    ref_changed := NEW."categoryId" IS DISTINCT FROM OLD."categoryId";
    key_changed := NEW."category" IS DISTINCT FROM OLD."category";
  END IF;

  IF ref_named AND key_named THEN
    IF NEW."categoryId" IS NULL THEN
      IF NEW."category" IS NOT NULL THEN
        RAISE EXCEPTION 'MF_CLASS_CATEGORY_CONFLICT: categoryId is NULL but category is %', NEW."category" USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;
    SELECT "id", "legacyKey", "archivedAt" INTO t_id, t_key, t_archived
      FROM "ClassCategory" WHERE "id" = NEW."categoryId" AND "tenantId" = NEW."tenantId" FOR SHARE;
    IF t_id IS NULL THEN
      RAISE EXCEPTION 'MF_CLASS_CATEGORY_NOT_FOUND: no such category in this club' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."category" IS DISTINCT FROM t_key THEN
      RAISE EXCEPTION 'MF_CLASS_CATEGORY_CONFLICT: category % does not match categoryId', coalesce(NEW."category", 'NULL') USING ERRCODE = 'P0001';
    END IF;
    IF ref_changed AND t_archived IS NOT NULL THEN
      RAISE EXCEPTION 'MF_CLASS_CATEGORY_ARCHIVED: that category is archived' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF ref_named THEN
    IF NOT ref_changed THEN
      RETURN NEW;
    END IF;
    IF NEW."categoryId" IS NULL THEN
      NEW."category" := NULL;
      RETURN NEW;
    END IF;
    SELECT "id", "legacyKey", "archivedAt" INTO t_id, t_key, t_archived
      FROM "ClassCategory" WHERE "id" = NEW."categoryId" AND "tenantId" = NEW."tenantId" FOR SHARE;
    IF t_id IS NULL THEN
      RAISE EXCEPTION 'MF_CLASS_CATEGORY_NOT_FOUND: no such category in this club' USING ERRCODE = 'P0001';
    END IF;
    IF t_archived IS NOT NULL THEN
      RAISE EXCEPTION 'MF_CLASS_CATEGORY_ARCHIVED: that category is archived' USING ERRCODE = 'P0001';
    END IF;
    NEW."category" := t_key;
    RETURN NEW;
  END IF;

  IF key_named THEN
    IF NOT key_changed THEN
      RETURN NEW;
    END IF;
    -- Only the old key: a build from before Release A, or a script. This release's code never comes this way.
    NEW."categoryKeyWrittenAt" := CURRENT_TIMESTAMP;
    IF NEW."category" IS NULL THEN
      NEW."categoryId" := NULL;
      RETURN NEW;
    END IF;
    SELECT "id", "archivedAt" INTO t_id, t_archived
      FROM "ClassCategory" WHERE "tenantId" = NEW."tenantId" AND "legacyKey" = NEW."category" FOR SHARE;
    IF t_id IS NULL THEN
      -- A club created by an older build during the changeover has no rows yet.
      PERFORM matflow_seed_class_categories(NEW."tenantId");
      SELECT "id", "archivedAt" INTO t_id, t_archived
        FROM "ClassCategory" WHERE "tenantId" = NEW."tenantId" AND "legacyKey" = NEW."category" FOR SHARE;
      IF t_id IS NULL THEN
        RAISE EXCEPTION 'MF_CLASS_CATEGORY_NOT_FOUND: no category with key % in this club', NEW."category" USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF t_archived IS NOT NULL THEN
      RAISE EXCEPTION 'MF_CLASS_CATEGORY_ARCHIVED: that category is archived' USING ERRCODE = 'P0001';
    END IF;
    NEW."categoryId" := t_id;
  END IF;
  RETURN NEW;
END
$$;

-- Names sort "Class_category_0_key_named" < "Class_category_0_ref_named" < "Class_category_bridge": the markers run
-- first on every row. UPDATE OF: each fires only when its statement names that column, so check-in, booking and every
-- other class write that does not touch a category is unaffected.
CREATE TRIGGER "Class_category_0_key_named"
  BEFORE UPDATE OF "category" ON "Class"
  FOR EACH ROW EXECUTE FUNCTION matflow_class_category_mark('key');
CREATE TRIGGER "Class_category_0_ref_named"
  BEFORE UPDATE OF "categoryId" ON "Class"
  FOR EACH ROW EXECUTE FUNCTION matflow_class_category_mark('ref');
CREATE TRIGGER "Class_category_bridge"
  BEFORE INSERT OR UPDATE OF "category", "categoryId" ON "Class"
  FOR EACH ROW EXECUTE FUNCTION matflow_class_category_bridge();

-- ── Backfill ────────────────────────────────────────────────────────────────────────────────────────────────────
-- Every class with an old key points at its own club's row with that key. Deterministic by (club, key); no names are
-- matched and nothing is renamed or reassigned. Uncategorised classes stay NULL. Runs after the triggers exist and
-- under this file's locks, so no write can land between the backfill and the triggers.
UPDATE "Class" c SET "categoryId" = cc."id"
  FROM "ClassCategory" cc
 WHERE cc."tenantId" = c."tenantId"
   AND cc."legacyKey" = c."category"
   AND c."category" IS NOT NULL
   AND c."categoryId" IS NULL;

-- Refuse to commit unless every class agrees: a key with no reference, a reference with no key, or two that differ.
-- (No club-made category exists yet, so here a reference without a key would be an error.)
DO $$
DECLARE
  bad INTEGER;
BEGIN
  SELECT count(*) INTO bad
    FROM "Class" c
    LEFT JOIN "ClassCategory" cc ON cc."id" = c."categoryId" AND cc."tenantId" = c."tenantId"
   WHERE (c."category" IS NULL) <> (c."categoryId" IS NULL)
      OR (c."categoryId" IS NOT NULL AND cc."legacyKey" IS DISTINCT FROM c."category");
  IF bad > 0 THEN
    RAISE EXCEPTION 'class_categories backfill left % classes inconsistent', bad;
  END IF;
END
$$;

COMMIT;
