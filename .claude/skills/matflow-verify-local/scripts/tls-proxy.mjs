// https://localhost:<pub> -> http://127.0.0.1:<port>, TLS terminated in front as Vercel's edge does (secure cookies work).
// x-lane-ip from the test client becomes x-forwarded-for, so rate-limit buckets can be separated per test lane.
//   node tls-proxy.mjs <port> <pub> <folder with cert.pem and key.pem>   (started by server.mjs)
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
const [port, pub] = process.argv.slice(2, 4).map(Number);
const tls = process.argv[4];
https.createServer({ key: fs.readFileSync(`${tls}/key.pem`), cert: fs.readFileSync(`${tls}/cert.pem`) }, (req, res) => {
  const headers = { ...req.headers };
  const lane = typeof headers["x-lane-ip"] === "string" && /^[0-9.]{7,15}$/.test(headers["x-lane-ip"]) ? headers["x-lane-ip"] : "127.0.0.1";
  for (const h of ["x-lane-ip", "x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for", "x-forwarded-proto", "x-forwarded-host"]) delete headers[h];
  const up = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: { ...headers, "x-forwarded-proto": "https", "x-forwarded-host": `localhost:${pub}`, "x-forwarded-for": lane } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(502); res.end("proxy upstream error"); });
  req.pipe(up);
}).listen(pub, "127.0.0.1", () => console.log(`tls proxy https://localhost:${pub} -> 127.0.0.1:${port}`));
