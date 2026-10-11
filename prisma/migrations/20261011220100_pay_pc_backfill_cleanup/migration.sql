-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Payments lane PC, review RP-3 (11 Oct 2026). Runs after
-- 20261011190000_pay_pc_member_subscription_mapping, whose backfill mapped
-- EVERY member that pointed at a subscription, including members another
-- platform bills (billedBy <> 'matflow', e.g. TeamUp). Their subscription is
-- not MatFlow's, so its events must stay ignored_foreign: the backfilled
-- (source 'adopted', never had an event applied) mappings of those members are
-- removed. The earlier migration is NOT edited (that would change its
-- checksum on every database that already applied it).
--
-- Not changed, reported in the deploy log instead:
--   * two members pointing at one subscription: the backfill mapped the
--     earliest-joined one; the others keep a pointer with no mapping;
--   * a member of a club with no stripeAccountId (disconnected in the app):
--     not mapped; events for that subscription are ignored_foreign until the
--     club reconnects and staff relink the member.

-- Member and MemberSubscription are under FORCE ROW LEVEL SECURITY.
-- Transaction-local: it ends at COMMIT and cannot leak through the pooler.
SELECT set_config('app.bypass_rls', 'on', true);

DELETE FROM "MemberSubscription" s
USING "Member" m
WHERE s."memberId" = m."id"
  AND s."source" = 'adopted'
  AND s."lastEventCreated" IS NULL
  AND m."billedBy" IS DISTINCT FROM 'matflow';

DO $$
DECLARE
  unmapped integer;
  shared integer;
BEGIN
  SELECT count(*) INTO unmapped
  FROM "Member" m
  WHERE m."stripeSubscriptionId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "MemberSubscription" s
      WHERE s."stripeSubscriptionId" = m."stripeSubscriptionId" AND s."memberId" = m."id"
    );
  SELECT count(*) INTO shared
  FROM (
    SELECT "stripeSubscriptionId" FROM "Member"
    WHERE "stripeSubscriptionId" IS NOT NULL
    GROUP BY "stripeSubscriptionId" HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'pay_pc backfill cleanup: % member pointer(s) without a mapping; % subscription id(s) shared by more than one member', unmapped, shared;
END $$;

COMMIT;
