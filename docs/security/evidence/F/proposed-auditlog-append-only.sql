-- PROPOSAL ONLY (lane F, 9 Oct 2026, SF-F2 / SEC-083). Not a migration: the schema has a single writer (the lead).
-- Makes AuditLog append-only for the runtime role and moves retention behind a function that enforces the published
-- minimum ages, so neither a compromised application nor a SQL injection can rewrite, back-date or delete history.
-- Limits: the table OWNER can still disable triggers or delete; if production connects as neondb_owner (SF-02
-- unknown) this protects nothing until production runs as matflow_app. Needs a both-role DB test before adoption:
-- UPDATE/DELETE/back-date refused for matflow_app; FK SET NULL from User/Operator deletion still works; retention
-- function deletes only rows past the minimums; the retention cron switched to call it.

-- 1. Only foreign-key SET NULL may change a row (User or Operator deleted). Everything else is refused.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW."tenantId", NEW.action, NEW."entityType", NEW."entityId", NEW.metadata::text,
        NEW."ipAddress", NEW."userAgent", NEW."createdAt", NEW."requestId")
       IS DISTINCT FROM
       (OLD.id, OLD."tenantId", OLD.action, OLD."entityType", OLD."entityId", OLD.metadata::text,
        OLD."ipAddress", OLD."userAgent", OLD."createdAt", OLD."requestId")
       OR (NEW."userId" IS DISTINCT FROM OLD."userId" AND NEW."userId" IS NOT NULL)
       OR (NEW."operatorId" IS DISTINCT FROM OLD."operatorId" AND NEW."operatorId" IS NOT NULL) THEN
      RAISE EXCEPTION 'AuditLog is append-only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditLog rows are deleted only by audit_log_purge()' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW WHEN (current_user <> 'neondb_owner') EXECUTE FUNCTION audit_log_append_only();

-- 2. Retention through a SECURITY DEFINER function owned by the table owner, with hard minimums matching
--    lib/audit-log.ts (12 months ordinary, 6 years evidence: admin.*, member.dsar_erase*, rows with metadata.actingAs).
CREATE OR REPLACE FUNCTION audit_log_purge(batch int) RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE n int;
BEGIN
  IF batch IS NULL OR batch < 1 OR batch > 5000 THEN RAISE EXCEPTION 'batch out of range'; END IF;
  WITH doomed AS (
    SELECT id FROM "AuditLog"
     WHERE ("createdAt" < now() - interval '365 days'
            AND action NOT LIKE 'admin.%' AND action NOT LIKE 'member.dsar_erase%'
            AND (metadata IS NULL OR NOT (metadata ? 'actingAs')))
        OR "createdAt" < now() - interval '2190 days'
     LIMIT batch)
  DELETE FROM "AuditLog" a USING doomed d WHERE a.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION audit_log_purge(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_log_purge(int) TO matflow_app;

-- 3. Withdraw the runtime role's direct rights (INSERT and SELECT stay).
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM matflow_app;

-- Note: the trigger's WHEN clause exempts the owner only so that the SECURITY DEFINER purge (which runs as the owner)
-- can delete; back-dating stays impossible for matflow_app because UPDATE of createdAt is refused.
