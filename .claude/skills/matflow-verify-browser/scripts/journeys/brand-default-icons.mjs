// Journey: the MatFlow.Studio default icons on the built site, signed out (25 Nov 2026).
// Anonymous homepage and login page at 1280 x 800 and 390 x 844. For each page it reads the icon, touch-icon and
// manifest links the HTML really carries, follows every one, and requires: HTTP 200, an image (or manifest) content
// type, never an HTML page, the stated pixel size, and bytes identical to the file in this repository (so the artwork
// is the brand kit's, not merely "a PNG"). It then follows the manifest's icons the same way and requires separate
// maskable files. Last, a real browser is pointed at the site through a logging pass-through, to record which icon
// address the browser itself asks for in a tab.
//   node journeys/brand-default-icons.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, ledger, APP, BASE } from "../lib.mjs";

const L = ledger("brand-default-icons");
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const repo = (rel) => fs.readFileSync(path.join(APP, rel));
/** Which repository file an address must serve. */
const FILE_FOR = {
  "/favicon.ico": "app/favicon.ico",
  "/icon.png": "app/icon.png",
  "/apple-touch-icon.png": "public/apple-touch-icon.png",
  "/icons/icon-192.png": "public/icons/icon-192.png",
  "/icons/icon-512.png": "public/icons/icon-512.png",
  "/icons/icon-maskable-192.png": "public/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png": "public/icons/icon-maskable-512.png",
};
const pngSize = (b) => (b.subarray(1, 4).toString() === "PNG" ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);
/** Sizes of the images inside an .ico (a 0 byte means 256). */
const icoSizes = (b) => (b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 ? Array.from({ length: b.readUInt16LE(4) }, (_, i) => b[6 + i * 16] || 256) : null);

async function follow(request, href) {
  const url = new URL(href, BASE);
  const res = await request.get(url.toString(), { maxRedirects: 0 });
  const body = await res.body().catch(() => Buffer.alloc(0));
  const type = res.headers()["content-type"] ?? "";
  const rel = FILE_FOR[url.pathname];
  const html = /text\/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body.subarray(0, 200).toString());
  return { path: url.pathname + url.search, status: res.status(), type, bytes: body.length, html, png: pngSize(body), ico: url.pathname.endsWith(".ico") ? icoSizes(body) : null, sha: sha(body), repoFile: rel ?? null, sameAsRepo: rel ? sha(repo(rel)) === sha(body) : null };
}

