// Fake GitHub releases API + fake vault-chat-server health/alert endpoints, for
// test-update.sh. Everything is driven by files in the fixture dir (argv[2]):
//   release.json        served at /repos/<owner>/<repo>/releases/latest
//   dl/<name>           served at /dl/<name> (the release's browser_download_url)
//   server-state        "down" or the version the (fake) running server reports
//   busy                integer; while > 0, /api/v1/health reports busy.runs=1 and
//                       decrements it (each poll = one finished step)
//   health.log          one line per /api/v1/health hit: "<busy-before>"
//   alerts.log          one JSON line per POST /api/v1/alert
// Writes its port to <fixture>/port once listening.
import http from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const read = (f, d = "") => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : d);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };
  if (req.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(url.pathname)) {
    return send(200, read("release.json", "{}"));
  }
  if (req.method === "GET" && url.pathname.startsWith("/dl/")) {
    const f = join(dir, "dl", decodeURIComponent(url.pathname.slice(4)));
    if (!existsSync(f)) return send(404, "not found", "text/plain");
    return send(200, readFileSync(f), "application/octet-stream");
  }
  if (req.method === "GET" && url.pathname === "/api/v1/health") {
    const state = read("server-state", "down");
    const busy = parseInt(read("busy", "0"), 10) || 0;
    appendFileSync(join(dir, "health.log"), `${busy}\n`);
    if (state === "down") return send(503, JSON.stringify({ ok: false }));
    if (busy > 0) writeFileSync(join(dir, "busy"), String(busy - 1));
    return send(200, JSON.stringify({ ok: true, version: state, busy: { runs: busy > 0 ? 1 : 0 } }));
  }
  if (req.method === "POST" && url.pathname === "/api/v1/alert") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      appendFileSync(join(dir, "alerts.log"), JSON.stringify(JSON.parse(body)) + "\n");
      send(200, JSON.stringify({ ok: true }));
    });
    return;
  }
  send(404, "not found", "text/plain");
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(dir, "port"), String(server.address().port));
});
