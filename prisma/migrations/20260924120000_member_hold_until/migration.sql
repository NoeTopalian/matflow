-- All-or-nothing: Prisma does not wrap a migration in a transaction (the 30 Sep
-- failure drill left a partial ALTER behind), so this one does it itself.
BEGIN;

-- Member.holdUntil: the planned end of a membership hold. Additive and
-- nullable — safe on a populated table. A hold is paymentStatus = 'paused'
-- (already in the CHECK from 20260430000001); this column only adds the date.
ALTER TABLE "Member" ADD COLUMN "holdUntil" TIMESTAMP(3);

COMMIT;
