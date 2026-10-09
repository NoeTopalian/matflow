-- SF-62 PHASE 1 — ADDITIVE. PROPOSAL ONLY (lane B, security campaign iteration 2, 9 Oct 2026).
-- Not a migration in prisma/migrations: the lead owns that directory; Noe decides adoption.
--
-- Safe while the deployed app (e8afb6a) still relies on app.bypass_rls: nothing here changes what matflow_app or
-- the owner can see or do. It adds:
--   * matflow_system — NOLOGIN, NOBYPASSRLS. The ONLY role with a cross-tenant policy. Nobody logs in as it; the
--     operator/cron login (matflow_ops, created out of band with its own password, never in git) is GRANTed it.
--     matflow_app is never a member, so SET ROLE matflow_system is refused to the runtime credential.
--   * system_access policies TO matflow_system on every RLS table (permissive; ORed with tenant_isolation).
--   * schema matflow_sec (not managed by Prisma, so migrate dev never sees drift) holding:
--       context_key            — HMAC pads of the context-signing key; readable only by matflow_system.
--       ctx_tenant()           — SECURITY DEFINER: returns app.current_tenant_id ONLY if app.ctx_mac is the HMAC of
--                                tenant|backend pid|transaction start (µs) under a stored key; else NULL.
--       tenant_id_by_*(…)      — SECURITY DEFINER pre-tenant resolvers: one exact public identifier -> one tenant id,
--                                nothing else. The app then enters a SIGNED context for that tenant and reads under RLS.
-- Every definer function: owner matflow_system (not the owner role: no BYPASSRLS, no DDL), SET search_path =
-- pg_catalog, pg_temp, every object schema-qualified, EXECUTE revoked from PUBLIC and granted by name.
-- Requires PostgreSQL 16+ (GRANT … WITH INHERIT/SET). TEST is 17.11; the production version is UNVERIFIED (SF-02).
-- Validated against a clone of the TEST public schema by scripts/readiness/rls-proposal-validate.mjs.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matflow_system') THEN
    CREATE ROLE matflow_system NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
-- The migration owner hands functions to matflow_system (ALTER … OWNER needs SET) and must be able to drop them later.
GRANT matflow_system TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

GRANT USAGE ON SCHEMA public TO matflow_system;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations' LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO matflow_system', r.relname);
  END LOOP;
END $$;
-- Audit history is append-only for the system role too; retention goes through the narrow purge function of the
-- SF-57 proposal (docs/security/evidence/F/proposed-auditlog-append-only.sql, as amended by review R).
REVOKE UPDATE, DELETE, TRUNCATE ON public."AuditLog" FROM matflow_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO matflow_system;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity LOOP
    EXECUTE format('DROP POLICY IF EXISTS system_access ON public.%I', r.relname);
    EXECUTE format('CREATE POLICY system_access ON public.%I AS PERMISSIVE FOR ALL TO matflow_system USING (true) WITH CHECK (true)', r.relname);
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS matflow_sec;
REVOKE ALL ON SCHEMA matflow_sec FROM PUBLIC;
GRANT USAGE ON SCHEMA matflow_sec TO matflow_app, matflow_system;

