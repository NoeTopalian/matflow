// Round 8: the Sean-sized SYNTHETIC club, seeded into the run's own fixture (test branch only; torn down with it).
// ~900 members (630 active), 4 plans, 15 classes (49 weekly sessions), 12 weeks of sessions, ~8k attendance rows.
// Deterministic ids derived from the tenant, so a rerun on the same club is idempotent.
export async function seedR8(q, club, tenantId) {
  const zone = (await q(`select timezone from "Tenant" where id = $1`, [tenantId]))[0].timezone;
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const P = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const todayIso = `${P.year}-${P.month}-${P.day}`;
  const hourNow = Number(P.hour);
  const hh = (h) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;
  const NOW_START = hh(hourNow), NOW_END = hourNow >= 23 ? "23:59" : hh(hourNow + 1);
  await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", "billingCycle", "updatedAt")
    select 'r8t-' || md5($1 || n), $1, (array['Adult Unlimited','Adult Off-Peak','Student Unlimited','Family Add-on'])[n], (array[8500,6500,6000,4000])[n], 'monthly', now()
    from generate_series(1,4) n on conflict do nothing`, [tenantId]);
  await q(`insert into "Member" (id, "tenantId", name, email, status, "paymentStatus", "membershipTierId", "waiverAccepted", "waiverAcceptedAt", "joinedAt", "cancelledAt", "updatedAt")
    select 'r8m-' || md5($1 || i), $1, 'Perf Member ' || lpad(i::text, 4, '0'), $2 || '-pm' || i || '@example.test',
      case when i <= 630 then 'active' when i <= 780 then 'cancelled' when i <= 870 then 'inactive' else 'taster' end,
      case when i <= 600 then 'paid' when i <= 630 then 'overdue' when i <= 780 then 'cancelled' else 'paid' end,
      'r8t-' || md5($1 || (1 + i % 4)), true, now() - (i % 700) * interval '1 day', now() - (i % 700) * interval '1 day',
      case when i > 630 and i <= 780 then now() - (i % 120) * interval '1 day' end, now()
    from generate_series(1,900) i on conflict do nothing`, [tenantId, club.slug]);
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity")
    select 'r8c-' || md5($1 || c), $1, case when c = 0 then 'Perf Now' else 'Perf Class ' || lpad(c::text, 2, '0') end, 60, 40
    from generate_series(0,14) c on conflict do nothing`, [tenantId]);
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime", "startDate")
    select 'r8s-' || md5($1 || c || '-' || k), 'r8c-' || md5($1 || c), (c + 2 * k) % 7,
      lpad((6 + (c * 3 + k * 5) % 15)::text, 2, '0') || ':00', lpad((7 + (c * 3 + k * 5) % 15)::text, 2, '0') || ':00', date '${todayIso}' - 400
    from generate_series(1,14) c, generate_series(0,2) k
    union all
    select 'r8s-' || md5($1 || 'now-' || d), 'r8c-' || md5($1 || 0), d, $2, $3, date '${todayIso}' - 400 from generate_series(0,6) d
    on conflict do nothing`, [tenantId, NOW_START, NOW_END]);
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime")
    select 'r8i-' || md5(s.id || d::text), s."classId", d::timestamp, s."startTime", s."endTime"
    from "ClassSchedule" s join "Class" c on c.id = s."classId" and c."tenantId" = $1,
         generate_series(date '${todayIso}' - 84, date '${todayIso}', interval '1 day') d
    where extract(dow from d) = s."dayOfWeek" on conflict do nothing`, [tenantId]);
  await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInTime", "checkInMethod")
    select 'r8a-' || md5(i.id || k), $1, 'r8m-' || md5($1 || (1 + (i.ord * 37 + k * 61) % 630)), i.id,
      i.date + (i."startTime" || ':00')::time, 'admin'
    from (select ci.*, row_number() over (order by ci.id) ord from "ClassInstance" ci join "Class" c on c.id = ci."classId" and c."tenantId" = $1
          where ci.date < date '${todayIso}') i, generate_series(1,14) k
    on conflict do nothing`, [tenantId]);
  const size = (await q(`select (select count(*) from "Member" where "tenantId" = $1)::int members,
    (select count(*) from "Member" where "tenantId" = $1 and status = 'active')::int active,
    (select count(*) from "MembershipTier" where "tenantId" = $1)::int tiers,
    (select count(*) from "Class" where "tenantId" = $1)::int classes,
    (select count(*) from "ClassSchedule" s join "Class" c on c.id = s."classId" where c."tenantId" = $1)::int schedules,
    (select count(*) from "ClassInstance" i join "Class" c on c.id = i."classId" where c."tenantId" = $1)::int instances,
    (select count(*) from "AttendanceRecord" where "tenantId" = $1)::int attendance`, [tenantId]))[0];
  return { size, zone, todayIso, NOW_START };
}
