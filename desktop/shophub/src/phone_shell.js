/* JZD Shop Manager — the phone shell.

   The Shop Hub serves this in front of the app when a phone opens it over the
   shop's Wi-Fi. It stands in for the desktop shell: it defines
   window.__TAURI__ so the app runs exactly as it does on a computer, and it
   answers the app's requests by asking this phone's seat on the hub (see
   phone.rs) over one sealed connection.

   Pairing and the connection use the same protocol as a computer, with the
   same primitives, from the audited MIT-licensed "noble" libraries (served as
   /noble.js): P-256 ECDH, HMAC-SHA-256 and ChaCha20-Poly1305. Safari switches
   off its own browser crypto on a plain-HTTP address, which is what a shop's
   Wi-Fi has, so the phone brings its own.

   When the phone loses the Wi-Fi it keeps working: the book the person last
   saved and the photographs they took are kept on the phone (IndexedDB) and
   handed to the seat when it is back. The seat only ever moves its idea of
   what this phone has seen when the phone confirms it, so what goes up is
   only what was changed here. */
(() => {
  "use strict";
  const C = window.JZDCrypto;
  const KEY = "jzd.phone.link";
  const enc = new TextEncoder(), dec = new TextDecoder();

  /* ---------- small helpers ---------- */
  const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => { const bin = atob(s || ""); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const bytes = x => typeof x === "string" ? enc.encode(x) : x;
  /* the same framing as crypto::hmac on the hub: each part is length-prefixed */
  function hmac(key, parts){
    const h = C.hmac.create(C.sha256, key);
    for (const p0 of parts){
      const p = bytes(p0);
      const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, p.length);
      h.update(len); h.update(p);
    }
    return h.digest();
  }
  const eq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
  const hex = u8 => Array.from(u8, x => x.toString(16).padStart(2, "0")).join("");
  const now = () => Date.now();

  function loadLink(){ try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e){ return null; } }
  function saveLink(l){ localStorage.setItem(KEY, JSON.stringify(l)); }

  /* ---------- what this phone keeps while the Wi-Fi is away ---------- */
  const store = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("jzd-phone", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("photos"); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (name, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(name, mode); const out = fn(t.objectStore(name)); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
    return {
      get: k => tx("kv", "readonly", s => s.get(k)),
      put: (k, v) => tx("kv", "readwrite", s => s.put(v, k)),
      del: k => tx("kv", "readwrite", s => s.delete(k)),
      photoPut: (id, v) => tx("photos", "readwrite", s => s.put(v, id)),
      photoGet: id => tx("photos", "readonly", s => s.get(id)),
      photoDel: id => tx("photos", "readwrite", s => s.delete(id)),
      photoKeys: () => tx("photos", "readonly", s => s.getAllKeys())
    };
  })();

  /* ---------- the sealed connection ---------- */
  function sessionKeys(secret, nc, ns){
    return { send: hmac(secret, ["jzd-shophub c2s", nc, ns]), recv: hmac(secret, ["jzd-shophub s2c", nc, ns]) };
  }
  function nonce12(ctr){ const n = new Uint8Array(12); const v = new DataView(n.buffer); v.setUint32(4, Math.floor(ctr / 4294967296)); v.setUint32(8, ctr >>> 0); return n; }
  function seal(sess, obj){
    sess.sendCtr += 1;
    const ct = C.chacha20poly1305(sess.keys.send, nonce12(sess.sendCtr)).encrypt(enc.encode(JSON.stringify(obj)));
    const out = new Uint8Array(8 + ct.length);
    const v = new DataView(out.buffer); v.setUint32(0, Math.floor(sess.sendCtr / 4294967296)); v.setUint32(4, sess.sendCtr >>> 0);
    out.set(ct, 8);
    return out;
  }
  function unseal(sess, frame){
    const u = new Uint8Array(frame);
    if (u.length < 24) throw new Error("short message");
    const v = new DataView(u.buffer, u.byteOffset, 8);
    const ctr = v.getUint32(0) * 4294967296 + v.getUint32(4);
    if (ctr !== sess.recvCtr + 1) throw new Error("message out of order or replayed");
    const plain = C.chacha20poly1305(sess.keys.recv, nonce12(ctr)).decrypt(u.subarray(8));
    sess.recvCtr = ctr;
    return JSON.parse(dec.decode(plain));
  }
  const wsUrl = () => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/shophub";

  /* ---------- state ---------- */
  let link = loadLink();
  let ws = null, sess = null, online = false, connecting = false, lastErr = "", lastHeard = 0, backoff = 500;
  let rpcSeq = 0;
  const waiting = new Map();          /* rpc id -> {resolve, reject} */
  const listeners = [];               /* event.listen callbacks */
  let readyResolve; let ready = new Promise(r => readyResolve = r);
  let flushing = null;
  let queuedSaves = 0;

  function emit(kind, data){ for (const cb of listeners) try { cb({payload:{kind, data}}); } catch (e){} }
  function statusOffline(){ return {online:false, pending:queuedSaves, conflicts:[], devices:[], deviceName:link ? link.name : "", deviceId:link ? link.device : "", shopName:link ? link.shopName : "", lastError:lastErr, address:location.host, photosWaiting:0, phone:true}; }

  function connect(){
    if (connecting || online || !link || debugOffline) return;
    connecting = true;
    let sock;
    try { sock = new WebSocket(wsUrl()); } catch (e){ connecting = false; lastErr = String(e); return retry(); }
    sock.binaryType = "arraybuffer";
    const secret = unb64(link.secret);
    const nc = C.randomBytes(24);
    let stage = "hello";
    sock.onopen = () => {
      sock.send(JSON.stringify({t:"hello", device:link.device, nonce:b64(nc), mac:b64(hmac(secret, ["hello", link.device, nc])), cipher:"chacha20-poly1305", screen:true}));
    };
    sock.onmessage = ev => {
      lastHeard = now();
      if (stage === "hello"){
        const m = JSON.parse(ev.data);
        if (m.t === "denied"){ lastErr = m.why || "The Shop Hub refused this phone."; if (/revoked|not paired/i.test(lastErr)){ localStorage.removeItem(KEY); link = null; showPairing(lastErr); } sock.close(); return; }
        if (m.t !== "welcome"){ sock.close(); return; }
        const ns = unb64(m.nonce);
        if (!eq(unb64(m.mac), hmac(secret, ["welcome", nc, ns, m.shop]))){ lastErr = "The Shop Hub could not prove it is the shop this phone was paired with."; sock.close(); return; }
        sess = {keys:sessionKeys(secret, nc, ns), sendCtr:0, recvCtr:0};
        ws = sock; stage = "open"; online = true; connecting = false; backoff = 500; lastErr = "";
        flushing = flushQueue().finally(() => { flushing = null; readyResolve(); emit("status", null); });
        return;
      }
      let m;
      try { m = unseal(sess, ev.data); } catch (e){ lastErr = "a message from the Shop Hub failed its check"; sock.close(); return; }
      if (m.t === "rpcr"){ const w = waiting.get(m.id); if (w){ waiting.delete(m.id); "err" in m ? w.reject(m.err) : w.resolve(m.ok); } }
      else if (m.t === "ev") emit(m.kind, m.data);
      else if (m.t === "denied"){ lastErr = m.why; localStorage.removeItem(KEY); link = null; showPairing(m.why); sock.close(); }
    };
    sock.onclose = () => {
      const was = online;
      online = false; connecting = false; ws = null; sess = null;
      for (const [, w] of waiting) w.reject("SHOP HUB OFFLINE — the phone lost its connection");
      waiting.clear();
      ready = new Promise(r => readyResolve = r);
      if (was){ lastErr = lastErr || "SHOP HUB OFFLINE"; emit("status", statusOffline()); }
      retry();
    };
    sock.onerror = () => { lastErr = lastErr || "SHOP HUB OFFLINE — cannot reach the Shop Hub on this Wi-Fi"; };
  }
  function retry(){
    if (!link) return;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  }
  setInterval(() => {
    if (online && ws){
      try { ws.send(seal(sess, {t:"ping"})); } catch (e){}
      if (now() - lastHeard > 15000){ try { ws.close(); } catch (e){} }
    }
  }, 4000);

  function call(cmd, args){
    return new Promise((resolve, reject) => {
      if (!online || !ws) return reject("SHOP HUB OFFLINE — the phone is not connected");
      const id = ++rpcSeq;
      waiting.set(id, {resolve, reject});
      try { ws.send(seal(sess, {t:"rpc", id, cmd, args:args || {}})); }
      catch (e){ waiting.delete(id); reject(String(e)); }
    });
  }

  /* what was done while away goes up first, before anything else is asked */
  async function flushQueue(){
    const book = await store.get("pendingBook");
    if (book){
      try { await call("db_save", {text:book}); await store.del("pendingBook"); queuedSaves = 0; }
      catch (e){ lastErr = String(e); }
    }
    for (const id of await store.photoKeys()){
      const p = await store.photoGet(id);
      if (!p) continue;
      try { await call("att_save", {id, ext:p.ext, dataB64:p.b64}); await store.photoDel(id); }
      catch (e){ lastErr = String(e); break; }
    }
  }

  /* ---------- photographs: sent small enough to be quick ---------- */
  async function shrink(ext, dataB64){
    if (!/^(jpg|jpeg|png|webp)$/.test(ext)) return {ext, dataB64};
    const raw = unb64(dataB64);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(new Blob([raw])); }).catch(() => null);
    if (!img) return {ext, dataB64};
    const MAX = 2560;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && raw.length < 1.5e6) return {ext, dataB64};
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL("image/jpeg", 0.85).split(",")[1];
    return {ext:"jpg", dataB64:out};
  }

  /* ---------- the commands the app asks for ---------- */
  async function invoke(cmd, args){
    args = args || {};
    if (!link){ await paired; }
    if (cmd === "db_load"){
      await waitOnline(20000);
      if (!online){
        const cached = await store.get("lastBook");
        if (cached) return {text:cached, existed:true, error:null, path:"This phone (Shop Hub offline)", sync:"client"};
      }
      const r = await call("db_load");
      if (r.text) store.put("lastBook", r.text).catch(() => {});
      return r;
    }
    if (cmd === "db_save"){
      if (flushing) await flushing;
      if (!online){
        await store.put("pendingBook", args.text); await store.put("lastBook", args.text);
        queuedSaves += 1;
        emit("status", statusOffline());
        return {bytes:args.text.length, path:"This phone — waiting for the Shop Hub", backup:null, sync:{queued:0, pending:queuedSaves}};
      }
      const r = await call("db_save", args);
      store.put("lastBook", args.text).catch(() => {});
      return r;
    }
    if (cmd === "sync_status"){
      if (!online) return {mode:"client", phone:true, client:statusOffline(), numbers:{}};
      return call("sync_status");
    }
    if (cmd === "att_save"){
      const small = await shrink(String(args.ext || "jpg").toLowerCase(), args.dataB64);
      if (!online){
        const id = "att-" + now() + "-" + hex(C.randomBytes(3));
        const raw = unb64(small.dataB64);
        await store.photoPut(id, {ext:small.ext, b64:small.dataB64});
        emit("photo", {id, state:"pending"});
        return {id, file:id + "." + small.ext, bytes:raw.length, sha256:hex(C.sha256(raw))};
      }
      return call("att_save", small);
    }
    if (cmd === "att_read" || cmd === "att_exists"){
      const local = await store.photoGet(args.id).catch(() => null);
      if (local) return cmd === "att_exists" ? true : local.b64;
      if (!online){
        if (cmd === "att_exists") return false;
        throw "SHOP HUB OFFLINE — this photo is not on this phone yet";
      }
      return call(cmd, args);
    }
    if (cmd === "att_delete") return null;
    if (/^sync_/.test(cmd)){
      if (!online) throw "SHOP HUB OFFLINE";
      if (flushing) await flushing;
      return call(cmd, args);
    }
    if (cmd === "secret_has") return false;
    /* public NHTSA data (recalls, decode), fetched by the phone itself; nothing
       licensed and no credential goes through a phone */
    if (cmd === "net_fetch"){
      const req = args.req || {};
      if ((req.method || "GET") !== "GET" || !/^https:\/\/(vpic\.nhtsa\.dot\.gov|api\.nhtsa\.gov|static\.nhtsa\.gov)\//.test(req.url || "")) throw "only public NHTSA data is fetched on a phone";
      const r = await fetch(req.url, {headers:{Accept:"application/json"}});
      return {status:r.status, body:await r.text()};
    }
    throw cmd + " is not available on a phone";
  }
  function waitOnline(ms){
    if (online) return Promise.resolve();
    return Promise.race([ready, new Promise(r => setTimeout(r, ms))]);
  }

  window.__TAURI__ = {
    core: {invoke},
    event: {listen: async (name, cb) => { if (name === "shopsync") listeners.push(cb); return () => {}; }}
  };
  window.JZD_PHONE = true;
  /* for the automated two-device test only: behave as if the Wi-Fi dropped */
  let debugOffline = false;
  window.JZD_PHONE_DEBUG = {offline(on){ debugOffline = !!on; if (on && ws) try { ws.close(); } catch (e){} if (!on) connect(); }};

  /* ---------- pairing, on this phone's own screen ---------- */
  let pairedResolve; const paired = new Promise(r => pairedResolve = r);
  if (link) pairedResolve();

  function showPairing(why){
    const draw = () => {
      let el = document.getElementById("phonePair");
      if (!el){ el = document.createElement("div"); el.id = "phonePair"; document.body.appendChild(el); }
      el.style.cssText = "position:fixed;inset:0;z-index:9999;background:#f4f6f8;overflow:auto;font:16px -apple-system,Segoe UI,sans-serif;color:#1f2937";
      el.innerHTML = `<div style="max-width:420px;margin:0 auto;padding:28px 20px">
        <h2 style="margin:0 0 8px">Connect this phone to the shop</h2>
        <p style="margin:0 0 16px;color:#4b5563">On the office computer open <b>Settings → Shop Sync</b> and press <b>PAIR DEVICE</b>. Type the code it shows.</p>
        ${why ? `<p style="background:#fef2f2;border:1px solid #fca5a5;padding:10px;border-radius:8px;margin:0 0 14px">${String(why).replace(/[&<>]/g, "")}</p>` : ""}
        <label style="display:block;font-weight:600;margin-bottom:4px">Pairing code</label>
        <input id="pp_code" inputmode="numeric" autocomplete="one-time-code" placeholder="482 193" style="width:100%;font-size:28px;letter-spacing:4px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box">
        <label style="display:block;font-weight:600;margin:14px 0 4px">This phone's name</label>
        <input id="pp_name" value="Shop iPhone" style="width:100%;font-size:18px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box">
        <button id="pp_go" style="margin-top:18px;width:100%;font-size:18px;padding:14px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:700">CONNECT</button>
        <div id="pp_state" style="margin-top:16px"></div></div>`;
      document.getElementById("pp_go").onclick = () => pair(document.getElementById("pp_code").value, document.getElementById("pp_name").value);
    };
    if (document.body) draw(); else document.addEventListener("DOMContentLoaded", draw);
  }
  function pairState(html){ const s = document.getElementById("pp_state"); if (s) s.innerHTML = html; }

  function pair(code, name){
    code = String(code || "").replace(/\s+/g, "");
    name = String(name || "").trim() || "Shop iPhone";
    if (!/^\d{6}$/.test(code)){ pairState("Type the six digits showing on the office computer."); return; }
    pairState("Connecting…");
    const priv = C.p256.utils.randomPrivateKey();
    const pub = C.p256.getPublicKey(priv, false);
    const sock = new WebSocket(wsUrl());
    let secret = null, shop = "", shopName = "";
    sock.onopen = () => sock.send(JSON.stringify({t:"pair1", code, pk:b64(pub), name, kind:"phone"}));
    sock.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.t === "pair-refused"){ pairState(`<b>Not connected:</b> ${String(m.why || "").replace(/[&<>]/g, "")}`); return; }
      if (m.t === "pair2"){
        const hostPub = unb64(m.pk);
        const raw = C.p256.getSharedSecret(priv, hostPub, true).slice(1);   /* the shared x coordinate */
        const v = hmac(raw, ["jzd-shophub verify", pub, hostPub]);
        const n = new DataView(v.buffer, v.byteOffset, 4).getUint32(0) % 1000000;
        const digits = String(Math.floor(n / 1000)).padStart(3, "0") + " " + String(n % 1000).padStart(3, "0");
        secret = hmac(raw, ["jzd-shophub device secret", pub, hostPub]);
        shop = m.shop; shopName = m.shopName || "";
        pairState(`<div style="background:#eff6ff;border:1px solid #93c5fd;padding:14px;border-radius:10px">Check the office computer shows
          <div id="pp_verify" style="font-size:34px;font-weight:800;letter-spacing:4px;margin:8px 0">${digits}</div>
          then press <b>Approve</b> there. If the numbers are different, press Deny.</div>`);
        return;
      }
      if (m.t === "pair-ok"){
        if (!secret || !eq(unb64(m.mac), hmac(secret, ["paired", m.device, shop]))){ pairState("<b>The approval could not be verified; nothing was saved.</b>"); return; }
        link = {device:m.device, secret:b64(secret), shop, shopName, name};
        saveLink(link);
        const el = document.getElementById("phonePair"); if (el) el.remove();
        pairedResolve();
        connect();
      }
    };
    sock.onerror = () => pairState("<b>Not connected:</b> cannot reach the Shop Hub on this Wi-Fi.");
  }

  if (link) connect(); else showPairing("");
})();
