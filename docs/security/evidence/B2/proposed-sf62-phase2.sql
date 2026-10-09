-- SF-62 PHASE 2 — THE SWITCH. PROPOSAL ONLY (lane B, security campaign iteration 2, 9 Oct 2026).
--
-- BREAKING for any app build that still calls withRlsBypass under matflow_app (e8afb6a does, ~116 call sites):
-- apply only after the phase-2 app release (system credential for operator/cron, matflow_sec resolvers for the
-- pre-tenant flows, RLS_CONTEXT_SIGNING_KEY set) is deployed AND the key has been provisioned in context_key.
-- While production still logs in as the owner (BYPASSRLS — SF-02 unresolved) this changes nothing at runtime.
--
-- Effect, per tenant_isolation policy in public:
--   before: (current_setting('app.bypass_rls') = 'on') OR <tenant predicate on current_setting('app.current_tenant_id')>
--   after:  <the same tenant predicate on ( SELECT matflow_sec.ctx_tenant() )>
-- i.e. the bypass GUC is gone and the tenant is accepted only with a MAC bound to the current transaction.
-- The rewrite is textual on pg_get_expr output and refuses any policy whose shape it does not recognise.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM matflow_sec.context_key) THEN
    RAISE EXCEPTION 'SF-62 phase 2: provision matflow_sec.context_key first — without a key every tenant query would see nothing';
  END IF;
END $$;

DO $$
DECLARE r record; q text;
BEGIN
  FOR r IN SELECT c.relname, pg_get_expr(p.polqual, p.polrelid) AS qual
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation' LOOP
    q := replace(r.qual, '(current_setting(''app.bypass_rls''::text, true) = ''on''::text) OR ', '');
    q := replace(q, 'current_setting(''app.current_tenant_id''::text, true)', '( SELECT matflow_sec.ctx_tenant() AS ctx_tenant)');
    IF q = r.qual OR q LIKE '%current_setting%' OR q NOT LIKE '%matflow_sec.ctx_tenant()%' THEN
      RAISE EXCEPTION 'SF-62 phase 2: unrecognised tenant_isolation shape on %', r.relname;
    END IF;
    EXECUTE format('DROP POLICY tenant_isolation ON public.%I', r.relname);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)', r.relname, q, q);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'app\.(bypass_rls|current_tenant_id)'
                 OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'app\.(bypass_rls|current_tenant_id)')) THEN
    RAISE EXCEPTION 'SF-62 phase 2: a policy still trusts a plain app.* setting';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
               AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'system_access')) THEN
    RAISE EXCEPTION 'SF-62 phase 2: an RLS table lacks the system_access policy (apply phase 1 first)';
  END IF;
END $$;

-- Writer boundary: the runtime credential has no business with the migration ledger (a forged "applied" row makes
-- prisma migrate deploy skip a pending security migration).
REVOKE ALL ON public._prisma_migrations FROM matflow_app;

COMMIT;

-- PHASE 3 (separate, after the operator console and cron run under matflow_ops in their own deployment):
--   REVOKE INSERT, UPDATE, DELETE ON public."Operator", public."PlatformConfig" FROM matflow_app;
--   REVOKE UPDATE, DELETE ON public."GymApplication" FROM matflow_app;   -- the public apply form keeps INSERT
-- and the SF-57 append-only AuditLog migration (lane F proposal, amended by R).
