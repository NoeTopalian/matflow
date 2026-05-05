// P1.6 Login Notifications — fingerprint helpers.
//
// Three pure functions:
//   - normaliseIp:  collapse an IP to /24 (v4) or /48 (v6) prefix. GDPR-safer
//                    than full IP, and stable across DHCP-shuffles within a
//                    neighbourhood, so genuine new locations still trigger.
//   - summariseUa:  lossy "Chrome 121 on Windows" summary that's stable across
//                    patch versions (Chrome 121.0.6167.85 → "Chrome 121"),
//                    so routine browser updates don't spam users.
//   - deviceHash:   HMAC-SHA256(normalisedIp + "|" + uaSummary, AUTH_SECRET)
//                    so the at-rest value can't be reverse-engineered to an
//                    IP/UA without the secret.

import { createHmac } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export function normaliseIp(rawIp: string | null | undefined): string {
  if (!rawIp) return "0.0.0.0";
  // Strip any port suffix (Vercel sometimes provides "ip:port" via x-forwarded-for).
  const ip = rawIp.trim().split(",")[0]?.trim() ?? "";
  if (!ip) return "0.0.0.0";

  // IPv4: keep first three octets.
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b, c] = v4;
    return `${a}.${b}.${c}.0`;
  }

  // IPv4-mapped IPv6 (::ffff:203.0.113.42) — extract and treat as IPv4.
  const v4Mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4Mapped) return normaliseIp(v4Mapped[1]);

  // IPv6: keep first three hextets (/48). Expand "::" only as much as needed.
  if (ip.includes(":")) {
    const expanded = expandIpv6(ip);
    if (expanded) {
      const hextets = expanded.split(":");
      return `${hextets[0]}:${hextets[1]}:${hextets[2]}::`;
    }
  }

  return "0.0.0.0";
}

function expandIpv6(ip: string): string | null {
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return null;
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 && missing !== 0) return null;
  if (parts.length === 2 && missing < 0) return null;
  const middle = parts.length === 2 ? Array(missing).fill("0") : [];
  const all = [...head, ...middle, ...tail];
  if (all.length !== 8) return null;
  return all.map((h) => h || "0").join(":");
}

export function summariseUa(rawUa: string | null | undefined): string {
  if (!rawUa) return "Unknown browser";
  const ua = rawUa.trim();
  if (!ua) return "Unknown browser";

  const os = detectOs(ua);
  const browser = detectBrowser(ua);
  if (!browser) return os ? `Unknown browser on ${os}` : "Unknown browser";
  return os ? `${browser} on ${os}` : browser;
}

function detectBrowser(ua: string): string | null {
  // Order matters — Edge/Opera/etc spoof Chrome in their UA, so check them first.
  const checks: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/Edg\/(\d+)/, (m) => `Edge ${m[1]}`],
    [/OPR\/(\d+)/, (m) => `Opera ${m[1]}`],
    [/Firefox\/(\d+)/, (m) => `Firefox ${m[1]}`],
    [/CriOS\/(\d+)/, (m) => `Chrome iOS ${m[1]}`],
    [/FxiOS\/(\d+)/, (m) => `Firefox iOS ${m[1]}`],
    [/Chrome\/(\d+)/, (m) => `Chrome ${m[1]}`],
    [/Version\/(\d+).*Safari\//, (m) => `Safari ${m[1]}`],
    [/Safari\//, () => "Safari"],
  ];
  for (const [re, fmt] of checks) {
    const m = ua.match(re);
    if (m) return fmt(m);
  }
  return null;
}

function detectOs(ua: string): string | null {
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

export function deviceHash(ip: string | null | undefined, ua: string | null | undefined): string {
  const ipPart = normaliseIp(ip);
  const uaPart = summariseUa(ua);
  return createHmac("sha256", AUTH_SECRET_VALUE)
    .update(`${ipPart}|${uaPart}`)
    .digest("hex");
}
