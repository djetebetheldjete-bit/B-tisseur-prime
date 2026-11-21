/* Bâtisseur Archives — archive des projets pour le formateur.
   Aucune dépendance (Node >= 18). Deux modes :
   - SUPABASE_URL + SUPABASE_KEY définis : table arch_projects + bucket privé « batisseur-archives »
   - sinon : fichiers locaux (data/) — pratique pour essayer l'application sur son ordinateur.
   Accès réservé au formateur : ADMIN_EMAIL + ADMIN_PASSWORD (variables d'environnement). */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

const PORT = parseInt(process.env.PORT || "3000", 10);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const USE_DB = !!(SUPABASE_URL && SUPABASE_KEY);
const BUCKET = process.env.ARCHIVE_BUCKET || "batisseur-archives";
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const SESSION_SECRET = process.env.SESSION_SECRET || (ADMIN_PASSWORD ? "arch|" + ADMIN_PASSWORD : crypto.randomBytes(32).toString("hex"));
const COOKIE = "arch_sess";
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14; // 14 jours
const COOKIE_SECURE = (process.env.NODE_ENV === "production" || process.env.RENDER) ? "; Secure" : "";
const MAX_ZIP = 50 * 1024 * 1024; // 50 Mo (limite du bucket)

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };

/* ---------- utilitaires ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Fichier trop volumineux."), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 200 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch (e) { throw Object.assign(new Error("Requête invalide."), { code: 400 }); }
}
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function clean(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max); }
function safeFileName(n) {
  const base = String(n || "projet.zip").replace(/\\/g, "/").split("/").pop();
  const s = base.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 90) || "projet.zip";
  return /\.zip$/i.test(s) ? s : s + ".zip";
}
function validUrl(u) {
  if (!u) return true;
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:"; } catch (e) { return false; }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- session formateur (jeton signé, sans stockage) ---------- */
function sign(s) { return crypto.createHmac("sha256", SESSION_SECRET).update(s).digest("base64url"); }
function makeToken() { const exp = String(Date.now() + SESSION_TTL); return exp + "." + sign("v1|" + exp); }
function parseCookies(req) {
  const out = {}; String(req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function isAuthed(req) {
  const t = parseCookies(req)[COOKIE]; if (!t) return false;
  const i = t.indexOf("."); if (i < 1) return false;
  const exp = t.slice(0, i), mac = t.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const good = sign("v1|" + exp);
  return mac.length === good.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good));
}
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(); const a = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, a); return a.length >= 8;
}
function noteFail(ip) { const a = attempts.get(ip) || []; a.push(Date.now()); attempts.set(ip, a); }

/* ---------- stockage : Supabase ou fichiers locaux ---------- */
async function sb(p, opts) {
  opts = opts || {};
  const r = await fetch(SUPABASE_URL + p, {
    method: opts.method || "GET",
    headers: Object.assign({ apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }, opts.headers || {}),
    body: opts.body
  });
  return r;
}
async function sbJson(p, opts) {
  const r = await sb(p, opts);
  const txt = await r.text();
  if (!r.ok) throw new Error("Supabase " + r.status + " : " + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}
const COLS = "id,title,learner,session_label,kind,live_url,notes,zip_path,zip_name,zip_size,final_at,created_at,updated_at";

const LOCAL_DB = path.join(DATA_DIR, "projects.json");
const LOCAL_ZIPS = path.join(DATA_DIR, "zips");
function localLoad() { try { return JSON.parse(fs.readFileSync(LOCAL_DB, "utf8")); } catch (e) { return []; } }
function localSave(a) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LOCAL_DB, JSON.stringify(a, null, 2)); }

