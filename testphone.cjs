/* The shop phone (2.9): an iPhone on the shop's Wi-Fi, working alongside the
   laptop on the desk.

   Three things run for real here: the office desktop hosting the Shop Hub and
   the laptop, each its own process (desktop/shophub, bin shophub-sim), and a
   phone - a browser emulating an iPhone 13 - that opens the app from the hub's
   own address exactly as the shop's iPhone will, pairs with the code, and
   works through its seat on the hub.

   Checked: the phone pairs with the code and the matching digits; it opens the
   shop; a tread change on the phone reaches the laptop's screen in about a
   second, and the laptop's reaches the phone; a photo taken on the phone
   appears on the laptop with its thumbnail and the same bytes; the same note
   edited on both asks which to keep; with the Wi-Fi gone the phone keeps
   working and sends what it did when it is back; a revoked phone is shut out.

   SHOPHUB_SIM=<path to shophub-sim(.exe)> overrides where the harness is. */
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const PAGE = path.join(process.cwd(), 'index.html');
const SIM = process.env.SHOPHUB_SIM || 'C:/Users/zack0/AppData/Local/Temp/shophubt/debug/shophub-sim.exe';
const HUB = 47941, HOST_CTL = 47951, LAPTOP_CTL = 47952;
const failures = [];
function check(name, cond, detail){
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 600)));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));
/* the app is not laid out for a phone yet, so the page is zoomed out; press the
   button itself rather than a point on the zoomed screen */
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