CREATE TABLE IF NOT EXISTS matflow_sec.context_key (
  kid        smallint    PRIMARY KEY CHECK (kid IN (1, 2)),       -- two slots: current + previous, for rotation
  k_ipad     bytea       NOT NULL CHECK (octet_length(k_ipad) = 64),
  k_opad     bytea       NOT NULL CHECK (octet_length(k_opad) = 64),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE matflow_sec.context_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE matflow_sec.context_key FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS key_reader ON matflow_sec.context_key;
CREATE POLICY key_reader ON matflow_sec.context_key FOR SELECT TO matflow_system USING (true);
REVOKE ALL ON matflow_sec.context_key FROM PUBLIC;
REVOKE ALL ON matflow_sec.context_key FROM matflow_app;
GRANT SELECT ON matflow_sec.context_key TO matflow_system;

CREATE OR REPLACE FUNCTION matflow_sec.ctx_tenant() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE
  t   text := current_setting('app.current_tenant_id', true);
  m   text := current_setting('app.ctx_mac', true);
  msg bytea;
  r   record;
BEGIN
  IF t IS NULL OR t = '' OR m IS NULL OR m !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  msg := convert_to(t || '|' || pg_backend_pid()::text || '|'
         || floor(extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text, 'UTF8');
  FOR r IN SELECT k.k_ipad, k.k_opad FROM matflow_sec.context_key k LOOP
    IF encode(sha256(r.k_opad || sha256(r.k_ipad || msg)), 'hex') = m THEN RETURN t; END IF;
  END LOOP;
  RETURN NULL;
END $f$;

CREATE OR REPLACE FUNCTION matflow_sec.tenant_id_by_slug(p_slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
  SELECT t.id FROM public."Tenant" t WHERE p_slug IS NOT NULL AND p_slug <> '' AND t.slug = p_slug LIMIT 1 $f$;
CREATE OR REPLACE FUNCTION matflow_sec.tenant_id_by_kiosk_token_hash(p_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
  SELECT t.id FROM public."Tenant" t WHERE p_hash IS NOT NULL AND p_hash <> '' AND t."kioskTokenHash" = p_hash LIMIT 1 $f$;
CREATE OR REPLACE FUNCTION matflow_sec.tenant_id_by_display_token_hash(p_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
  SELECT t.id FROM public."Tenant" t WHERE p_hash IS NOT NULL AND p_hash <> '' AND t."displayTokenHash" = p_hash LIMIT 1 $f$;
CREATE OR REPLACE FUNCTION matflow_sec.tenant_id_by_stripe_account(p_account text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
  SELECT t.id FROM public."Tenant" t WHERE p_account IS NOT NULL AND p_account <> '' AND t."stripeAccountId" = p_account LIMIT 1 $f$;
CREATE OR REPLACE FUNCTION matflow_sec.tenant_id_by_magic_link_hash(p_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
  SELECT k."tenantId" FROM public."MagicLinkToken" k WHERE p_hash IS NOT NULL AND p_hash <> '' AND k."tokenHash" = p_hash LIMIT 1 $f$;
CREATE OR REPLACE FUNCTION matflow_sec.tenant_id_by_reset_token_hash(p_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
  SELECT k."tenantId" FROM public."PasswordResetToken" k WHERE p_hash IS NOT NULL AND p_hash <> '' AND k."tokenHash" = p_hash LIMIT 1 $f$;

DO $$ DECLARE f text; BEGIN
  EXECUTE 'GRANT CREATE ON SCHEMA matflow_sec TO matflow_system'; -- ALTER … OWNER needs it; revoked straight after
  FOREACH f IN ARRAY ARRAY['ctx_tenant()', 'tenant_id_by_slug(text)', 'tenant_id_by_kiosk_token_hash(text)',
    'tenant_id_by_display_token_hash(text)', 'tenant_id_by_stripe_account(text)', 'tenant_id_by_magic_link_hash(text)',
    'tenant_id_by_reset_token_hash(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION matflow_sec.%s FROM PUBLIC', f);
    EXECUTE format('ALTER FUNCTION matflow_sec.%s OWNER TO matflow_system', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION matflow_sec.%s TO matflow_app', f);
  END LOOP;
  EXECUTE 'REVOKE CREATE ON SCHEMA matflow_sec FROM matflow_system';
END $$;

COMMIT;

-- Out of band, NOT in git (operator, owner credential, once per environment):
--   1. Key: 64 random bytes. The app gets it as RLS_CONTEXT_SIGNING_KEY (128 hex). The database gets only the pads:
--      INSERT INTO matflow_sec.context_key (kid, k_ipad, k_opad) VALUES (1, <key XOR 0x36…>, <key XOR 0x5c…>);
--      scripts/readiness/rls-proposal-validate.mjs shows the computation; never print the key or the pads.
--   2. Operator login: CREATE ROLE matflow_ops LOGIN PASSWORD '<from the password manager>' NOBYPASSRLS;
--      GRANT matflow_system TO matflow_ops WITH INHERIT TRUE, SET FALSE;  -- its URL lives ONLY where cron/operator code runs
