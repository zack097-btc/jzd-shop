/* The phone on a mobile job (2.9.2): no signal, and everything waiting at the
   shop when it is back.

   The office desktop hosts the Shop Hub (desktop/shophub, bin shophub-sim)
   with HTTPS for phones on its own port. Checked for real:
     - the hub's certificate is trusted by a client that trusts only the shop's
       own authority, for the hub's address, and by nothing else;
     - the phone on the plain address is walked to the secure one;
     - on the secure address the phone keeps the app (a service worker), so
       with the network gone it still opens, with the shop's book;
     - an inspection change, a note and a photo made with no network wait on
       the phone and reach the office desktop by themselves when it is back.

   The phone is Chromium emulating an iPhone 13. Chromium cannot be given the
   shop's authority without changing this computer's trust store, so it runs
   with certificate errors ignored; the trust itself is checked with Node's
   TLS client, which is given only the shop's certificate.

   SHOPHUB_SIM=<path to shophub-sim(.exe)> overrides where the harness is. */
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const PAGE = path.join(process.cwd(), 'index.html');
const SIM = process.env.SHOPHUB_SIM || 'C:/Users/zack0/AppData/Local/Temp/shophubt/debug/shophub-sim.exe';
const HUB = 47961, HTTPS = 47964, HOST_CTL = 47971;
const failures = [];
function check(name, cond, detail){
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 600)));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const press = (page, sel) => page.$eval(sel, el => el.click());
const F = f => '[data-f="' + f.replace(/"/g, '\\"') + '"]';
async function until(fn, ms, step){
  const t0 = Date.now();
  for (;;){ let v; try { v = await fn(); } catch (e){ v = null; } if (v) return v; if (Date.now() - t0 > ms) return null; await wait(step || 25); }
}
const procs = [];
function startSim(dir, ctl, extra){
  return new Promise((resolve, reject) => {
    const p = spawn(SIM, ['--dir', dir, '--ctl', String(ctl)].concat(extra || []), { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p); let out = '';
    const to = setTimeout(() => reject(new Error('did not start: ' + out)), 15000);
    p.stdout.on('data', d => { out += d; if (/READY/.test(out)){ clearTimeout(to); resolve(p); } });
    p.stderr.on('data', d => { out += d; });
  });
}
async function ctl(port, cmd, args){
  const r = await fetch('http://127.0.0.1:' + port + '/invoke', { method: 'POST', body: JSON.stringify({ cmd, args: args || {} }) });
  const j = await r.json(); if ('err' in j) throw new Error(j.err); return j.ok;
}
function shim(port){
  return `(() => {
    const base = 'http://127.0.0.1:${port}';
    window.__TAURI__ = {
      core: { invoke: async (cmd, args) => {
        const r = await fetch(base + '/invoke', { method: 'POST', body: JSON.stringify({ cmd, args: args || {} }) });
        const j = await r.json(); if ('err' in j) throw j.err; return j.ok; } },
      event: { listen: async (name, cb) => {
        let after = 0;
        try { after = (await (await fetch(base + '/events-len')).json()).n; } catch (e) {}
        (async () => { for (;;){ try { const list = await (await fetch(base + '/events?after=' + after)).json();
          for (const e of list){ after = e.n + 1; if (name === 'shopsync') cb({ payload: { kind: e.kind, data: e.data } }); } }
          catch (e){ await new Promise(r => setTimeout(r, 300)); } } })();
        return () => {}; } }
    };
  })();`;
}
/* a GET over TLS that trusts only `ca` (PEM), or nothing extra when ca is null */
function tlsGet(pathname, ca){
  return new Promise(resolve => {
    const req = https.get({ host: '127.0.0.1', port: HTTPS, path: pathname, ca: ca || undefined, timeout: 5000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), type: res.headers['content-type'] }));
    });
    req.on('error', e => resolve({ error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

(async () => {
  if (!fs.existsSync(SIM)){ console.log('FAIL: the Shop Hub harness is not built: ' + SIM); process.exit(1); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jzdoffline-'));
  const hostDir = path.join(root, 'desk'); fs.mkdirSync(hostDir);
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  let started = false;
  try {
    await startSim(hostDir, HOST_CTL, ['--hub-port', String(HUB), '--https-port', String(HTTPS), '--page', PAGE]);
    started = true;
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addInitScript(shim(HOST_CTL));
    const desk = await ctx.newPage(); desk.errs = []; desk.on('pageerror', e => desk.errs.push(e.message)); desk.on('dialog', d => d.accept());
    await desk.goto(APP); await until(() => desk.evaluate(() => typeof db === 'object' && !!syncStatus), 8000);
    await desk.evaluate(() => {
      db.settings.shopName = 'JZAC Designs';
      saveCustomer({ id: 'c1', first: 'Dana', last: 'Reyes', phone: '5095550100' });
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2019', make: 'Honda', model: 'Accord', vin: '1HGCV1F30KA000001', mileage: '64000' };
      db.orders.o1 = shapeOrder({ id: 'o1', customerId: 'c1', vehicleId: 'v1', date: '2026-09-25', status: 'In Progress', estimateNo: 1, labor: [], parts: [], extras: [], payments: [], history: [] });
      newInspection('o1', 'v1'); save();
    });
    await until(() => desk.evaluate(() => !dirty && !saving), 5000); await wait(300);
    await ctl(HOST_CTL, 'sync_host_enable', { shopName: 'JZAC Designs', deviceName: 'Office Desktop', port: HUB });
    await desk.reload(); await until(() => desk.evaluate(() => syncMode === 'host'), 10000);

    /* ================= 1. the certificate ================= */
    const st = await ctl(HOST_CTL, 'sync_status');
    const h = st.hub.https || {};
    check('1a. the hub serves HTTPS for phones on its own port', h.port === HTTPS && /^[0-9A-F]{64}$/.test(h.caSha256 || ''), JSON.stringify(h));
    const caDer = Buffer.from(await (await fetch('http://127.0.0.1:' + HUB + '/ca.cer')).arrayBuffer());
    const caCert = new crypto.X509Certificate(caDer);
    const caPem = caCert.toString();
    check('1b. the shop\'s certificate authority is handed out as a certificate a phone installs, and is the one the desktop shows',
      caCert.ca && /JZD Shop Hub - JZAC Designs/.test(caCert.subject) && caCert.fingerprint256.replace(/:/g, '') === h.caSha256, caCert.subject + ' ' + caCert.fingerprint256);
    check('1c. its key is not in it (a certificate only)', !/PRIVATE KEY/.test(caDer.toString('latin1')) && caDer.length < 2000, caDer.length);
    const trusted = await tlsGet('/health', caPem);
    const health = trusted.body ? JSON.parse(trusted.body.toString()) : {};
    check('1d. a client that trusts only the shop\'s authority connects to the hub\'s address and it checks out', trusted.status === 200 && health.secure === true && health.https === HTTPS, JSON.stringify(trusted.error || health));
    const untrusted = await tlsGet('/health', null);
    check('1e. and a client that does not have it is refused — nothing is trusted by accident', !!untrusted.error && /SELF_SIGNED|UNABLE_TO|CERT/.test(untrusted.error), JSON.stringify(untrusted));
    const leaf = await new Promise(resolve => { const s = require('tls').connect({ host: '127.0.0.1', port: HTTPS, ca: caPem }, () => { resolve(s.getPeerX509Certificate()); s.end(); }); s.on('error', e => resolve(null)); });
    const days = leaf ? (new Date(leaf.validTo) - Date.now()) / 864e5 : 0;
    check('1f. the hub\'s own certificate names its address, is for serving only, and lasts no more than an iPhone accepts (398 days)', !!leaf && /IP Address:127\.0\.0\.1/.test(leaf.subjectAltName) &&
      !leaf.ca && days > 390 && days <= 398, leaf && (leaf.subjectAltName + ' ' + leaf.validTo));
    const swPlain = await fetch('http://127.0.0.1:' + HUB + '/sw.js');
    const swTls = await tlsGet('/sw.js', caPem);
    check('1g. the service worker is only handed out over HTTPS, stamped with this version of the app', swPlain.status === 404 && swTls.status === 200 && /jzd-phone-/.test(swTls.body.toString()) && !/__JZD_APP__/.test(swTls.body.toString()), swPlain.status + ' ' + swTls.status);
    const card = await desk.evaluate(() => shopSyncOfflineCard(syncStatus));
    check('1h. the Shop Sync page explains the mobile set-up and shows the start of the certificate\'s fingerprint', /Mobile jobs/.test(card) && card.indexOf(h.caSha256.slice(0, 2) + ' ' + h.caSha256.slice(2, 4)) >= 0, card.slice(0, 300));

    /* ================= 2. the phone on the plain address is walked to the secure one ================= */
    const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
    const phone = await phoneCtx.newPage();
    phone.errs = []; phone.on('pageerror', e => phone.errs.push(e.message)); phone.on('dialog', d => d.accept());
    const pairPhone = async (name) => {
      await until(async () => (await phone.$('#phonePair')) && await phone.textContent('#phonePair'), 10000);
      const code = (await ctl(HOST_CTL, 'sync_pair_open')).code;
      await phone.fill('#pp_code', code); await phone.fill('#pp_name', name); await press(phone, '#pp_go');
      const req = await until(async () => (await ctl(HOST_CTL, 'sync_status')).hub.pairRequests[0], 8000);
      await ctl(HOST_CTL, 'sync_pair_decide', { id: req.id, approve: true });
      return until(() => phone.evaluate(() => typeof db === 'object' && db.customers && db.customers.c1 && Object.keys(db.inspections).length === 1), 15000, 100);
    };
    await phone.goto('http://127.0.0.1:' + HUB + '/');
    check('2a. paired on the plain address', !!(await pairPhone('Shop iPhone')));
    await phone.evaluate(() => go('phone'));
    const setup = await until(async () => { const el = await phone.$('#phoneOffline'); return el ? phone.evaluate(() => ({ text: document.getElementById('phoneOffline').textContent, cer: !!document.querySelector('#phoneOffline a[href="/ca.cer"]'), secure: document.getElementById('phoneSecureLink').href })) : null; }, 6000, 100);
    check('2b. the phone\'s home screen offers SET UP FOR MOBILE JOBS: the certificate, the two Settings steps, and the secure address',
      !!setup && setup.cer && setup.secure === 'https://127.0.0.1:' + HTTPS + '/' && /VPN & Device Management/.test(setup.text) && /Certificate Trust Settings/.test(setup.text), JSON.stringify(setup));

    /* ================= 3. the secure address: the phone keeps the app ================= */
    await phone.goto('https://127.0.0.1:' + HTTPS + '/');
    check('3a. on the secure address the phone pairs again (its own credential for this address) and opens the shop', !!(await pairPhone('Shop iPhone (mobile)')));
    const noSetup = await phone.evaluate(() => { go('phone'); return !document.getElementById('phoneOffline'); });
    check('3b. and the set-up card is gone', noSetup);
    const sw = await until(() => phone.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r && r.active ? r.active.state : null; }), 15000, 200);
    check('3c. the service worker is installed and active', sw === 'activated', sw);
    const kept = await until(() => phone.evaluate(async () => { const keys = await caches.keys(); const c = keys.find(k => k.startsWith('jzd-phone-')); if (!c) return null;
      const cache = await caches.open(c); const want = ['/', '/phone-shell.js', '/noble.js', '/vendor/zxing_reader.wasm', '/vendor/eng.traineddata.gz'];
      const have = []; for (const u of want) if (await cache.match(u)) have.push(u); return have.length === want.length ? have : null; }), 30000, 500);
    check('3d. it keeps the app, and the VIN scanner\'s readers for scanning with no signal', !!kept, JSON.stringify(kept));
    /* a moment for the last book to be kept on the phone */
    await until(() => phone.evaluate(async () => !!(await new Promise(r => { const q = indexedDB.open('jzd-phone', 1); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('lastBook'); g.onsuccess = () => r(g.result); g.onerror = () => r(null); }; q.onerror = () => r(null); }))), 8000, 200);

    /* ================= 4. the mobile job: no network at all ================= */
    await phoneCtx.setOffline(true);
    await phone.reload();
    const t0 = Date.now();
    const opened = await until(() => phone.evaluate(() => typeof db === 'object' && db.customers && db.customers.c1 && db.customers.c1.first === 'Dana' && Object.keys(db.inspections).length === 1), 15000, 100);
    const openMs = Date.now() - t0;
    console.log('        measured: opened with no network in ' + openMs + ' ms');
    check('4a. with no network the phone still opens the app and the shop\'s book, in a few seconds', !!opened && openMs < 8000, openMs);
    await phone.evaluate(() => openInspection('o1'));
    await phone.waitForSelector(F('mp|tires.tire.LF|tread'));
    await phone.selectOption(F('mp|tires.tire.LF|tread'), '3');
    await phone.evaluate(() => { const i = Object.values(db.inspections)[0]; i.notes = (i.notes || '') + 'Mobile job: LF tread low, customer declined today.'; save(); });
    const shot = await phone.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
      const g = c.getContext('2d'); g.fillStyle = '#345'; g.fillRect(0, 0, 1200, 900); g.fillStyle = '#fc0'; g.fillRect(200, 200, 500, 300);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      const meta = await attAdd(new File([blob], 'IMG_0501.JPG', { type: 'image/jpeg' }), 'insp', inspId + '|tires.tire.LF', { orderId: 'o1', vehicleId: 'v1' });
      return { id: meta.id, sha: meta.sha256 };
    });
    await wait(1500);
    const waitingOnPhone = await phone.evaluate(async () => { const s = await window.__TAURI__.core.invoke('sync_status'); return s.client; });
    const deskMeanwhile = await desk.evaluate(() => { const i = Object.values(db.inspections)[0]; return JSON.stringify(i).includes('Mobile job'); });
    check('4b. the work done away waits on the phone (and has not reached the shop yet)', waitingOnPhone && waitingOnPhone.online === false && waitingOnPhone.pending >= 1 && !deskMeanwhile, JSON.stringify(waitingOnPhone));

    /* ================= 5. back at the shop ================= */
    await phoneCtx.setOffline(false);
    const t1 = Date.now();
    const arrived = await until(() => desk.evaluate(() => { const i = Object.values(db.inspections)[0]; const t = i && i.items && i.items['tires.tire.LF'];
      return JSON.stringify(i).includes('Mobile job: LF tread low') && JSON.stringify(i).includes('"tread":"3"'); }), 20000, 200);
    console.log('        measured: reached the office desktop ' + (Date.now() - t1) + ' ms after the network came back');
    check('5a. back on the network, the inspection and the note reach the office desktop by themselves', !!arrived,
      await desk.evaluate(() => JSON.stringify(Object.values(db.inspections)[0]).slice(0, 400)));
    const photoAtShop = await until(() => desk.evaluate(id => !!db.attachments[id], shot.id), 15000, 200);
    const bytes = await until(async () => { try { return await ctl(HOST_CTL, 'att_read', { id: shot.id }); } catch (e){ return null; } }, 15000, 300);
    const sha = b => crypto.createHash('sha256').update(Buffer.from(b, 'base64')).digest('hex');
    check('5b. and the photo taken with no signal is at the shop, byte for byte', photoAtShop && !!bytes && sha(bytes) === shot.sha, bytes ? sha(bytes) + ' vs ' + shot.sha : 'none');
    const synced = await until(async () => { const t = await phone.evaluate(() => document.getElementById('saveState').textContent); return t === 'SYNCED' ? t : null; }, 10000, 200);
    check('5c. the phone says SYNCED again', !!synced, await phone.evaluate(() => document.getElementById('saveState').textContent));
    check('6. no script errors on the desktop or the phone', !desk.errs.length && !phone.errs.length, desk.errs.concat(phone.errs).join(' | '));
  } catch (e){
    failures.push('the run stopped: ' + (e && e.stack || e));
    console.log(' FAIL   the run stopped: ' + (e && e.stack || e));
  } finally {
    /* take this run's certificate back out of the Windows certificate store */
    if (started) try { await ctl(HOST_CTL, 'sync_https_forget'); } catch (e){}
    await browser.close();
    for (const p of procs) try { p.kill(); } catch (e){}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e){}
  }
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL PHONE OFFLINE CHECKS PASSED');
  process.exit(0);
})();