(async () => {
  if (!fs.existsSync(SIM)){ console.log('FAIL: the Shop Hub harness is not built: ' + SIM); process.exit(1); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jzdphone-'));
  const hostDir = path.join(root, 'desk'), lapDir = path.join(root, 'lap');
  fs.mkdirSync(hostDir); fs.mkdirSync(lapDir);
  const browser = await chromium.launch();
  const openComputer = async port => {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addInitScript(shim(port));
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.on('dialog', d => d.accept());
    await p.goto(APP); await until(() => p.evaluate(() => typeof db === 'object' && !!syncStatus), 8000);
    return p;
  };
  try {
    await startSim(hostDir, HOST_CTL, ['--hub-port', String(HUB), '--page', PAGE]);
    await startSim(lapDir, LAPTOP_CTL);
    const desk = await openComputer(HOST_CTL);
    await desk.evaluate(() => {
      db.settings.shopName = 'JZAC Designs';
      saveCustomer({ id: 'c1', first: 'Dana', last: 'Reyes', phone: '5095550100' });
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2019', make: 'Honda', model: 'Accord', vin: '1HGCV1F30KA000001', mileage: '64000' };
      db.orders.o1 = shapeOrder({ id: 'o1', customerId: 'c1', vehicleId: 'v1', date: '2026-09-24', status: 'In Progress', estimateNo: 1, labor: [], parts: [], extras: [], payments: [], history: [] });
      newInspection('o1', 'v1'); save();
    });
    await until(() => desk.evaluate(() => !dirty && !saving), 5000); await wait(300);
    await ctl(HOST_CTL, 'sync_host_enable', { shopName: 'JZAC Designs', deviceName: 'Office Desktop', port: HUB });
    await desk.reload(); await until(() => desk.evaluate(() => syncMode === 'host'), 10000);
    /* the laptop, paired the ordinary way */
    let code = (await ctl(HOST_CTL, 'sync_pair_open')).code;
    await ctl(LAPTOP_CTL, 'sync_join', { address: '127.0.0.1:' + HUB, code, deviceName: 'Shop Laptop' });
    let req = await until(async () => (await ctl(HOST_CTL, 'sync_status')).hub.pairRequests[0], 8000);
    await ctl(HOST_CTL, 'sync_pair_decide', { id: req.id, approve: true });
    await until(async () => (await ctl(LAPTOP_CTL, 'sync_status')).mode === 'client', 10000);
    const lap = await openComputer(LAPTOP_CTL);
    await until(() => lap.evaluate(() => Object.keys(db.inspections).length === 1), 10000);

    /* ================= 1. the phone opens the app from the hub ================= */
    const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
    const phone = await phoneCtx.newPage();
    phone.errs = []; phone.on('pageerror', e => phone.errs.push(e.message)); phone.on('dialog', d => d.accept());
    const url = 'http://127.0.0.1:' + HUB + '/';
    await phone.goto(url);
    const pairScreen = await until(async () => (await phone.$('#phonePair')) && await phone.textContent('#phonePair'), 8000);
    check('1a. the phone opens the hub\'s address and asks to be connected (no App Store, no install)', !!pairScreen && /Connect this phone to the shop/.test(pairScreen), pairScreen);
    check('1b. the phone brought its own crypto (Safari has none on plain Wi-Fi)', await phone.evaluate(() => !!(window.JZDCrypto && window.JZDCrypto.p256 && window.JZDCrypto.chacha20poly1305)));

    /* a wrong code first */
    code = (await ctl(HOST_CTL, 'sync_pair_open')).code;
    const wrong = code.replace(/^\d/, d => String((Number(d) + 1) % 10));
    await phone.fill('#pp_code', wrong); await press(phone, '#pp_go');
    const refused = await until(async () => { const t = await phone.textContent('#pp_state'); return /Not connected/.test(t) ? t : null; }, 6000);
    check('1c. a wrong code is refused on the phone', !!refused, refused);

    await phone.fill('#pp_code', code.replace(/(\d{3})(\d{3})/, '$1 $2'));
    await phone.fill('#pp_name', 'Shop iPhone');
    await press(phone, '#pp_go');
    const digits = await until(async () => { const el = await phone.$('#pp_verify'); return el ? (await el.textContent()).trim() : null; }, 8000);
    req = await until(async () => (await ctl(HOST_CTL, 'sync_status')).hub.pairRequests[0], 8000);
    check('1d. the phone and the host show the same six digits, and the host knows it is a phone', !!digits && !!req && req.verify === digits && req.kind === 'phone' && req.name === 'Shop iPhone', JSON.stringify([digits, req]));
    await ctl(HOST_CTL, 'sync_pair_decide', { id: req.id, approve: true });
    const loaded = await until(() => phone.evaluate(() => typeof db === 'object' && db.customers && db.customers.c1 && db.customers.c1.first === 'Dana' && Object.keys(db.inspections).length === 1), 15000, 100);
    check('1e. approved: the phone opens the shop from the hub', !!loaded);
    const stored = await phone.evaluate(() => JSON.parse(localStorage.getItem('jzd.phone.link') || '{}'));
    check('1f. the phone keeps its device credential on the phone, and none of it is in the shop book', !!stored.device && !!stored.secret &&
      !(await desk.evaluate(s => JSON.stringify(db).includes(s), stored.secret)), JSON.stringify(Object.keys(stored)));
    const phoneSaid = await until(async () => { const t = await phone.evaluate(() => document.getElementById('saveState').textContent); return t === 'SYNCED' ? t : null; }, 8000);
    check('1g. the phone says SYNCED', !!phoneSaid, await phone.evaluate(() => document.getElementById('saveState').textContent));

    /* ================= 2. live, both ways ================= */
    for (const p of [lap, phone]) await p.evaluate(() => openInspection('o1'));
    await phone.waitForSelector(F('mp|tires.tire.LF|tread')); await lap.waitForSelector(F('mp|tires.tire.LF|tread'));
    const presence = await until(async () => { const t = await lap.evaluate(() => { syncPresenceDraw(); const el = document.querySelector('[data-presence]'); return el && el.textContent; }); return /OPEN ON: .*Shop iPhone/.test(t || '') ? t : null; }, 8000);
    check('2a. the laptop shows the inspection is OPEN ON: Shop iPhone', !!presence, presence);
    let t0 = Date.now();
    await phone.selectOption(F('mp|tires.tire.LF|tread'), '4');
    const seenOnLaptop = await until(() => lap.evaluate(() => { const e = document.querySelector('[data-f="mp|tires.tire.LF|tread"]'); return e && e.value === '4'; }), 4000, 10);
    const phoneToLaptop = Date.now() - t0;
    console.log('        measured: phone → laptop screen ' + phoneToLaptop + ' ms');
    check('2b. a tread set on the phone appears on the laptop\'s screen within 2 seconds', !!seenOnLaptop && phoneToLaptop < 2000, phoneToLaptop);
    t0 = Date.now();
    await lap.selectOption(F('mp|tires.tire.RF|tread'), '6');
    const seenOnPhone = await until(() => phone.evaluate(() => { const e = document.querySelector('[data-f="mp|tires.tire.RF|tread"]'); return e && e.value === '6'; }), 4000, 10);
    const laptopToPhone = Date.now() - t0;
    console.log('        measured: laptop → phone screen ' + laptopToPhone + ' ms');
    check('2c. and the laptop\'s change appears on the phone within 2 seconds', !!seenOnPhone && laptopToPhone < 2000, laptopToPhone);

    /* ================= 3. a photo taken on the phone ================= */
    const shot = await phone.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 4032; c.height = 3024;            /* the size an iPhone camera takes */
      const g = c.getContext('2d'); for (let i = 0; i < 3000; i++){ g.fillStyle = 'hsl(' + (i * 7 % 360) + ',70%,50%)'; g.fillRect(Math.random() * 4032, Math.random() * 3024, 40, 40); }
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
      const meta = await attAdd(new File([blob], 'IMG_0412.JPG', { type: 'image/jpeg' }), 'insp', inspId + '|tires.tire.RR', { orderId: 'o1', vehicleId: 'v1' });
      return { id: meta.id, sha: meta.sha256, size: meta.size, original: blob.size, thumb: !!meta.thumb };
    });
    check('3a. a full-size iPhone photo is made smaller on the phone before it is sent', shot.size < shot.original && shot.size < 2.5e6, JSON.stringify(shot));
    const onLaptop = await until(() => lap.evaluate(id => db.attachments[id] && db.attachments[id].thumb ? db.attachments[id] : null, shot.id), 5000);
    check('3b. the photo record and its thumbnail reach the laptop within seconds', !!onLaptop && onLaptop.ctx === 'insp', JSON.stringify(onLaptop && { ctx: onLaptop.ctx, ctxId: onLaptop.ctxId }));
    const lapBytes = await until(async () => { try { return await ctl(LAPTOP_CTL, 'att_read', { id: shot.id }); } catch (e){ return null; } }, 8000, 200);
    const sha = b => require('crypto').createHash('sha256').update(Buffer.from(b, 'base64')).digest('hex');
    check('3c. the laptop opens the full photo, byte for byte what the phone sent', !!lapBytes && sha(lapBytes) === shot.sha, lapBytes ? sha(lapBytes) + ' vs ' + shot.sha : 'none');

    /* ================= 4. the same note on the phone and the laptop ================= */
    await lap.evaluate(() => openItemDetail('tires.tire.RR'));
    await lap.fill('#d_note', 'from the laptop');
    await phone.evaluate(() => openItemDetail('tires.tire.RR'));
    await phone.fill('#d_note', 'cracked wheel');
    await press(phone, '#recSheet button.green');
    await wait(1500);
    await lap.click('#recSheet button.green');
    const dlg = await until(async () => { const el = await lap.$('#syncConflict.on'); return el ? await el.textContent() : null; }, 6000);
    check('4a. the same note changed on the phone and the laptop asks which to keep', !!dlg && /TECHNICIAN NOTE CHANGED ON ANOTHER DEVICE/.test(dlg) && /cracked wheel/.test(dlg), dlg);
    await lap.click('#syncKeepTheirs');
    const agreed = await until(async () => {
      const a = await lap.evaluate(() => db.inspections[inspId].items['tires.tire.RR'].note);
      const b = await phone.evaluate(() => db.inspections[inspId].items['tires.tire.RR'].note);
      return a === 'cracked wheel' && b === 'cracked wheel';
    }, 6000);
    check('4b. the phone\'s note is kept on both', !!agreed);

    /* ================= 5. the phone out of Wi-Fi range ================= */
    await phone.evaluate(() => JZD_PHONE_DEBUG.offline(true));
    const off = await until(async () => { const t = await phone.evaluate(() => { syncRefresh(); return document.getElementById('saveState').textContent; }); return /OFFLINE|SHOP HUB OFFLINE/.test(t) ? t : null; }, 6000);
    check('5a. out of range the phone says so', !!off, off);
    await phone.selectOption(F('mp|tires.tire.LR|tread'), '5');
    await phone.evaluate(() => { db.inspections[inspId].items['tires.tire.LR'] = db.inspections[inspId].items['tires.tire.LR'] || {}; });
    const offlinePhoto = await phone.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 400; c.height = 300; c.getContext('2d').fillRect(0, 0, 200, 150);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      const meta = await attAdd(new File([blob], 'lr.jpg', { type: 'image/jpeg' }), 'insp', inspId + '|tires.tire.LR', { orderId: 'o1', vehicleId: 'v1' });
      return { id: meta.id, sha: meta.sha256 };
    });
    await until(() => phone.evaluate(() => !dirty && !saving), 5000);
    const waitingText = await phone.evaluate(() => { syncIndicator(); return document.getElementById('saveState').textContent; });
    check('5b. what is done offline is kept on the phone: OFFLINE — CHANGES WAITING TO SYNC', /OFFLINE — \d+ CHANGES? WAITING TO SYNC/.test(waitingText), waitingText);
    check('5c. the laptop has not been told anything yet', await lap.evaluate(() => (db.inspections[inspId].items['tires.tire.LR'] || { meas: {} }).meas.tread !== '5'));
    await lap.selectOption(F('mp|tires.tire.RR|tread'), '3');   /* the laptop keeps working meanwhile */
    await wait(800);
    await phone.evaluate(() => JZD_PHONE_DEBUG.offline(false));
    const caughtUp = await until(async () => {
      const a = await lap.evaluate(() => (db.inspections[inspId].items['tires.tire.LR'] || { meas: {} }).meas.tread);
      const b = await phone.evaluate(() => db.inspections[inspId].items['tires.tire.RR'].meas.tread);
      return a === '5' && b === '3';
    }, 10000, 100);
    check('5d. back in range: the phone\'s offline change reaches the laptop, and the laptop\'s reaches the phone', !!caughtUp);
    check('5e. and the phone did not drag the laptop\'s change back (RR stays 3/32 on the laptop)', await lap.evaluate(() => db.inspections[inspId].items['tires.tire.RR'].meas.tread === '3'));
    const offBytes = await until(async () => { try { return await ctl(LAPTOP_CTL, 'att_read', { id: offlinePhoto.id }); } catch (e){ return null; } }, 10000, 200);
    check('5f. the photo taken offline arrives, byte for byte', !!offBytes && sha(offBytes) === offlinePhoto.sha);
    const back = await until(async () => { const t = await phone.evaluate(() => document.getElementById('saveState').textContent); return t === 'SYNCED' ? t : null; }, 8000);
    check('5g. the phone says SYNCED again', !!back, await phone.evaluate(() => document.getElementById('saveState').textContent));

    /* ================= 6. revoked ================= */
    const phoneId = stored.device;
    await ctl(HOST_CTL, 'sync_revoke', { deviceId: phoneId });
    const shut = await until(async () => { const el = await phone.$('#phonePair'); return el ? await el.textContent() : null; }, 8000);
    check('6. a revoked phone is shut out and asks to be paired again', !!shut && /revoked/i.test(shut), shut);

    const errs = desk.errs.concat(lap.errs, phone.errs);
    check('7. no script errors on any device', errs.length === 0, errs.join(' | '));
  } catch (e){
    failures.push('the run stopped: ' + (e && e.stack || e));
    console.log(' FAIL   the run stopped: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
    procs.forEach(p => p.kill());
  }
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL SHOP PHONE CHECKS PASSED');
  process.exit(0);
})();
