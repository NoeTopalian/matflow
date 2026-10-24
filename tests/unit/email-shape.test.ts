import { describe, it, expect } from "vitest";
import { looksLikeSharedMailbox, SHARED_MAILBOX_WARNING } from "@/lib/email-shape";

describe("lib/email-shape — shared-mailbox advice for staff logins", () => {
  it.each([
    "info@club.example.test",
    "INFO@club.example.test",
    "hello@club.com",
    "admin@club.com",
    "contact@club.com",
    "office@club.com",
    "enquiries@club.com",
    "info+sean@club.com",
    "info.desk@club.com",
  ])("%s reads as a shared inbox", (email) => {
    expect(looksLikeSharedMailbox(email)).toBe(true);
  });

  it.each([
    "sean@club.example.test",
    "sean.murphy@gmail.com",
    "s.murphy@club.com",
    "coach.dan@club.com",
    "infoline.sean@club.com",
  ])("%s reads as a person", (email) => {
    expect(looksLikeSharedMailbox(email)).toBe(false);
  });

  it("garbage is never flagged", () => {
    expect(looksLikeSharedMailbox("")).toBe(false);
    expect(looksLikeSharedMailbox("@nothing")).toBe(false);
    expect(looksLikeSharedMailbox(null)).toBe(false);
    expect(looksLikeSharedMailbox(undefined)).toBe(false);
  });

  it("the warning names the fix, not just the problem", () => {
    expect(SHARED_MAILBOX_WARNING).toMatch(/personal address/i);
    expect(SHARED_MAILBOX_WARNING).toMatch(/Contact email/);
  });
});