const browser = await chromium.launch();
try {
  const seen = {};
  for (const [tag, opts] of [["1280", { viewport: { width: 1280, height: 800 } }], ["390", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
    const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, ...opts });
    const page = await ctx.newPage();
    for (const route of ["/", "/login"]) {
      const id = `${route}@${tag}`;
      const nav = await page.goto(route, { waitUntil: "domcontentloaded" });
      const links = await page.evaluate(() => [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"], link[rel="shortcut icon"], link[rel="mask-icon"]')].map((l) => ({ rel: l.rel, href: l.getAttribute("href"), sizes: l.getAttribute("sizes"), type: l.getAttribute("type") })));
      seen[id] = links;
      const icons = links.filter((l) => /icon/.test(l.rel) && l.rel !== "apple-touch-icon");
      const apple = links.filter((l) => l.rel === "apple-touch-icon");
      const man = links.filter((l) => l.rel === "manifest");
      L.check(id, `the page answers 200 at ${new URL(page.url()).pathname} and carries tab icons, one touch icon and one manifest link`, nav.status() === 200 && icons.length >= 1 && apple.length === 1 && man.length === 1, { final: new URL(page.url()).pathname, links });
      // Tab icons: favicon.ico and /icon.png only, nothing under /icons/. That they are the plain MF tile (not the STUDIO tile) is checked from their pixels below.
      const got = [];
      for (const l of [...icons, ...apple]) got.push({ rel: l.rel, declared: l.sizes, ...(await follow(ctx.request, l.href)) });
      const tabOk = got.filter((g) => g.rel !== "apple-touch-icon").every((g) => ["/favicon.ico", "/icon.png"].includes(g.path.split("?")[0]));
      L.check(id, "tab icons are favicon.ico and /icon.png only, none of the installed-app files under /icons/", tabOk, got.map((g) => `${g.rel} ${g.path}`));
      // /icon.png has no content hash in its address, so it must carry a version or a returning browser keeps the old tile.
      const tabPaths = got.filter((g) => g.rel !== "apple-touch-icon").map((g) => g.path);
      L.check(id, "every tab icon address carries a version or content hash (favicon.ico?favicon.<hash>.ico, /icon.png?v=4)", tabPaths.length >= 2 && tabPaths.every((p) => /^\/favicon\.ico\?favicon\.[^.]+\.ico$/.test(p) || p === "/icon.png?v=4"), tabPaths);
      const good = got.every((g) => g.status === 200 && !g.html && /^image\//.test(g.type) && g.sameAsRepo === true && (g.png ? g.png.w === g.png.h : !!g.ico));
      L.check(id, "every icon link answers 200 with an image type, is not an HTML page, is square, and is byte-identical to the repository file", good, got.map((g) => ({ rel: g.rel, path: g.path, status: g.status, type: g.type, bytes: g.bytes, html: g.html, png: g.png, ico: g.ico, file: g.repoFile, same: g.sameAsRepo })));
      const a = got.find((g) => g.rel === "apple-touch-icon");
      L.check(id, "the touch icon is a 180 x 180 PNG", !!a && a.png?.w === 180 && a.png?.h === 180 && a.type.startsWith("image/png"), a && { path: a.path, png: a.png, type: a.type });
      const declared = got.filter((g) => g.png && g.declared).every((g) => g.declared === `${g.png.w}x${g.png.h}`);
      L.check(id, "each PNG is the size its link declares", declared, got.filter((g) => g.png).map((g) => `${g.path} declared ${g.declared} is ${g.png.w}x${g.png.h}`));

      // The manifest the page links, fetched separately as a browser would.
      const mres = await ctx.request.get(new URL(man[0].href, BASE).toString(), { maxRedirects: 0 });
      const mtype = mres.headers()["content-type"] ?? "";
      const mtext = await mres.text();
      let m = null;
      try { m = JSON.parse(mtext); } catch { /* reported below */ }
      L.check(id, "the manifest answers 200 as a manifest (JSON), not a page", mres.status() === 200 && /manifest\+json|application\/json/.test(mtype) && !!m, { href: man[0].href, status: mres.status(), type: mtype, parsed: !!m, name: m?.name, short_name: m?.short_name, start_url: m?.start_url });
      const mi = [];
      for (const i of m?.icons ?? []) mi.push({ purpose: i.purpose, sizes: i.sizes, mtype: i.type, ...(await follow(ctx.request, i.src)) });
      const shape = mi.map((i) => `${i.sizes} ${i.purpose}`).sort().join(", ") === "192x192 any, 192x192 maskable, 512x512 any, 512x512 maskable";
      const each = mi.every((i) => i.status === 200 && !i.html && i.type.startsWith("image/png") && i.sameAsRepo === true && `${i.png?.w}x${i.png?.h}` === i.sizes);
      const anyPaths = mi.filter((i) => i.purpose === "any").map((i) => i.path.split("?")[0]);
      const maskPaths = mi.filter((i) => i.purpose === "maskable").map((i) => i.path.split("?")[0]);
      const separate = maskPaths.length === 2 && maskPaths.every((p) => !anyPaths.includes(p)) && mi.filter((i) => i.purpose === "maskable").every((k) => !mi.some((o) => o.purpose === "any" && o.sha === k.sha));
      L.check(id, "manifest icons: 192 and 512, regular and maskable, each a 200 PNG of its stated size, byte-identical to the repository file", shape && each, mi.map((i) => ({ purpose: i.purpose, sizes: i.sizes, path: i.path, status: i.status, type: i.type, png: i.png, same: i.sameAsRepo })));
      L.check(id, "maskable icons are separate files with different bytes from the regular ones", separate, { anyPaths, maskPaths });
    }
    await ctx.close();
  }
  // The two pages, at both widths, carry the same links.
  const sets = Object.values(seen).map((l) => JSON.stringify(l));
  L.check("same", "homepage and login, desktop and phone, emit the same icon and manifest links", new Set(sets).size === 1, seen);
} finally {
  await browser.close().catch(() => {});
}

// Artwork: the maskable tile is full bleed (opaque corners) with the mark inside the 80% safe circle; the regular tile
// has clear corners; the tab tile is the plain MF (26 Nov 2026, evening), a different picture from the STUDIO tile of the installed app. Measured from the served files' pixels.
{
  const b2 = await chromium.launch();
  try {
    const page = await (await b2.newContext({ baseURL: BASE, ignoreHTTPSErrors: true })).newPage();
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const px = await page.evaluate(async () => {
      const read = async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
        // Non-background pixels outside the safe circle (radius 40% of the width): anything not the tile's black.
        let outside = 0, inside = 0, sum = 0;
        for (let i = 0; i < d.length; i += 1) sum += d[i];
        const r = c.width * 0.4, cx = c.width / 2, cy = c.height / 2;
        for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
          const [R, G, B, A] = at(x, y);
          const ink = A > 40 && (Math.abs(R - 17) > 40 || Math.abs(G - 17) > 40 || Math.abs(B - 17) > 40);
          if (!ink) continue;
          if (Math.hypot(x - cx, y - cy) > r) outside += 1; else inside += 1;
        }
        return { w: c.width, h: c.height, corner: at(1, 1), centreEdge: at(Math.floor(c.width / 2), 2), inkOutsideSafeCircle: outside, inkInside: inside, sum };
      };
      return { maskable512: await read("/icons/icon-maskable-512.png"), regular512: await read("/icons/icon-512.png?v=2"), tab: await read("/icon.png?v=4"), apple: await read("/apple-touch-icon.png?v=2") };
    });
    L.check("art", "maskable 512: opaque black to the corners, artwork present, and none of it outside the 80% safe circle", px.maskable512.corner[3] === 255 && px.maskable512.inkInside > 500 && px.maskable512.inkOutsideSafeCircle === 0, px.maskable512);
    L.check("art", "regular 512: rounded tile with clear corners and artwork present", px.regular512.corner[3] === 0 && px.regular512.inkInside > 500, px.regular512);
    L.check("art", "touch icon: opaque corners (iOS rounds it itself) and artwork present", px.apple.corner[3] === 255 && px.apple.inkInside > 50, px.apple);
    L.check("art", "tab tile: artwork present", px.tab.inkInside > 500, px.tab);
    L.check("art", "tab tile /icon.png is the plain MF: same size as the installed-app 512 tile but a different picture, with less artwork (no STUDIO box)", px.tab.w === px.regular512.w && px.tab.sum !== px.regular512.sum && px.tab.inkInside > 500, { tab: px.tab, studio512: px.regular512 });
  } finally {
    await b2.close().catch(() => {});
  }
}

// Which icon the browser itself asks for: a real browser (new headless Chromium, which loads tab icons) pointed at a
// plain pass-through that logs every address requested.
{
  const target = new URL(BASE);
  const hits = [];
  const https = await import("node:https");
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const up = (target.protocol === "https:" ? https : http).request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host }, rejectUnauthorized: false }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  let note = null;
  let pageImages = [];
  let b3;
  try {
    b3 = await chromium.launch({ channel: "chromium", headless: true }).catch(async (e) => { note = `new headless not available (${String(e).slice(0, 80)}); used a visible window`; return chromium.launch({ headless: false }); });
    const page = await b3.newPage();
    await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "load" }).catch((e) => { note = `${note ?? ""} goto: ${String(e).slice(0, 120)}`; });
    await page.waitForTimeout(4000);
    // Pictures the page itself shows (the sign-in screen's MatFlow mark is /icons/icon-512.png): not tab-icon requests.
    pageImages = await page.evaluate(() => [...document.images].map((i) => { const u = new URL(i.currentSrc || i.src); return u.pathname + u.search; })).catch(() => []);
  } finally {
    await b3?.close().catch(() => {});
    server.close();
  }
  const iconHits = hits.filter((u) => /favicon\.ico|\/icon\.png|\/icons\/|apple-touch-icon/.test(u) && !pageImages.includes(u));
  if (iconHits.length === 0) L.note("selected", "the browser asked for no icon through the logging pass-through; which candidate a browser picks was not observed", { hits: hits.slice(0, 12), note });
  else L.check("selected", "the browser's own tab-icon request is for favicon.ico or /icon.png, never an installed-app file under /icons/", iconHits.every((u) => /^\/(favicon\.ico|icon\.png)/.test(u)), { iconHits, pageImages, note });
}
console.log(`\n${L.summary()}  ledger ${L.path}`);
