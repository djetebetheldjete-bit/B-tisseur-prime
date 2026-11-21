/* Simule Supabase (PostgREST + Storage) pour vérifier le mode production sans accès réseau. */
"use strict";
const http = require("http");
const KEY = "cle-service-test";
const rows = [];            // arch_projects
const files = new Map();    // "bucket/path" -> Buffer
const cohorts = [{ data: { label: "Session du 21 novembre 2026", startDate: "2026-11-21" } }, { data: { label: "Session du 7 novembre 2026", startDate: "2026-11-07" } }];
let calls = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); calls.push(req.method + " " + u.pathname);
  const auth = req.headers["authorization"] === "Bearer " + KEY && req.headers["apikey"] === KEY;
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const body = Buffer.concat(chunks);
    const send = (c, o, raw) => { res.writeHead(c, { "Content-Type": raw ? "application/zip" : "application/json" }); res.end(raw ? o : JSON.stringify(o)); };
    if (!auth) return send(401, { message: "bad key" });
    if (u.pathname === "/rest/v1/cohorts") return send(200, cohorts);
    if (u.pathname === "/rest/v1/arch_projects") {
      const idq = (u.searchParams.get("id") || "").replace("eq.", "");
      if (req.method === "GET") { let r = idq ? rows.filter((x) => x.id === idq) : rows.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)); return send(200, r); }
      if (req.method === "POST") { const r = JSON.parse(body); rows.push(r); return send(201, [r]); }
      if (req.method === "PATCH") { const i = rows.findIndex((x) => x.id === idq); if (i < 0) return send(200, []); Object.assign(rows[i], JSON.parse(body)); return send(200, [rows[i]]); }
      if (req.method === "DELETE") { const i = rows.findIndex((x) => x.id === idq); if (i >= 0) rows.splice(i, 1); return send(204, ""); }
    }
    const m = u.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (m) {
      const k = m[1] + "/" + decodeURIComponent(m[2]);
      if (req.method === "POST") { files.set(k, body); return send(200, { Key: k }); }
      if (req.method === "GET") return files.has(k) ? send(200, files.get(k), true) : send(404, { error: "nf" });
      if (req.method === "DELETE") { files.delete(k); return send(200, {}); }
    }
    send(404, { message: "route inconnue " + u.pathname });
  });
});
function call(port, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, opts.headers || {}); let body = opts.body;
    if (body && !Buffer.isBuffer(body)) { body = JSON.stringify(body); h["Content-Type"] = "application/json"; }
    if (body) h["Content-Length"] = Buffer.byteLength(body);
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => { const buf = Buffer.concat(c); let json = null; try { json = JSON.parse(buf.toString()); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, buf, json }); }); });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ok   " : "  FAIL ") + m); };
mock.listen(0, () => {
  process.env.SUPABASE_URL = "http://127.0.0.1:" + mock.address().port + "/"; process.env.SUPABASE_KEY = KEY;
  process.env.ADMIN_EMAIL = "f@t.com"; process.env.ADMIN_PASSWORD = "pw-test-long-1";
  const { server } = require("../server.js");
  server.listen(0, async () => {
    const port = server.address().port;
    try {
      console.log("Mode Supabase (simulé)");
      let r = await call(port, "GET", "/api/health"); ok(r.json.mode === "supabase", "mode Supabase actif");
      r = await call(port, "POST", "/api/login", { body: { email: "f@t.com", password: "pw-test-long-1" } });
      const H = { Cookie: String(r.headers["set-cookie"]).split(";")[0] };
      r = await call(port, "POST", "/api/projects", { headers: H, body: { title: "Appli ventes", learner: "Yao", session: "Session du 21 novembre 2026", url: "https://x.org" } });
      ok(r.status === 201, "projet créé dans arch_projects"); const id = r.json.project.id;
      const z = Buffer.alloc(3000, 1); z[0] = 0x50; z[1] = 0x4b;
      r = await call(port, "PUT", "/api/projects/" + id + "/zip?name=v1.zip", { headers: H, body: z }); ok(r.status === 200 && r.json.project.zipSize === 3000, "ZIP déposé dans le bucket");
      ok([...files.keys()].length === 1 && [...files.keys()][0].startsWith("batisseur-archives/" + id + "/"), "objet rangé dans batisseur-archives/<id>/");
      const z2 = Buffer.alloc(4500, 2); z2[0] = 0x50; z2[1] = 0x4b;
      r = await call(port, "PUT", "/api/projects/" + id + "/zip?name=final.zip", { headers: H, body: z2 }); ok(r.status === 200, "nouveau ZIP déposé");
      ok(files.size === 1, "ancien ZIP supprimé du bucket (une seule version)");
      r = await call(port, "GET", "/api/projects/" + id + "/zip", { headers: H }); ok(r.status === 200 && r.buf.equals(z2), "téléchargement via le serveur (bucket privé)");
      r = await call(port, "GET", "/api/sessions", { headers: H });
      ok(r.json.sessions.length === 2 && r.json.sessions[0].label === "Session du 7 novembre 2026", "sessions lues depuis la table cohorts de Bâtisseur");
      r = await call(port, "DELETE", "/api/projects/" + id, { headers: H }); ok(r.status === 200 && files.size === 0 && rows.length === 0, "suppression : ligne et ZIP effacés");
      ok(!calls.some((c) => /DELETE \/rest\/v1\/(?!arch_projects)/.test(c)) && !calls.some((c) => /(POST|PATCH|DELETE) \/rest\/v1\/cohorts/.test(c)), "aucune écriture sur les tables existantes de Bâtisseur");
    } catch (e) { fail++; console.log("ERREUR", e); }
    console.log("\n" + pass + " réussis, " + fail + " échoués"); server.close(); mock.close(); process.exit(fail ? 1 : 0);
  });
});
