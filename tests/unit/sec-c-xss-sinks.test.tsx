// Security campaign lane C — SEC-041 (stored / reflected / DOM XSS).
//
// MatFlow renders user content (member and club names, notes, import rows,
// audit reasons, error text) only through React text nodes, which escape. The
// XSS surface is therefore the places that step OUTSIDE that: raw-HTML props,
// DOM writes, URL-bearing attributes built from content, and HTML built as a
// string (mail — tests/unit/sec-c-email-template-escaping.test.ts). This file
// pins the raw-HTML/DOM sinks to the reviewed set and proves the URL builder
// and a representative render escape hostile content.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { linkify } from "@/lib/linkify";

const ROOT = path.resolve(__dirname, "../..");
function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) files(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const RUNTIME = [...files("app"), ...files("components"), ...files("lib")];
const code = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PAYLOAD = `secC<script>alert(1)</script>"'><img src=x onerror=alert(2)>`;

describe("SEC-041 raw-HTML and DOM-write sinks are the reviewed set", () => {
  it("dangerouslySetInnerHTML appears only in app/member/layout.tsx (two <style> tags) and the T9c club page JSON-LD", () => {
    const sites = RUNTIME.filter((f) => /dangerouslySetInnerHTML/.test(code(f)));
    expect(sites.sort()).toEqual(["app/[slug]/page.tsx", "app/member/layout.tsx"]);
    // The club page's one sink is the ld+json data block, fed only by the escaping serialiser.
    const club = code("app/[slug]/page.tsx");
    expect([...club.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+?)\s*\}\}/g)].map((m) => m[1])).toEqual([
      "serialiseJsonLd(clubJsonLd(page))",
    ]);
    expect(club).toMatch(/<script type="application\/ld\+json" dangerouslySetInnerHTML/);
    const src = code("app/member/layout.tsx");
    expect([...src.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([a-zA-Z]+)\s*\}\}/g)].map((m) => m[1])).toEqual(["lightModeCSS", "darkModeCSS"]);
  });

  it("the injected CSS interpolates only constants (no tenant or member value reaches the <style> text)", () => {
    const src = code("app/member/layout.tsx");
    for (const name of ["lightModeCSS", "darkModeCSS"]) {
      const m = src.match(new RegExp(`const ${name} = [^\`]*\`([\\s\\S]*?)\``));
      expect(m, name).not.toBeNull();
      const vars = [...m![1].matchAll(/\$\{([^}]+)\}/g)].map((x) => x[1].trim());
      expect(vars.every((v) => v === "textMain"), `${name} interpolates ${vars.join(",")}`).toBe(true);
    }
    // textMain is one of two literals.
    expect(src).toMatch(/const textMain\s*=\s*isLight \? "#0f172a"\s*: "#ffffff";/);
  });

  it("the club page JSON-LD serialiser leaves no '<' for a hostile club name", async () => {
    const { serialiseJsonLd } = await import("@/lib/public-club-page");
    const out = serialiseJsonLd({ name: PAYLOAD, description: "</script><script>alert(3)</script>" });
    expect(out).not.toContain("<");
    expect(JSON.parse(out).name).toBe(PAYLOAD);
  });

  it("no innerHTML/outerHTML/insertAdjacentHTML/document.write/srcdoc in runtime code", () => {
    const DOM = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(|srcDoc=|srcdoc=/;
    expect(DOM.test("el.innerHTML = x")).toBe(true); // control
    expect(RUNTIME.filter((f) => DOM.test(code(f)))).toEqual([]);
  });
});

describe("SEC-041 content-built links", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    `see https://ok.example/"onmouseover="alert(1) here`,
    `https://ok.example/<script>alert(1)</script>`,
  ])("linkify(%j) emits no executable href and no live markup", (input) => {
    const html = renderToStaticMarkup(<p>{linkify(input)}</p>);
    for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(/^https?:\/\//i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });

  it("positive control: a plain https URL becomes a link", () => {
    expect(renderToStaticMarkup(<p>{linkify("go to https://club.example/x now")}</p>)).toContain('href="https://club.example/x"');
  });

  it("React escapes a hostile member name in text and attribute positions", () => {
    const html = renderToStaticMarkup(
      <div title={PAYLOAD} data-name={PAYLOAD}>
        {PAYLOAD}
      </div>,
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;script&gt;");
  });

  it("React 19 refuses a javascript: href built from content", () => {
    const html = renderToStaticMarkup(<a href={"javascript:alert(1)"}>x</a>);
    expect(html).not.toMatch(/href="javascript:alert\(1\)"/);
  });
});
