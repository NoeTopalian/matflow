-- Load-test database probes, read by scripts/loadtest/monitor.mjs (sections split on "-- name:").
-- Run only against the guarded load-test target. All read-only except statements_prepare/statements_reset, which
-- monitor.mjs runs on a CHILD branch only (never on the shared test branch).

-- name: activity
-- Sessions on this database by state, wait event and role, every 5 s while a scenario runs.
select state, coalesce(wait_event_type, '-') as wait_event_type, coalesce(wait_event, '-') as wait_event, usename, count(*)::int as n
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
group by 1, 2, 3, 4
order by n desc;

-- name: oldest
-- The oldest open transaction and the number of sessions busy right now.
select count(*) filter (where state <> 'idle')::int as busy,
       count(*)::int as total,
       coalesce(max(extract(epoch from now() - xact_start)) filter (where xact_start is not null), 0)::float as oldest_xact_s,
       count(*) filter (where wait_event_type = 'Lock')::int as waiting_on_locks
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid();

-- name: statements_available
select exists (select 1 from pg_extension where extname = 'pg_stat_statements') as installed;

-- name: statements_prepare
create extension if not exists pg_stat_statements;

-- name: statements_reset
select pg_stat_statements_reset();

-- name: top_statements
-- The 20 statements with the most total execution time since the last reset.
select queryid::text as queryid, calls::bigint as calls, round(total_exec_time::numeric, 1)::float as total_ms,
       round(mean_exec_time::numeric, 2)::float as mean_ms, round(max_exec_time::numeric, 1)::float as max_ms,
       rows::bigint as rows, left(regexp_replace(query, '\s+', ' ', 'g'), 300) as query
from pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database())
order by total_exec_time desc
limit 20;

-- name: s2_invariants
-- Per S2 session: attendance rows against capacity, and members recorded more than once. $1 = instance ids.
select ci.id as instance_id, c.name as class_name, c."maxCapacity" as capacity,
       (select count(*) from "AttendanceRecord" a where a."classInstanceId" = ci.id)::int as attended,
       (select count(*) from (select a."memberId" from "AttendanceRecord" a where a."classInstanceId" = ci.id
                              group by a."memberId" having count(*) > 1) d)::int as duplicated_members
from "ClassInstance" ci join "Class" c on c.id = ci."classId"
where ci.id = any($1::text[]);
