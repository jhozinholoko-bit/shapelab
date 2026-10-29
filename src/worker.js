/* ShapeLab · servidor (Cloudflare Worker + banco D1)
   Serve o app (pasta public/) e responde em /api/<função>.
   Login por decisão de produto (risco aceito pelo dono do app):
     - Cadastro: nome + data de nascimento + PIN de 4 dígitos.
     - Entrar: nome + data. Se houver UMA conta com esse par, entra direto.
     - Se houver DUAS ou mais, pede o PIN para desempatar.
   O PIN fica guardado com hash (PBKDF2 + sal). 5 PINs errados em 15 min bloqueiam o par nome+data por 15 min.
   Os tokens de sessão ficam guardados só como hash. Ninguém acessa o banco direto: tudo passa por aqui. */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sl_users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, name_key TEXT NOT NULL, birth TEXT NOT NULL, pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sl_users_lookup ON sl_users (name_key, birth)`,
  `CREATE TABLE IF NOT EXISTS sl_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sl_tokens_user ON sl_tokens (user_id)`,
  `CREATE TABLE IF NOT EXISTS sl_state (user_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sl_sessions (user_id TEXT NOT NULL, id TEXT NOT NULL, date TEXT, data TEXT NOT NULL, PRIMARY KEY (user_id, id))`,
  `CREATE INDEX IF NOT EXISTS sl_sessions_date ON sl_sessions (user_id, date)`,
  `CREATE TABLE IF NOT EXISTS sl_photos (user_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, date TEXT, data TEXT NOT NULL, PRIMARY KEY (user_id, id))`,
  `CREATE INDEX IF NOT EXISTS sl_photos_date ON sl_photos (user_id, date)`,
  `CREATE TABLE IF NOT EXISTS sl_pin_failures (name_key TEXT NOT NULL, birth TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sl_pin_failures_lookup ON sl_pin_failures (name_key, birth, at)`
];
let schemaReady = null;
const ensureSchema = db => schemaReady || (schemaReady = db.batch(SCHEMA.map(q => db.prepare(q))).catch(e => { schemaReady = null; throw e; }));

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 2000}, key, 256));
}
const nameKey = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const cleanName = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 40);
const validBirth = b => /^\d{4}-\d{2}-\d{2}$/.test(String(b || "")) && !isNaN(Date.parse(b)) && b >= "1900-01-01" && b <= new Date().toISOString().slice(0, 10);

class AppError extends Error {}
const fail = msg => { throw new AppError(msg); };

async function issueToken(db, uid, remember) {
  const t = randHex(32), exp = Date.now() + (remember ? 365 : 0.5) * 864e5;
  await db.prepare("INSERT INTO sl_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(t), uid, exp).run();
  return t;
}
async function uidOf(db, token) {
  if (!token || typeof token !== "string") fail("not_authenticated");
  const r = await db.prepare("SELECT user_id FROM sl_tokens WHERE token_hash = ? AND expires_at > ?").bind(await sha256(token), Date.now()).first();
  if (!r) fail("not_authenticated");
  return r.user_id;
}
const json = s => { try { return JSON.parse(s); } catch { return null; } };
const sizeOf = v => enc.encode(JSON.stringify(v ?? null)).length;

const API = {
  async signup(db, a) {
    const name = cleanName(a.p_name), key = nameKey(name), birth = String(a.p_birth || ""), pin = String(a.p_pin || "");
    if (key.length < 2) return {status: "invalid_name"};
    if (!validBirth(birth)) return {status: "invalid_birth"};
    if (!/^\d{4}$/.test(pin)) return {status: "invalid_pin_format"};
    const same = (await db.prepare("SELECT pin_salt, pin_hash FROM sl_users WHERE name_key = ? AND birth = ?").bind(key, birth).all()).results;
    for (const u of same) if (await pinHash(pin, u.pin_salt) === u.pin_hash) return {status: "pin_taken"};
    const id = crypto.randomUUID(), salt = randHex(16), now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO sl_users (id, display_name, name_key, birth, pin_salt, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, name, key, birth, salt, await pinHash(pin, salt), now),
      db.prepare("INSERT INTO sl_state (user_id, state, updated_at) VALUES (?, ?, ?)").bind(id, JSON.stringify({profile: {name}}), now)
    ]);
    return {status: "ok", token: await issueToken(db, id, a.p_remember !== false), name, user_id: id};
  },
  async login(db, a) {
    const key = nameKey(a.p_name), birth = String(a.p_birth || ""), pin = a.p_pin == null ? "" : String(a.p_pin);
    const users = (await db.prepare("SELECT id, display_name, pin_salt, pin_hash FROM sl_users WHERE name_key = ? AND birth = ?").bind(key, birth).all()).results;
    if (!users.length) return {status: "not_found"};
    const remember = a.p_remember !== false;
    if (users.length === 1) return {status: "ok", token: await issueToken(db, users[0].id, remember), name: users[0].display_name, user_id: users[0].id};
    if (!pin) return {status: "pin_required"};
    const since = Date.now() - 15 * 60e3;
    const f = await db.prepare("SELECT COUNT(*) AS n FROM sl_pin_failures WHERE name_key = ? AND birth = ? AND at > ?").bind(key, birth, since).first();
    if (f && f.n >= 5) return {status: "locked"};
    for (const u of users) if (await pinHash(pin, u.pin_salt) === u.pin_hash) return {status: "ok", token: await issueToken(db, u.id, remember), name: u.display_name, user_id: u.id};
    await db.batch([
      db.prepare("INSERT INTO sl_pin_failures (name_key, birth, at) VALUES (?, ?, ?)").bind(key, birth, Date.now()),
      db.prepare("DELETE FROM sl_pin_failures WHERE at < ?").bind(Date.now() - 864e5)
    ]);
    return {status: "invalid_pin"};
  },
  async logout(db, a) { if (a.p_token) await db.prepare("DELETE FROM sl_tokens WHERE token_hash = ?").bind(await sha256(String(a.p_token))).run(); return true; },
  async me(db, a) { const u = await uidOf(db, a.p_token); const r = await db.prepare("SELECT id, display_name FROM sl_users WHERE id = ?").bind(u).first(); return {user_id: r.id, name: r.display_name}; },
  async delete_account(db, a) {
    const u = await uidOf(db, a.p_token);
    await db.batch(["sl_tokens", "sl_state", "sl_sessions", "sl_photos"].map(t => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(u)).concat(db.prepare("DELETE FROM sl_users WHERE id = ?").bind(u)));
    return true;
  },
  async get_state(db, a) {
    const u = await uidOf(db, a.p_token);
    const r = await db.prepare("SELECT state, updated_at FROM sl_state WHERE user_id = ?").bind(u).first();
    return r ? {exists: true, state: json(r.state) || {}, updated_at: new Date(r.updated_at).toISOString()} : {exists: false};
  },
  async save_state(db, a) {
    const u = await uidOf(db, a.p_token);
    if (sizeOf(a.p_state) > 1e6) fail("state_too_large");
    await db.prepare("INSERT INTO sl_state (user_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at").bind(u, JSON.stringify(a.p_state ?? {}), Date.now()).run();
    return true;
  },
  async list_sessions(db, a) {
    const u = await uidOf(db, a.p_token), lim = Math.min(Math.max(parseInt(a.p_limit) || 400, 1), 1000);
    return (await db.prepare("SELECT data FROM sl_sessions WHERE user_id = ? ORDER BY date DESC LIMIT ?").bind(u, lim).all()).results.map(r => json(r.data)).filter(Boolean);
  },
  async save_session(db, a) {
    const u = await uidOf(db, a.p_token), id = String(a.p_id || "").slice(0, 64), d = a.p_data || {};
    if (!id) fail("invalid_id"); if (sizeOf(d) > 2e5) fail("session_too_large");
    await db.prepare("INSERT INTO sl_sessions (user_id, id, date, data) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET date = excluded.date, data = excluded.data").bind(u, id, String(d.date || ""), JSON.stringify(d)).run();
    return true;
  },
  async delete_session(db, a) { const u = await uidOf(db, a.p_token); await db.prepare("DELETE FROM sl_sessions WHERE user_id = ? AND id = ?").bind(u, String(a.p_id || "")).run(); return true; },
  async list_photos(db, a) {
    const u = await uidOf(db, a.p_token), lim = Math.min(Math.max(parseInt(a.p_limit) || 60, 1), 200);
    return (await db.prepare("SELECT data FROM sl_photos WHERE user_id = ? ORDER BY date DESC LIMIT ?").bind(u, lim).all()).results.map(r => json(r.data)).filter(Boolean);
  },
  async save_photo(db, a) {
    const u = await uidOf(db, a.p_token), id = String(a.p_id || "").slice(0, 64), d = a.p_data || {};
    if (!id) fail("invalid_id"); if (sizeOf(d) > 6e5) fail("photo_too_large");
    const n = await db.prepare("SELECT COUNT(*) AS n FROM sl_photos WHERE user_id = ?").bind(u).first();
    if (n && n.n >= 200) fail("too_many_photos");
    await db.prepare("INSERT INTO sl_photos (user_id, id, session_id, date, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET session_id = excluded.session_id, date = excluded.date, data = excluded.data").bind(u, id, d.sessionId ? String(d.sessionId) : null, String(d.date || ""), JSON.stringify(d)).run();
    return true;
  },
  async delete_photo(db, a) { const u = await uidOf(db, a.p_token); await db.prepare("DELETE FROM sl_photos WHERE user_id = ? AND id = ?").bind(u, String(a.p_id || "")).run(); return true; }
};

const reply = (status, body) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/api\/([a-z_]+)$/);
    if (!m) return env.ASSETS.fetch(req);
    if (req.method !== "POST") return reply(405, {message: "method_not_allowed"});
    const fn = API[m[1]];
    if (!fn) return reply(404, {message: "not_found"});
    let args = {};
    try { const t = await req.text(); if (t.length > 1.5e6) return reply(413, {message: "too_large"}); args = t ? JSON.parse(t) : {}; } catch { return reply(400, {message: "bad_json"}); }
    try {
      await ensureSchema(env.DB);
      return reply(200, await fn(env.DB, args || {}));
    } catch (e) {
      if (e instanceof AppError) return reply(400, {message: e.message});
      console.error(m[1], e && e.stack || e);
      return reply(500, {message: "server_error"});
    }
  }
};
