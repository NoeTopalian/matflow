// The browse mix shared by S3 and S5: one "screen" per iteration — the page document, then the API calls that
// screen makes — then think time. 90% members, 10% staff (every tenth virtual user).
import exec from "k6/execution";
import { MEMBERS, STAFF, CLUBS, req, withSession, think, pick, laneIp, todayIso } from "./k6-common.js";

const MEMBER_SCREENS = [
  (ip, t) => { req("GET", "/member/home", { kind: "page", name: "member home page", ip, tags: t }); req("GET", `/api/member/home?date=${todayIso()}`, { kind: "api", name: "member home api", ip, tags: t }); req("GET", "/api/member/me", { kind: "api", name: "member me", ip, tags: t }); },
  (ip, t) => { req("GET", "/member/schedule", { kind: "page", name: "member schedule page", ip, tags: t }); req("GET", `/api/member/schedule?date=${todayIso()}`, { kind: "api", name: "member schedule api", ip, tags: t }); req("GET", "/api/member/timetable", { kind: "api", name: "member timetable", ip, tags: t }); },
  (ip, t) => { req("GET", "/member/progress", { kind: "page", name: "member progress page", ip, tags: t }); req("GET", "/api/member/classes?take=20", { kind: "api", name: "member classes", ip, tags: t }); },
  (ip, t) => { req("GET", "/member/profile", { kind: "page", name: "member profile page", ip, tags: t }); req("GET", "/api/member/me", { kind: "api", name: "member me", ip, tags: t }); },
];

const STAFF_SCREENS = [
  (ip, t) => { req("GET", "/dashboard", { kind: "page", name: "dashboard page", ip, tags: t }); req("GET", "/api/dashboard/stats", { kind: "api", name: "dashboard stats", ip, tags: t }); },
  (ip, t) => { req("GET", "/dashboard/members", { kind: "page", name: "members page", ip, tags: t }); req("GET", `/api/members?search=M00${Math.floor(Math.random() * 9) + 1}`, { kind: "api", name: "members search", ip, tags: t }); },
  (ip, t) => { req("GET", "/dashboard/timetable", { kind: "page", name: "timetable page", ip, tags: t }); },
  (ip, t, s) => { req("GET", "/dashboard/checkin", { kind: "page", name: "register page", ip, tags: t }); req("GET", `/api/checkin/members?instanceId=${CLUBS[s.c].s2.kiosk.instanceId}&take=50`, { kind: "api", name: "register members", ip, tags: t }); },
];

/** One browse iteration for the current virtual user. `tags` are added to every request (S5 adds user/phase). */
export function browse(tags = {}, thinkMin = 10, thinkMax = 30) {
  const vu = exec.vu.idInTest;
  const ip = laneIp(10000 + vu);
  if (vu % 10 === 0) {
    const s = STAFF[(vu / 10) % STAFF.length];
    withSession(s.token);
    pick(STAFF_SCREENS)(ip, { ...tags, role: "staff" }, s);
  } else {
    const m = MEMBERS[vu % MEMBERS.length];
    withSession(m.token);
    pick(MEMBER_SCREENS)(ip, { ...tags, role: "member" }, m);
  }
  think(thinkMin, thinkMax);
}
