// TLS front for the load-test servers, as Vercel's edge is for production: https://localhost:<pub> round-robin to
// one or more `next start` instances on 127.0.0.1 (each its own process with its own pool of 5, as each Vercel
// instance has). Same header handling as the verification skill's tls-proxy.mjs: the client's x-lane-ip (or
// x-real-ip) becomes the only x-forwarded-for hop, so per-IP rate limits see one address per simulated device.
//   node scripts/loadtest/proxy.mjs <pub port> <tls folder with cert.pem and key.pem> <port>[,<port>…]
import https from "node:https";
import http from "node:http";
import fs from "node:fs";

const [pubArg, tls, portsArg] = process.argv.slice(2);
const pub = Number(pubArg);
const ports = String(portsArg ?? "").split(",").map(Number).filter((p) => p > 0);
if (!pub || !tls || !ports.length) { console.log("usage: node proxy.mjs <pub> <tls dir> <port>[,<port>…]"); process.exit(2); }

const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const lane = (v) => (typeof v === "string" && IPV4.test(v) && v.split(".").every((o) => Number(o) <= 255) ? v : null);
let next = 0;

https.createServer({ key: fs.readFileSync(`${tls}/key.pem`), cert: fs.readFileSync(`${tls}/cert.pem`) }, (req, res) => {
  const headers = { ...req.headers };
  const ip = lane(headers["x-lane-ip"]) ?? lane(headers["x-real-ip"]) ?? "127.0.0.1";
  for (const h of ["x-lane-ip", "x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for", "x-forwarded-proto", "x-forwarded-host"]) delete headers[h];
  const port = ports[next++ % ports.length];
  const up = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, agent, headers: { ...headers, "x-forwarded-proto": "https", "x-forwarded-host": `localhost:${pub}`, "x-forwarded-for": ip } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("proxy upstream error"); });
  req.pipe(up);
}).listen(pub, "127.0.0.1", () => console.log(`load-test proxy https://localhost:${pub} -> 127.0.0.1:${ports.join(",")}`));
