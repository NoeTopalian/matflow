-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): if another session holds a lock this needs, the
-- deploy fails after 5 s (55P03) instead of queueing requests behind it; no statement runs past 15 s.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Club-managed class categories, Release B (12 Nov 2026): the stale-writer refusal.
--
-- Release B lets a club make its own categories. A category the club made has no old key, so a writer that knows
-- only the old keys (a build from before Release A still serving, or a script) cannot see it. Such a writer changing
-- the old key of a class on a club-made category would replace or clear that category without having seen it. The
-- bridge now refuses that write (MF_CLASS_CATEGORY_STALE_WRITER). Everything else in the bridge is unchanged; the
-- route-level twin of this check is lib/class-category-store.ts categoryIdToWrite (an old page against a new server).
--
-- It also stamps categoryKeyWrittenAt on every old-key-only write, not only on a change (the observation signal O1).
--
-- Only the function body changes: CREATE OR REPLACE FUNCTION takes no table lock, and the triggers keep pointing at
-- it. Rolling back the code to Release A leaves this function in place, which only refuses more. Design and
-- evidence: docs/readiness/CLASS-CATEGORIES-RELEASE-B-2026-11-12.md.

CREATE OR REPLACE FUNCTION matflow_class_category_bridge() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
    -- Only the old key: a build from before Release A, or a script. This release's code never comes this way.
    -- Stamped on every such write, even one that re-sends the key the class already has, so a pre-Release-A server
    -- still serving shows up in the observation signal O1 (fix re-review 4, B1; Release A stamped changes only).
    NEW."categoryKeyWrittenAt" := CURRENT_TIMESTAMP;
    IF NOT key_changed THEN
      RETURN NEW;
    END IF;
    -- Release B (12 Nov 2026): such a writer cannot see a category the club made (it has no old key), so changing
    -- the old key of a class on one would replace or clear a category the writer never saw. Refused, not guessed.
    IF TG_OP = 'UPDATE' AND OLD."categoryId" IS NOT NULL THEN
      SELECT "legacyKey" INTO t_key FROM "ClassCategory" WHERE "id" = OLD."categoryId" AND "tenantId" = OLD."tenantId";
      -- The foreign key guarantees the row exists, so NOT FOUND means it is not visible to this writer: refused
      -- rather than waved through (review B-N6).
      IF NOT FOUND OR t_key IS NULL THEN
        RAISE EXCEPTION 'MF_CLASS_CATEGORY_STALE_WRITER: this class is on a category the club made; an old-key writer cannot change it' USING ERRCODE = 'P0001';
      END IF;
    END IF;
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

COMMIT;
