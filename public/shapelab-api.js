/* ShapeLab · camada de conta e dados (versão app)
   - Telas de entrar / criar conta (nome + data de nascimento, PIN só em caso de empate)
   - Liga o app ao servidor do próprio site (/api), no Cloudflare
   - Coach IA desligado nesta versão (sem custo de API) */
(() => {
  "use strict";
  const CFG = window.SHAPELAB_CONFIG || {};
  const API_BASE = String(CFG.api || "/api").replace(/\/+$/, "");
  const COACH = ""; // Coach IA desligado nesta versão: sem custo de API
  const K = {token: "sl_token", uid: "sl_uid", name: "sl_name", last: "sl_last_uid"};
  const APP_KEYS = ["fv_state", "fv_sessions", "fv_active", "fv_rest", "fv_photos"];

  const MEM = {}; // reserva quando o navegador bloqueia o armazenamento (janela anônima, prévia)
  const store = {
    get(k) { let v = null; try { v = localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch {} return v ?? (k in MEM ? MEM[k] : (window.SL_BOOT && window.SL_BOOT[k]) || null); },
    set(k, v, persist) { MEM[k] = v; try { (persist ? localStorage : sessionStorage).setItem(k, v); (persist ? sessionStorage : localStorage).removeItem(k); } catch {} },
    del(k) { delete MEM[k]; if (window.SL_BOOT) delete window.SL_BOOT[k]; try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} }
  };
  const token = () => store.get(K.token);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

  function clearAppData() { APP_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch {} }); }
  function authLost() { [K.token, K.uid, K.name].forEach(store.del); location.reload(); }

  async function rpc(fn, args) {
    let r;
    try {
      r = await fetch(`${API_BASE}/${fn}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(args || {})});
    } catch { const e = new Error("offline"); e.code = "unavailable"; throw e; }
    const txt = await r.text();
    let body = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
    if (!r.ok) {
      const msg = String((body && (body.message || body.hint || body.error)) || txt || r.status);
      const e = new Error(msg);
      e.code = /not_authenticated/.test(msg) ? "not_authenticated" : r.status >= 500 ? "unavailable" : "invalid_argument";
      if (e.code === "not_authenticated" && fn !== "logout") authLost();
      throw e;
    }
    return body;
  }

  /* ---------- substitutos das capacidades usadas pelo app ---------- */
  const coll = (listFn, saveFn, delFn) => ({
    orderBy() { return this; },
    limit(n) { return {get: async () => { const arr = await rpc(listFn, {p_token: token(), p_limit: n}); return {docs: (arr || []).map(d => ({id: d.id, exists: true, data: () => d}))}; }}; },
    doc(id) { return {set: d => rpc(saveFn, {p_token: token(), p_id: id, p_data: d}), delete: () => rpc(delFn, {p_token: token(), p_id: id})}; }
  });
  const stateRef = {
    async get() {
      const r = await rpc("get_state", {p_token: token()});
      if (!r || !r.exists) return {exists: false, data: () => undefined};
      const st = r.state || {};
      st.profile = st.profile || {};
      if (!st.profile.name) st.profile.name = store.get(K.name) || "";
      return {exists: true, data: () => st};
    },
    set: st => rpc("save_state", {p_token: token(), p_state: st}),
    collection(n) { return n === "sessions" ? coll("list_sessions", "save_session", "delete_session") : coll("list_photos", "save_photo", "delete_photo"); }
  };
  const db = {
    doc() { return stateRef; },
    collection() { return {onSnapshot(next) { setTimeout(() => next({docs: []}), 0); return () => {}; }}; }
  };
  const user = {id: async () => store.get(K.uid), canEdit: async () => false, isOwner: async () => false};

  function parseJSON(t) {
    try { return JSON.parse(t); } catch {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
    const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
    throw {code: "invalid_json", message: "invalid json", text: t};
  }
  async function askCoach(input, json, opts) {
    if (!COACH) throw {code: "sampling_disabled", message: "coach not configured"};
    let messages, system;
    if (typeof input === "string") messages = [{role: "user", content: input}];
    else if (Array.isArray(input)) messages = input;
    else { messages = input.messages || [{role: "user", content: String(input.prompt || "")}]; system = input.system; }
    let r;
    try {
      r = await fetch(COACH, {method: "POST", signal: opts && opts.signal,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({token: token(), messages, system, json: !!json, tier: (opts && opts.modelTier) || "default"})});
    } catch (e) { throw {code: e && e.name === "AbortError" ? "cancelled" : "upstream_error", message: String(e)}; }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const c = body.error === "not_authenticated" ? "session_expired" : body.error === "rate_limited" ? "rate_limited" : body.error === "not_configured" ? "sampling_disabled" : "upstream_error";
      throw {code: c, message: body.error || String(r.status)};
    }
    return String(body.text || "");
  }
  const sample = async (input, opts = {}) => {
    const text = await askCoach(input, false, opts);
    if (!text.trim()) throw {code: "empty_completion", message: "empty"};
    if (opts.onText) try { opts.onText({text, delta: text}); } catch {}
    return {text, truncated: false, modelTierApplied: opts.modelTier || "default"};
  };
  sample.json = async (input, opts = {}) => parseJSON(await askCoach(input, true, opts));
  sample.limits = async () => ({maxPromptBytes: 200000});

  const downloads = {
    async save({filename, data}) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return {status: "saved"};
    }
  };

  const CAPS = {user: () => user, db: () => db, sample: () => (COACH ? sample : null), downloads: () => downloads, assets: () => null};
  window.SLCAP = {use: async name => (CAPS[name] ? CAPS[name]() : null)};
  window.SL = {
    name: () => store.get(K.name),
    async logout() { try { await rpc("logout", {p_token: token()}); } catch {} [K.token, K.uid, K.name].forEach(store.del); clearAppData(); location.reload(); }
  };

  /* ---------- início do app ---------- */
  function startApp() {
    const uid = store.get(K.uid);
    let last = null; try { last = localStorage.getItem(K.last); } catch {}
    if (last !== uid) { clearAppData(); try { localStorage.setItem(K.last, uid); } catch {} }
    const box = document.getElementById("slAuth"); if (box) box.remove();
    if (typeof window.SL_MAIN === "function") { const run = window.SL_MAIN; window.SL_MAIN = null; run(); }
  }

/* Bolhas do frasco: sobem no líquido, uma escapa pela boca e estoura em respingos. */
  function slBubbles(host) {
    if (!host || host.dataset.fx) return;
    try { if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch {}
    host.dataset.fx = "1"; host.classList.add("fx-host");
    const layer = document.createElement("div"); layer.className = "fx-layer"; layer.setAttribute("aria-hidden", "true"); host.appendChild(layer);
    const svg = host.querySelector("svg");
    const box = () => { const h = host.getBoundingClientRect(), s = (svg || host).getBoundingClientRect(); return {x: s.left - h.left, y: s.top - h.top, w: s.width, h: s.height}; };
    const rnd = (a, b) => a + Math.random() * (b - a);
    const col = () => Math.random() < .5 ? "rgba(120,215,255,.95)" : "rgba(255,140,200,.95)";
    function inner() {
      const b = box(), d = document.createElement("i"), sz = rnd(.035, .07) * b.w;
      d.className = "fx-in"; d.style.cssText = `left:${b.x + b.w * rnd(.36, .64) - sz / 2}px;top:${b.y + b.h * rnd(.78, .84)}px;width:${sz}px;height:${sz}px;--dy:${-b.h * rnd(.18, .24)}px`;
      layer.appendChild(d); setTimeout(() => d.remove(), 1500);
    }
    function escape() {
      const b = box(), d = document.createElement("i"), sz = rnd(.07, .1) * b.w, c = col();
      const x = b.x + b.w * rnd(.46, .54) - sz / 2, y0 = b.y + b.h * .12, rise = b.h * rnd(.32, .5), dx = rnd(-.12, .12) * b.w;
      d.className = "fx-up"; d.style.cssText = `left:${x}px;top:${y0}px;width:${sz}px;height:${sz}px;--dy:${-rise}px;--dx:${dx}px;--c:${c}`;
      layer.appendChild(d);
      setTimeout(() => {
        d.remove();
        const cx = x + sz / 2 + dx, cy = y0 - rise + sz / 2, n = 8;
        for (let k = 0; k < n; k++) {
          const s = document.createElement("i"), a = (k / n) * 360 + rnd(-12, 12);
          s.className = "fx-pop"; s.style.cssText = `left:${cx}px;top:${cy}px;--a:${a}deg;--r:${rnd(.1, .16) * b.w}px;--c:${c}`;
          layer.appendChild(s); setTimeout(() => s.remove(), 520);
        }
      }, 1150);
    }
    let t1, t2;
    const loopIn = () => { if (!host.isConnected) return; if (!document.hidden) inner(); t1 = setTimeout(loopIn, rnd(260, 520)); };
    const loopUp = () => { if (!host.isConnected) return; if (!document.hidden) escape(); t2 = setTimeout(loopUp, rnd(1300, 2300)); };
    loopIn(); setTimeout(loopUp, 500);
  }
  
  /* ---------- telas de entrada ---------- */
  let mode = "login", needPin = false, busy = false;
  const logo = `<svg viewBox="0 0 100 100" width="76" height="76" aria-hidden="true"><g clip-path="url(#slClip)"><path d="M0 57 Q12 51 25 57 T50 57 T75 57 T100 57 V100 H0 Z" fill="url(#slLiquid)"/><g fill="#fff"><rect x="40.2" y="71.8" width="19.6" height="2.4" rx="1.2"/><rect x="36.6" y="68" width="3.9" height="10" rx="1.5"/><rect x="59.5" y="68" width="3.9" height="10" rx="1.5"/></g></g><path d="M43 12 V39 L19 82 Q16.5 88 23.5 88 H76.5 Q83.5 88 81 82 L57 39 V12" fill="none" stroke="url(#slGlass)" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/><path d="M37 11 H63" stroke="url(#slGlass)" stroke-width="4" stroke-linecap="round"/></svg>`;
  function renderAuth(msg, kind) {
    const box = document.getElementById("slAuth");
    const v = id => (document.getElementById(id) || {}).value || "";
    const keep = {n: v("aName"), b: v("aBirth"), p: v("aPin")};
    const remember = document.getElementById("aKeep") ? document.getElementById("aKeep").checked : true;
    const notCfg = !API_BASE;
    box.innerHTML = `<div class="pnl hero sl-auth-card">
      <div class="brand-hero"><span class="fx-host" id="authFlask">${logo}</span><p class="hero-t" style="font-size:clamp(40px,12vw,64px)"><span class="t1">shape</span><span class="t2">lab</span></p></div>
      <p class="lede">${mode === "login" ? "Entre com seu nome e data de nascimento." : "Crie sua conta em 10 segundos."}</p>
      ${notCfg ? `<p class="err">Configuração pendente: servidor não encontrado.</p>` : ""}
      <form id="aForm" class="stack" novalidate>
        <label class="fld"><span>Nome ou como quer ser chamado</span><input id="aName" autocomplete="given-name" maxlength="40" required value="${esc(keep.n)}" placeholder="Ex.: Lucas"></label>
        <label class="fld"><span>Data de nascimento</span><input id="aBirth" type="date" required value="${esc(keep.b)}" max="${new Date().toISOString().slice(0, 10)}"></label>
        ${mode === "signup" ? `<label class="fld"><span>Crie um PIN de 4 números</span><input id="aPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="new-password" value="${esc(keep.p)}" placeholder="••••"></label>
          <p class="meta">Guarde esse PIN. Ele só será pedido se outra pessoa tiver o mesmo nome e data de nascimento que você.</p>` : ""}
        ${mode === "login" && needPin ? `<div class="pnl prof"><p class="lede">Encontramos mais de uma conta com esses dados. Para proteger seu treino, digite seu PIN cadastrado.</p>
          <label class="fld"><span>PIN</span><input id="aPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="current-password" value="${esc(keep.p)}" placeholder="••••"></label></div>` : ""}
        <label class="sl-keep"><input type="checkbox" id="aKeep" ${remember ? "checked" : ""}> Manter conectado neste aparelho</label>
        ${msg ? `<p class="${kind || "err"}" role="alert">${esc(msg)}</p>` : ""}
        <button class="b b-pri w" type="submit" ${busy || notCfg ? "disabled" : ""}>${busy ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}</button>
      </form>
      <button class="lnk" id="aSwitch" type="button" style="align-self:center">${mode === "login" ? "Primeira vez? Criar conta" : "Já tenho conta · Entrar"}</button>
    </div>`;
    slBubbles(document.getElementById("authFlask"));
    document.getElementById("aSwitch").onclick = () => { mode = mode === "login" ? "signup" : "login"; needPin = false; renderAuth(); };
    document.getElementById("aForm").onsubmit = ev => { ev.preventDefault(); submit(); };
    const f = needPin ? document.getElementById("aPin") : null; if (f) f.focus();
  }
  async function submit() {
    if (busy) return;
    const name = document.getElementById("aName").value.trim();
    const birth = document.getElementById("aBirth").value;
    const pinEl = document.getElementById("aPin"), pin = pinEl ? pinEl.value.trim() : "";
    const remember = document.getElementById("aKeep").checked;
    if (name.length < 2) return renderAuth("Digite seu nome.");
    if (!birth) return renderAuth("Informe sua data de nascimento.");
    if ((mode === "signup" || needPin) && !/^\d{4}$/.test(pin)) return renderAuth("O PIN tem 4 números.");
    busy = true; renderAuth();
    let r;
    try {
      r = mode === "signup" ? await rpc("signup", {p_name: name, p_birth: birth, p_pin: pin, p_remember: remember})
                            : await rpc("login", {p_name: name, p_birth: birth, p_pin: needPin ? pin : null, p_remember: remember});
    } catch { busy = false; return renderAuth("Sem conexão com o servidor. Tente de novo."); }
    busy = false;
    const st = r && r.status;
    if (st === "ok") {
      store.set(K.token, r.token, remember); store.set(K.uid, r.user_id, remember); store.set(K.name, r.name, remember);
      return startApp();
    }
    const MSG = {
      not_found: "Não encontramos uma conta com esse nome e data. Confira os dados ou crie uma conta.",
      pin_required: "", invalid_pin: "PIN incorreto. Tente de novo.", locked: "Muitas tentativas com PIN errado. Espere 15 minutos.",
      pin_taken: "Já existe uma conta com esse nome, data e PIN. Escolha outro PIN.",
      invalid_name: "Digite seu nome.", invalid_birth: "Data de nascimento inválida.", invalid_pin_format: "O PIN tem 4 números."
    };
    if (st === "pin_required") { needPin = true; return renderAuth(); }
    renderAuth(MSG[st] || "Algo deu errado. Tente de novo.");
  }

  /* Puxar para atualizar (no app instalado o celular não faz isso sozinho) */
  function pullToRefresh() {
    const standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone;
    if (!standalone) return;
    const el = document.createElement("div"); el.id = "slPull"; el.innerHTML = "<i></i><span>Puxe para atualizar</span>"; document.body.appendChild(el);
    let y0 = null, d = 0, busy = false;
    const scrollTop = () => { const sh = document.querySelector(".shell"); return Math.max(window.scrollY, sh ? sh.scrollTop : 0); };
    const sheetOpen = () => { const sh = document.getElementById("sheet"); return (sh && !sh.hidden) || document.getElementById("slAuth"); };
    document.addEventListener("touchstart", e => { if (busy || scrollTop() > 0 || sheetOpen() || e.touches.length > 1) { y0 = null; return; } y0 = e.touches[0].clientY; d = 0; }, {passive: true});
    document.addEventListener("touchmove", e => {
      if (y0 == null || busy) return;
      d = Math.max(0, e.touches[0].clientY - y0);
      if (scrollTop() > 0) { y0 = null; d = 0; }
      const k = Math.min(1, d / 90);
      el.style.opacity = d > 10 ? String(k) : "0"; el.style.transform = `translate(-50%, ${-80 + 80 * k}px)`;
      el.querySelector("span").textContent = d >= 90 ? "Solte para atualizar" : "Puxe para atualizar";
      el.querySelector("i").style.transform = `rotate(${d * 3}deg)`;
    }, {passive: true});
    document.addEventListener("touchend", () => {
      if (y0 == null || busy) return;
      if (d >= 90) { busy = true; el.classList.add("go"); el.querySelector("span").textContent = "Atualizando…"; setTimeout(() => location.reload(), 250); }
      else { el.style.opacity = "0"; el.style.transform = "translate(-50%,-80px)"; }
      y0 = null; d = 0;
    }, {passive: true});
  }

  function boot() {
    pullToRefresh();
    slBubbles(document.getElementById("bootFlaskA"));
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
    if (token() && store.get(K.uid)) return startApp();
    renderAuth();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