const store = {
  async list() {
    if (USE_DB) return sbJson(`/rest/v1/arch_projects?select=${COLS}&order=created_at.desc`);
    return localLoad().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  },
  async get(id) {
    if (USE_DB) { const r = await sbJson(`/rest/v1/arch_projects?id=eq.${id}&select=${COLS}`); return r && r[0] || null; }
    return localLoad().find((p) => p.id === id) || null;
  },
  async insert(rec) {
    if (USE_DB) { const r = await sbJson(`/rest/v1/arch_projects`, { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(rec) }); return r[0]; }
    const a = localLoad(); a.push(rec); localSave(a); return rec;
  },
  async update(id, fields) {
    fields.updated_at = new Date().toISOString();
    if (USE_DB) { const r = await sbJson(`/rest/v1/arch_projects?id=eq.${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(fields) }); return r && r[0] || null; }
    const a = localLoad(); const i = a.findIndex((p) => p.id === id); if (i < 0) return null;
    a[i] = Object.assign(a[i], fields); localSave(a); return a[i];
  },
  async remove(id) {
    if (USE_DB) { await sbJson(`/rest/v1/arch_projects?id=eq.${id}`, { method: "DELETE" }); return; }
    localSave(localLoad().filter((p) => p.id !== id));
  },
  async putFile(objPath, buf) {
    if (USE_DB) {
      const enc = objPath.split("/").map(encodeURIComponent).join("/");
      const r = await sb(`/storage/v1/object/${BUCKET}/${enc}`, { method: "POST", headers: { "Content-Type": "application/zip", "x-upsert": "true" }, body: buf });
      if (!r.ok) throw new Error("Stockage " + r.status + " : " + (await r.text()).slice(0, 200));
      return;
    }
    const f = path.join(LOCAL_ZIPS, objPath); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf);
  },
  async delFile(objPath) {
    if (!objPath) return;
    try {
      if (USE_DB) { const enc = objPath.split("/").map(encodeURIComponent).join("/"); await sb(`/storage/v1/object/${BUCKET}/${enc}`, { method: "DELETE" }); return; }
      const f = path.join(LOCAL_ZIPS, objPath); fs.rmSync(f, { force: true });
    } catch (e) { console.error("delFile:", e.message); }
  },
  async getFileStream(objPath) {
    if (USE_DB) {
      const enc = objPath.split("/").map(encodeURIComponent).join("/");
      const r = await sb(`/storage/v1/object/${BUCKET}/${enc}`);
      if (!r.ok || !r.body) return null;
      return { stream: Readable.fromWeb(r.body), size: Number(r.headers.get("content-length")) || null };
    }
    const f = path.join(LOCAL_ZIPS, objPath);
    if (!fs.existsSync(f)) return null;
    return { stream: fs.createReadStream(f), size: fs.statSync(f).size };
  },
  // Sessions déjà créées dans Bâtisseur (table cohorts), pour proposer une liste de choix.
  async cohortLabels() {
    if (!USE_DB) return [];
    try {
      const r = await sbJson(`/rest/v1/cohorts?select=data`);
      return (r || []).map((x) => x && x.data).filter(Boolean)
        .sort((a, b) => String(a.startDate || "").localeCompare(String(b.startDate || "")))
        .map((c) => ({ label: c.label, startDate: c.startDate || null }));
    } catch (e) { return []; }
  }
};

/* ---------- API ---------- */
function pub(p) {
  return { id: p.id, title: p.title, learner: p.learner, session: p.session_label, kind: p.kind, url: p.live_url, notes: p.notes,
    hasZip: !!p.zip_path, zipName: p.zip_name || null, zipSize: p.zip_size == null ? null : Number(p.zip_size), finalAt: p.final_at || null,
    createdAt: p.created_at, updatedAt: p.updated_at };
}
const KINDS = ["site", "application", "autre"];
function fieldsFrom(b, partial) {
  const f = {};
  const set = (k, col, max) => { if (b[k] !== undefined) f[col] = clean(b[k], max); };
  set("title", "title", 140); set("learner", "learner", 140); set("session", "session_label", 140); set("url", "live_url", 500); set("notes", "notes", 4000);
  if (b.kind !== undefined) f.kind = KINDS.includes(b.kind) ? b.kind : "site";
  if (!partial || f.title !== undefined) { if (!f.title) throw Object.assign(new Error("Le titre du projet est obligatoire."), { code: 400 }); }
  if (f.live_url !== undefined && !validUrl(f.live_url)) throw Object.assign(new Error("Le lien doit commencer par http:// ou https://"), { code: 400 });
  return f;
}

async function api(req, res, url) {
  const m = req.method; const p = url.pathname;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  if (p === "/api/health") return sendJson(res, 200, { ok: true, mode: USE_DB ? "supabase" : "local" });

  if (p === "/api/login" && m === "POST") {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return sendJson(res, 503, { error: "Accès non configuré : renseignez ADMIN_EMAIL et ADMIN_PASSWORD." });
    if (tooMany(ip)) return sendJson(res, 429, { error: "Trop d'essais. Réessayez dans quelques minutes." });
    const b = await readJson(req);
    const okMail = safeEq(String(b.email || "").trim().toLowerCase(), ADMIN_EMAIL);
    const okPass = safeEq(String(b.password || ""), ADMIN_PASSWORD);
    if (!(okMail && okPass)) { noteFail(ip); return sendJson(res, 401, { error: "E-mail ou mot de passe incorrect." }); }
    res.setHeader("Set-Cookie", `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax${COOKIE_SECURE}; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/logout" && m === "POST") {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax${COOKIE_SECURE}; Max-Age=0`);
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/me") return sendJson(res, 200, { authed: isAuthed(req), mode: USE_DB ? "supabase" : "local" });

  if (!isAuthed(req)) return sendJson(res, 401, { error: "Connexion requise." });

  if (p === "/api/projects" && m === "GET") { const l = await store.list(); return sendJson(res, 200, { projects: l.map(pub) }); }
  if (p === "/api/sessions" && m === "GET") {
    const fromCohorts = await store.cohortLabels();
    const used = (await store.list()).map((x) => x.session_label).filter(Boolean);
    const seen = new Set(); const out = [];
    fromCohorts.forEach((c) => { if (c.label && !seen.has(c.label)) { seen.add(c.label); out.push(c); } });
    used.forEach((l) => { if (!seen.has(l)) { seen.add(l); out.push({ label: l, startDate: null }); } });
    return sendJson(res, 200, { sessions: out });
  }
  if (p === "/api/projects" && m === "POST") {
    const f = fieldsFrom(await readJson(req), false);
    const now = new Date().toISOString();
    const rec = Object.assign({ id: crypto.randomUUID(), learner: "", session_label: "", kind: "site", live_url: "", notes: "", zip_path: null, zip_name: null, zip_size: null, final_at: null, created_at: now, updated_at: now }, f);
    const saved = await store.insert(rec);
    return sendJson(res, 201, { project: pub(saved) });
  }
  if (p === "/api/export.csv" && m === "GET") {
    const l = await store.list();
    const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const rows = [["Titre", "Apprenant", "Session", "Type", "Lien en ligne", "ZIP", "Ajouté le"].map(q).join(";")]
      .concat(l.map((x) => [x.title, x.learner, x.session_label, x.kind, x.live_url, x.zip_name || "", String(x.created_at).slice(0, 10)].map(q).join(";")));
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="batisseur-archives.csv"' });
    return res.end("﻿" + rows.join("\r\n"));
  }

  const mm = p.match(/^\/api\/projects\/([^/]+)(?:\/(zip))?$/);
  if (mm) {
    const id = mm[1], sub = mm[2];
    if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "Projet introuvable." });
    const cur = await store.get(id);
    if (!cur) return sendJson(res, 404, { error: "Projet introuvable." });

    if (!sub && m === "PUT") {
      const f = fieldsFrom(await readJson(req), true);
      const saved = await store.update(id, f);
      return sendJson(res, 200, { project: pub(saved) });
    }
    if (!sub && m === "DELETE") {
      await store.delFile(cur.zip_path);
      await store.remove(id);
      return sendJson(res, 200, { ok: true });
    }
    if (sub === "zip" && m === "PUT") {
      const buf = await readBody(req, MAX_ZIP);
      if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return sendJson(res, 400, { error: "Ce fichier n'est pas un ZIP valide." });
      const name = safeFileName(url.searchParams.get("name"));
      const objPath = id + "/" + Date.now() + "-" + name;
      await store.putFile(objPath, buf);              // 1. on dépose la nouvelle version
      const saved = await store.update(id, { zip_path: objPath, zip_name: name, zip_size: buf.length, final_at: new Date().toISOString() });
      await store.delFile(cur.zip_path);              // 2. puis on supprime l'ancienne (la version finale remplace)
      return sendJson(res, 200, { project: pub(saved) });
    }
    if (sub === "zip" && m === "GET") {
      if (!cur.zip_path) return sendJson(res, 404, { error: "Aucun ZIP pour ce projet." });
      const f = await store.getFileStream(cur.zip_path);
      if (!f) return sendJson(res, 404, { error: "Fichier introuvable dans le stockage." });
      const h = { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${cur.zip_name || "projet.zip"}"`, "Cache-Control": "no-store" };
      if (f.size) h["Content-Length"] = f.size;
      res.writeHead(200, h);
      f.stream.on("error", () => res.destroy());
      return f.stream.pipe(res);
    }
    if (sub === "zip" && m === "DELETE") {
      await store.delFile(cur.zip_path);
      const saved = await store.update(id, { zip_path: null, zip_name: null, zip_size: null, final_at: null });
      return sendJson(res, 200, { project: pub(saved) });
    }
  }
  return sendJson(res, 404, { error: "Introuvable." });
}

/* ---------- fichiers statiques ---------- */
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const f = path.normalize(path.join(PUBLIC_DIR, p));
  if (!f.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Introuvable"); }
  const ext = path.extname(f).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400" });
  fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error("Erreur :", e);
    if (!res.headersSent) sendJson(res, code, { error: code === 500 ? "Erreur du serveur." : e.message });
    else res.destroy();
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log("Bâtisseur Archives — port " + PORT + " — stockage : " + (USE_DB ? "Supabase" : "fichiers locaux"));
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) console.warn("ATTENTION : ADMIN_EMAIL / ADMIN_PASSWORD non définis — connexion impossible.");
  });
}
module.exports = { server };
