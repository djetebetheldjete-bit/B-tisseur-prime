/* Tests de bout en bout en mode local (sans Supabase). Lancer : npm test */
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arch-"));
process.env.DATA_DIR = tmp; process.env.ADMIN_EMAIL = "Formateur@Test.com"; process.env.ADMIN_PASSWORD = "motdepasse-test-123";
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_KEY;
const { server } = require("../server.js");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ok   " + m); } else { fail++; console.log("  FAIL " + m); } }

function call(port, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, opts.headers || {});
    let body = opts.body;
    if (body && !Buffer.isBuffer(body) && typeof body === "object") { body = JSON.stringify(body); h["Content-Type"] = "application/json"; }
    if (body) h["Content-Length"] = Buffer.byteLength(body);
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
      const ch = []; res.on("data", (c) => ch.push(c)); res.on("end", () => {
        const buf = Buffer.concat(ch); let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}
function fakeZip(n) { const b = Buffer.alloc(n, 7); b[0] = 0x50; b[1] = 0x4b; b[2] = 3; b[3] = 4; return b; }

server.listen(0, async () => {
  const port = server.address().port;
  try {
    console.log("Accès");
    let r = await call(port, "GET", "/api/projects"); ok(r.status === 401, "liste refusée sans connexion");
    r = await call(port, "POST", "/api/login", { body: { email: "formateur@test.com", password: "mauvais" } }); ok(r.status === 401, "mauvais mot de passe refusé");
    r = await call(port, "POST", "/api/login", { body: { email: "formateur@test.com", password: "motdepasse-test-123" } });
    ok(r.status === 200, "connexion formateur (e-mail insensible à la casse)");
    const cookie = String(r.headers["set-cookie"] || "").split(";")[0]; ok(/^arch_sess=/.test(cookie), "cookie de session posé");
    const H = { Cookie: cookie };
    r = await call(port, "GET", "/api/me", { headers: { Cookie: cookie + "x" } }); ok(r.json && r.json.authed === false, "cookie falsifié refusé");

    console.log("Projets");
    r = await call(port, "POST", "/api/projects", { headers: H, body: { title: "" } }); ok(r.status === 400, "titre obligatoire");
    r = await call(port, "POST", "/api/projects", { headers: H, body: { title: "x", url: "javascript:alert(1)" } }); ok(r.status === 400, "lien javascript: refusé");
    r = await call(port, "POST", "/api/projects", { headers: H, body: { title: "Site de la boulangerie", learner: "Awa Koné", session: "Session du 21 novembre 2026", kind: "site", url: "https://exemple.com" } });
    ok(r.status === 201 && r.json.project.id, "création d'un projet"); const id = r.json.project.id;
    r = await call(port, "PUT", "/api/projects/" + id, { headers: H, body: { notes: "Version finale validée" } });
    ok(r.status === 200 && r.json.project.notes === "Version finale validée" && r.json.project.title === "Site de la boulangerie", "modification partielle (le reste est conservé)");

    console.log("ZIP (version finale)");
    r = await call(port, "PUT", "/api/projects/" + id + "/zip?name=test.zip", { headers: H, body: Buffer.from("pas un zip du tout, vraiment pas") }); ok(r.status === 400, "fichier non-ZIP refusé");
    const z1 = fakeZip(5000);
    r = await call(port, "PUT", "/api/projects/" + id + "/zip?name=" + encodeURIComponent("Boulangerie v1.zip"), { headers: Object.assign({ "Content-Type": "application/zip" }, H), body: z1 });
    ok(r.status === 200 && r.json.project.hasZip && r.json.project.zipSize === 5000, "dépôt du ZIP");
    const first = fs.readdirSync(path.join(tmp, "zips", id)); ok(first.length === 1, "1 fichier stocké");
    const z2 = fakeZip(8000);
    r = await call(port, "PUT", "/api/projects/" + id + "/zip?name=" + encodeURIComponent("../../Final é.zip"), { headers: Object.assign({ "Content-Type": "application/zip" }, H), body: z2 });
    ok(r.status === 200 && r.json.project.zipSize === 8000 && !/[\/\\]/.test(r.json.project.zipName), "nouveau ZIP, nom assaini");
    const after = fs.readdirSync(path.join(tmp, "zips", id)); ok(after.length === 1 && after[0] !== first[0], "l'ancien ZIP est remplacé (une seule version gardée)");
    r = await call(port, "GET", "/api/projects/" + id + "/zip", { headers: H });
    ok(r.status === 200 && r.buf.equals(z2) && /attachment/.test(r.headers["content-disposition"]), "téléchargement = la version finale");
    r = await call(port, "GET", "/api/projects/" + id + "/zip"); ok(r.status === 401, "téléchargement refusé sans connexion");
    r = await call(port, "GET", "/api/projects/..%2F..%2Fetc/zip", { headers: H }); ok(r.status === 404, "identifiant invalide refusé");

    console.log("Liste, sessions, export");
    r = await call(port, "GET", "/api/projects", { headers: H }); ok(r.json.projects.length === 1 && r.json.projects[0].hasZip, "liste");
    r = await call(port, "GET", "/api/sessions", { headers: H }); ok(r.json.sessions.some((s) => s.label === "Session du 21 novembre 2026"), "sessions déduites des projets");
    r = await call(port, "GET", "/api/export.csv", { headers: H }); ok(/Awa Koné/.test(r.buf.toString("utf8")) && /csv/.test(r.headers["content-type"]), "export CSV");

    console.log("Suppression");
    r = await call(port, "DELETE", "/api/projects/" + id + "/zip", { headers: H }); ok(r.status === 200 && !r.json.project.hasZip, "suppression du ZIP seul");
    ok(fs.readdirSync(path.join(tmp, "zips", id)).length === 0, "fichier effacé du stockage");
    await call(port, "PUT", "/api/projects/" + id + "/zip?name=a.zip", { headers: H, body: fakeZip(1000) });
    r = await call(port, "DELETE", "/api/projects/" + id, { headers: H }); ok(r.status === 200, "suppression du projet");
    ok(!fs.existsSync(path.join(tmp, "zips", id)) || fs.readdirSync(path.join(tmp, "zips", id)).length === 0, "ZIP effacé avec le projet");
    r = await call(port, "GET", "/api/projects", { headers: H }); ok(r.json.projects.length === 0, "archive vide");

    console.log("Pages et sécurité");
    r = await call(port, "GET", "/"); ok(r.status === 200 && /Bâtisseur Archives/.test(r.buf.toString("utf8")), "page d'accueil servie");
    r = await call(port, "GET", "/..%2Fserver.js"); ok(r.status === 404, "pas de sortie du dossier public");
    r = await call(port, "GET", "/server.js"); ok(r.status === 404, "code serveur non exposé");
    ok(r.headers["x-frame-options"] === "DENY", "en-têtes de sécurité");
    for (let i = 0; i < 9; i++) await call(port, "POST", "/api/login", { body: { email: "a@b.c", password: "x" } });
    r = await call(port, "POST", "/api/login", { body: { email: "formateur@test.com", password: "motdepasse-test-123" } }); ok(r.status === 429, "blocage après trop d'essais");
  } catch (e) { fail++; console.log("ERREUR", e); }
  console.log("\n" + pass + " réussis, " + fail + " échoués");
  server.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
});
