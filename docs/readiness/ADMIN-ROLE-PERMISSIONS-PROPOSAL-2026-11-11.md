# The `admin` staff role: proposed permission changes (for decision, 11 Nov 2026)

**Status:** proposal only. Nothing has been changed. This is a business-policy decision for Noe, kept separate from the security fixes on purpose.

## What the code says today

`admin` is one of the four staff roles: owner, manager, coach and admin. It is the schema default for `User.role`, and an owner can choose it when adding staff (`app/api/staff/route.ts:26`). The code contradicts itself about how much it may do.

**`admin` is treated as level with coach (no member money, no member second factor) here:**
- `app/api/members/[id]/totp-reset/route.ts:38-41`: owner and manager only. The comment says "`admin` … is the schema DEFAULT and sits level with coach despite its name", and that money is owner and manager only.
- `app/api/members/[id]/unlock/route.ts:44-48`: owner and manager only, with the same reason.

**`admin` is treated as level with manager here:**

| Route | What admin can do today | Why it matters |
|---|---|---|
| `PATCH /api/members/[id]` (`route.ts:203`, `canEdit = owner, manager, admin`) | Every field in `lib/schemas/member.ts` `memberUpdateSchema`:<br>• `name`, `email`, `phone`;<br>• the three emergency-contact fields;<br>• `membershipType`, `membershipTierId`, `status`, `paymentStatus`;<br>• `notes`, `dateOfBirth`;<br>• `trialRunById`, `creditedToUserId`, `creditedToMemberId`, `creditedToLabel`. | **Takeover:**<br>1. `email` changes the member's login address.<br>2. A magic link sent to the new address signs in as that member.<br>3. The magic link skips the member's second factor (`magic-link/verify/route.ts:293`).<br><br>**Money:**<br>• `status` cancelled stops a live Stripe subscription.<br>• `membershipTierId` can move a member onto a free plan.<br>• `paymentStatus` can mark a member paid. |
| `POST /api/members` (`route.ts:290`, `canAdd = owner, manager, admin`) | Create a member with any plan, status or payment status. | Creating a member straight onto a free or paid plan is comped access. The support edit policy already refuses exactly this (`lib/support-session.ts` `member.create`). |
| `classes/[id]/roster` and `classes/[id]/roster/[memberId]` | Change a class's squad. | Operational. No identity or money effect. |
| `coach/instances/[id]/register` (`isPrivileged`) | The privileged register view. | Operational. |

## Proposal (one recommendation)

**Treat `admin` as a front-desk role: member details yes, identity and money no.** This reuses the field allow-lists the code already has for support edit sessions, which were reviewed for the same risk (`lib/support-session.ts` `SUPPORT_EDIT_FIELD_POLICY`).

1. **`PATCH /api/members/[id]` as `admin`:**
   - **Allowed** (the `member.update` allow-list): `name`, `phone`, `emergencyContactName`, `emergencyContactPhone`, `emergencyContactRelation`, `notes`, `dateOfBirth`, `updatedAt`.
   - **Refused with a 403** naming the fields: everything else. That is `email`, `membershipType`, `membershipTierId`, `status`, `paymentStatus`, `trialRunById` and the `creditedTo*` fields.
   - **Owner and manager are unchanged.**
   - **Implementation:** one guard after `canEdit`, `refuseFieldsOutside(raw, SUPPORT_EDIT_FIELD_POLICY["member.update"])` when `role === "admin"`, using the same helper pattern as `refuseSupportEditFields`.
2. **`POST /api/members` as `admin`:**
   - **Allowed** (the `member.create` allow-list): `name`, `email`, `phone`, `dateOfBirth`, `requestId`.
   - **Refused:** a plan, status or payment status at creation.
   - **The member then needs an owner or manager to put them on a plan.**
3. **No change:** roster, register, check-in, reading members, photos and waivers. These are operational and already open to coaches or staff.
4. **Copy:** the Staff page's role description for "Admin" should say "Front desk: member details, check-in and classes; not plans, payments or login email".

## Effect on clubs today

Production holds Total BJJ's staff. Whether any account there has the `admin` role is a production read, so Noe would run it:

```sql
SELECT role, count(*) FROM "User" WHERE "tenantId" = '<club id>' GROUP BY role;
```

If no `admin` account exists, the change affects nobody now and only prevents a future default from carrying manager-level powers.

## If approved

- **Size:** a small server change in two routes, plus one copy line.
- **Tests (database suite, both roles):** for each refused field, an `admin` PATCH or POST is a 403 and nothing changes; each allowed field still saves; owner and manager behaviour is unchanged.
- **Also update:** the cross-tenant and role matrices (`tests/integration/sec-b-role-matrix-db.test.ts`) gain the `admin` rows.
- **No migration.**
