-- SF-62 ROLLBACK — PROPOSAL ONLY. Two independent blocks; run the phase-2 block first if phase 2 was applied.
-- Restores exactly the deployed policy semantics (bypass GUC OR plain tenant GUC), so a rolled-back app build that
-- still calls withRlsBypass works again. Validated by scripts/readiness/rls-proposal-validate.mjs (round trip).

-- ── rollback of phase 2 ──
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE r record; q text;
BEGIN
  FOR r IN SELECT c.relname, pg_get_expr(p.polqual, p.polrelid) AS qual
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%ctx_tenant()%' LOOP
    q := replace(r.qual, '( SELECT matflow_sec.ctx_tenant() AS ctx_tenant)', 'current_setting(''app.current_tenant_id'', true)');
    IF q LIKE '%ctx_tenant%' THEN RAISE EXCEPTION 'SF-62 rollback: unrecognised shape on %', r.relname; END IF;
    EXECUTE format('DROP POLICY tenant_isolation ON public.%I', r.relname);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL USING ((current_setting(''app.bypass_rls'', true) = ''on'') OR %s)', r.relname, q);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public._prisma_migrations TO matflow_app;  -- only if the old grant must return
COMMIT;

-- ── rollback of phase 1 ──
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND p.polname = 'system_access' LOOP
    EXECUTE format('DROP POLICY system_access ON public.%I', r.relname);
  END LOOP;
END $$;
DROP SCHEMA IF EXISTS matflow_sec CASCADE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matflow_system') THEN
    EXECUTE 'DROP OWNED BY matflow_system';
    EXECUTE 'DROP ROLE matflow_system';   -- fails while matflow_ops is still a member: revoke/drop that login first
  END IF;
END $$;
COMMIT;
