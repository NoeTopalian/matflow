/**
 * Unit tests for the shared notes sanitiser (Phase 1 of feat/member-tickable-notes).
 *
 * Covers every category the STRIP_PATTERN in lib/schemas/notes-sanitiser.ts
 * enumerates so a regression in the regex is caught before it touches a
 * production write path. Also covers the notesField(n) Zod helper to confirm
 * length-rejection runs BEFORE the strip transform.
 *
 * Evil-character inputs are constructed with String.fromCharCode so the test
 * source file stays pure printable ASCII — same discipline as the sanitiser
 * itself. The codepoint each fixture targets is named in a `// U+XXXX` comment.
 */
import { describe, it, expect } from "vitest";
import { sanitiseNoteText, notesField } from "@/lib/schemas/notes-sanitiser";

const CH = (cp: number) => String.fromCharCode(cp);

describe("sanitiseNoteText", () => {
  it("returns null for null and undefined", () => {
    expect(sanitiseNoteText(null)).toBeNull();
    expect(sanitiseNoteText(undefined)).toBeNull();
  });

  it("returns null for empty and whitespace-only input", () => {
    expect(sanitiseNoteText("")).toBeNull();
    expect(sanitiseNoteText("   ")).toBeNull();
    expect(sanitiseNoteText("\t\n\r ")).toBeNull();
  });

  it("trims surrounding whitespace but preserves internal layout", () => {
    expect(sanitiseNoteText("  hello  ")).toBe("hello");
    expect(sanitiseNoteText("  line 1\nline 2\n  ")).toBe("line 1\nline 2");
  });

  it("keeps tabs, newlines, carriage returns inside the body", () => {
    const body = "a\tb\nc\r\nd";
    expect(sanitiseNoteText(body)).toBe(body);
  });

  it("strips NUL and BS (C0 controls)", () => {
    // U+0000 NUL, U+0008 BS — both outside the allow-list.
    expect(sanitiseNoteText("hello" + CH(0x00) + "world")).toBe("helloworld");
    expect(sanitiseNoteText("hello" + CH(0x08) + "world")).toBe("helloworld");
  });

  it("strips VT and FF but keeps TAB/LF/CR", () => {
    // U+000B VT, U+000C FF stripped; U+0009 TAB, U+000A LF, U+000D CR kept.
    expect(sanitiseNoteText("a" + CH(0x0b) + "b" + CH(0x0c) + "c")).toBe("abc");
    expect(sanitiseNoteText("a" + CH(0x09) + "b" + CH(0x0a) + "c" + CH(0x0d) + "d")).toBe(
      "a\tb\nc\rd",
    );
  });

  it("strips SO..US (C0 controls 0x0E..0x1F)", () => {
    expect(sanitiseNoteText("a" + CH(0x0e) + "b" + CH(0x1f) + "c")).toBe("abc");
  });

  it("strips DEL and the C1 control range (U+007F..U+009F)", () => {
    expect(sanitiseNoteText("a" + CH(0x7f) + "b")).toBe("ab");
    expect(sanitiseNoteText("a" + CH(0x9f) + "b" + CH(0x80) + "c")).toBe("abc");
  });

  it("strips zero-width and bidi format characters (anti-spoofing)", () => {
    // U+200B ZWSP, U+200C ZWNJ, U+200E LRM, U+200F RLM
    expect(sanitiseNoteText("admin" + CH(0x200b) + CH(0x200c) + "user")).toBe("adminuser");
    // U+202E RLO override
    expect(sanitiseNoteText("good" + CH(0x202e) + "evil")).toBe("goodevil");
    // U+2060 WORD JOINER + U+FEFF BOM
    expect(sanitiseNoteText("a" + CH(0x2060) + "b" + CH(0xfeff) + "c")).toBe("abc");
    // U+2066 / U+2069 bidi isolates
    expect(sanitiseNoteText("a" + CH(0x2066) + "b" + CH(0x2069) + "c")).toBe("abc");
  });

  it("strips Unicode line/paragraph separators (U+2028, U+2029)", () => {
    expect(sanitiseNoteText("line1" + CH(0x2028) + "line2")).toBe("line1line2");
    expect(sanitiseNoteText("para1" + CH(0x2029) + "para2")).toBe("para1para2");
  });

  it("preserves angle brackets — escaping is the renderer's job", () => {
    // We do NOT HTML-escape here; the email layer escapes for HTML, React
    // text nodes escape for the DOM, JSON.stringify escapes for responses.
    expect(sanitiseNoteText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
    expect(sanitiseNoteText("<5kg loss this month")).toBe("<5kg loss this month");
  });

  it("preserves Unicode letters, emoji, punctuation", () => {
    expect(sanitiseNoteText("Noé Topalián \u{1F94B}")).toBe("Noé Topalián \u{1F94B}");
    expect(sanitiseNoteText("café — résumé")).toBe("café — résumé");
  });

  it("preserves NBSP (U+00A0) — it's a printable space, not a control", () => {
    // NBSP is outside the strip set on purpose: word processors and copy-paste
    // legitimately produce it, and React renders it correctly.
    const nbsp = CH(0x00a0);
    expect(sanitiseNoteText("a" + nbsp + "b")).toBe("a" + nbsp + "b");
  });

  it("is idempotent", () => {
    const dirty = "  hi" + CH(0x200b) + " there   ";
    const once = sanitiseNoteText(dirty);
    const twice = sanitiseNoteText(once);
    expect(once).toBe("hi there");
    expect(twice).toBe(once);
  });
});

describe("notesField(maxLength)", () => {
  it("rejects oversize input BEFORE the strip (cannot smuggle bytes via controls)", () => {
    const schema = notesField(10);
    // 11 printables → too long
    expect(schema.safeParse("12345678901").success).toBe(false);
    // 8 ZWSPs + 3 printables = 11 chars → max check sees 11, rejects, even
    // though the stripped result would be just 3 chars. This is intentional:
    // we never want an attacker to pad with controls to bypass length limits.
    const padded = CH(0x200b).repeat(8) + "abc";
    expect(schema.safeParse(padded).success).toBe(false);
  });

  it("accepts and strips a within-limits payload", () => {
    const schema = notesField(50);
    const r = schema.safeParse("  hello" + CH(0x200b) + "world  ");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe("helloworld");
  });

  it("returns null for null, undefined, missing, and whitespace-only", () => {
    const schema = notesField(50);
    for (const input of [null, undefined, "", "   ", "\t\n"]) {
      const r = schema.safeParse(input);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBeNull();
    }
  });

  it("preserves legitimate multi-line content within the limit", () => {
    const schema = notesField(2000);
    const body = "Injured left shoulder.\nBack training in 6 weeks.";
    const r = schema.safeParse(body);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(body);
  });
});
