/* Shop Sync across real computers (2.8.3).

   Two separate processes, each one "computer" running the desktop shell
   (desktop/shophub, bin shophub-sim), talk to each other over a real socket.
   Each has the real index.html open in its own browser page; the page reaches
   its own process in place of Tauri's IPC. Checked on the screen itself:
   moving a v2.8.2 book (with a photo) into the Shop Hub, pairing with the
   code and the matching digits, a wrong code refused, live inspection edits
   without redrawing the page, different fields merging, the same field
   asking which to keep, the offline queue, photos both ways, shop numbers,
   BACK UP NOW, and the host and the laptop each restarting.

   SHOPHUB_SIM=<path to shophub-sim(.exe)> overrides where the harness is. */
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const SIM = process.env.SHOPHUB_SIM || 'C:/Users/zack0/AppData/Local/Temp/shophubt/debug/shophub-sim.exe';
const HUB_PORT = 47911, HOST_CTL = 47901, LAPTOP_CTL = 47902;
const results = {};
const failures = [];
function check(name, cond, detail){
  results[name] = cond ? 'PASS' : 'FAIL';
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 600)));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const F = f => '[data-f="' + f.replace(/"/g, '\\"') + '"]';
async function until(fn, ms, step){
  const t0 = Date.now();
  for (;;){
    let v; try { v = await fn(); } catch (e){ v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(step || 25);
  }
}

const procs = {};
function startSim(name, dir, ctl, extra){
  return new Promise((resolve, reject) => {
    const p = spawn(SIM, ['--dir', dir, '--ctl', String(ctl)].concat(extra || []), { stdio: ['ignore', 'pipe', 'pipe'] });
    procs[name] = p;
    let out = '';
    const to = setTimeout(() => reject(new Error(name + ' did not start: ' + out)), 15000);
    p.stdout.on('data', d => { out += d; if (/READY/.test(out)){ clearTimeout(to); resolve(p); } });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', c => { if (!/READY/.test(out)){ clearTimeout(to); reject(new Error(name + ' exited ' + c + ': ' + out)); } });
  });
}
function stopSim(name){
  return new Promise(resolve => {
    const p = procs[name]; if (!p || p.exitCode !== null){ resolve(); return; }
    p.on('exit', () => resolve());
    p.kill();
  });
}
async function ctl(port, cmd, args){
  const r = await fetch('http://127.0.0.1:' + port + '/invoke', { method: 'POST', body: JSON.stringify({ cmd, args: args || {} }) });
  const j = await r.json();
  if ('err' in j) throw new Error(j.err);
  return j.ok;
}

/* Tauri's invoke and event.listen, answered by that computer's process */
function shim(port){
  return `(() => {
    const base = 'http://127.0.0.1:${port}';
    window.__TAURI__ = {
      core: { invoke: async (cmd, args) => {
        const r = await fetch(base + '/invoke', { method: 'POST', body: JSON.stringify({ cmd, args: args || {} }) });
        const j = await r.json();
        if ('err' in j) throw j.err;
        return j.ok;
      } },
      event: { listen: async (name, cb) => {
        let after = 0;
        try { after = (await (await fetch(base + '/events-len')).json()).n; } catch (e) {}
        (async () => {
          for (;;){
            try {
              const list = await (await fetch(base + '/events?after=' + after)).json();
              for (const e of list){ after = e.n + 1; if (name === 'shopsync') cb({ payload: { kind: e.kind, data: e.data } }); }
            } catch (e){ await new Promise(r => setTimeout(r, 300)); }
          }
        })();
        return () => {};
      } }
    };
  })();`;
}

(async () => {
  if (!fs.existsSync(SIM)){ console.log('FAIL: the Shop Hub harness is not built: ' + SIM); process.exit(1); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jzdsync-'));
  const hostDir = path.join(root, 'office-desktop'), laptopDir = path.join(root, 'shop-laptop');
  fs.mkdirSync(hostDir); fs.mkdirSync(laptopDir);
  const browser = await chromium.launch();

  try {
    /* ---- a book written by v2.8.2 itself ---- */
    const showOld = () => execSync('git show v2.8.2:index.html', { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    let oldHtml = null;
    try { oldHtml = showOld(); }
    catch (e){
      try { execSync('git fetch --no-tags --depth 1 origin refs/tags/v2.8.2:refs/tags/v2.8.2', { stdio: 'ignore' }); oldHtml = showOld(); } catch (e2){ oldHtml = null; }
    }
    if (!oldHtml) throw new Error('could not read index.html from the v2.8.2 tag');
    const oldFile = path.join(root, 'index-2.8.2.html'); fs.writeFileSync(oldFile, oldHtml);
    const op = await browser.newPage();
    await op.goto('file://' + oldFile.replace(/\\/g, '/'), { waitUntil: 'load' });
    await op.evaluate(() => localStorage.clear());
    await op.reload({ waitUntil: 'load' });
    const oldInfo = await op.evaluate(() => {
      db.settings.shopName = 'JZAC Designs';
      saveCustomer({ id: 'c1', first: 'Dana', last: 'Reyes', phone: '509-555-0100' });
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2019', make: 'Honda', model: 'Accord', vin: '1HGCV1F30KA000001', mileage: '64000' };
      db.orders.o1 = shapeOrder({ id: 'o1', customerId: 'c1', vehicleId: 'v1', date: '2026-09-13', status: 'In Progress', estimateNo: 101, labor: [], parts: [], extras: [], payments: [], history: [] });
      db.settings.nextEstimate = 102;
      const a = newInspection('o1', 'v1'); a.tech = 'Zack';
      Object.assign(inspItem(a, 'tires.tire.LF').meas, { tread: '6', psi: '35' }); setInspState(a, 'tires.tire.LF', 'Good');
      save();
      return { version: JZD_VERSION, insp: a.id };
    });
    await wait(400);
    const oldBookText = await op.evaluate(() => localStorage.getItem('jzd.shop.db'));
    await op.close();
    fs.writeFileSync(path.join(hostDir, 'shop.json'), oldBookText);
    const oldBookSha = require('crypto').createHash('sha256').update(oldBookText).digest('hex');
    check('0. the starting book was written by v2.8.2 itself', oldInfo.version === '2.8.2', JSON.stringify(oldInfo));

    await startSim('host', hostDir, HOST_CTL, ['--hub-port', String(HUB_PORT)]);
    await startSim('laptop', laptopDir, LAPTOP_CTL);

    const openPage = async (port, label) => {
      const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
      await ctx.addInitScript(shim(port));
      const page = await ctx.newPage();
      page.errs = []; page.on('pageerror', e => page.errs.push(e.message));
      page.dialogs = []; page.on('dialog', d => { page.dialogs.push(d.message()); d.accept(); });
      page.label = label;
      await page.goto(APP, { waitUntil: 'load' });
      await until(() => page.evaluate(() => typeof db === 'object' && db && typeof syncMode === 'string' && !!window.__syncLoad && !!syncStatus), 8000);
      return page;
    };
    const saveState = page => page.evaluate(() => document.getElementById('saveState').textContent);
    const idle = page => until(() => page.evaluate(() => !dirty && !saving), 5000);

    /* ================= 1. the office desktop becomes the Shop Hub ================= */
    let host = await openPage(HOST_CTL, 'host');
    const h1a = await host.evaluate(() => ({ mode: syncMode, desk: DESKTOP, orders: Object.keys(db.orders).length, insp: Object.keys(db.inspections || {}).length, locked: storageLocked }));
    check('1a. before Shop Sync the desktop keeps its own book, as in v2.8.2', h1a.mode === 'local' && h1a.desk && h1a.insp === 1 && h1a.orders === 1, JSON.stringify(h1a));

    /* a photo taken before hosting: it must move into the hub */
    const hostPhoto = await host.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 48;
      const g = c.getContext('2d'); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 64, 48); g.fillStyle = '#fff'; g.fillText('LF', 20, 28);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const meta = await attAdd(new File([blob], 'lf-tire.png', { type: 'image/png' }), 'inspection', 'tires.tire.LF', { orderId: 'o1', vehicleId: 'v1' });
      return { id: meta.id, sha: meta.sha256, size: meta.size };
    });
    await idle(host); await wait(200);
    const bookBeforeHub = fs.readFileSync(path.join(hostDir, 'shop.json'), 'utf8');

    await host.evaluate(() => go('shopsync'));
    await host.waitForSelector('#ss_shop');
    await host.fill('#ss_shop', 'JZAC Designs');
    await host.fill('#ss_hostname', 'Office Desktop');
    await host.click('text=HOST THIS SHOP');
    const hosted = await until(async () => (await ctl(HOST_CTL, 'sync_status')).mode === 'host', 20000, 100);
    if (!hosted) throw new Error('hosting did not finish: ' + await host.evaluate(() => shopSyncMsg + ' | ' + ((document.getElementById('shopSyncBody') || {}).textContent || '')).catch(e => String(e)));
    await until(() => host.evaluate(() => typeof syncMode === 'string' && syncMode === 'host'), 10000);
    const hs = await ctl(HOST_CTL, 'sync_status');
    const migration = JSON.parse(fs.readFileSync(path.join(hostDir, 'shophub', 'sync.json'), 'utf8')).migration || {};
    check('1b. HOST THIS SHOP: the hub is RUNNING and this computer is the host', hs.mode === 'host' && hs.hub && hs.hub.running, JSON.stringify(hs).slice(0, 400));
    check('1c. migration took a backup of the book and photos first', migration.preBackup && fs.existsSync(path.join(migration.preBackup, 'shop.json')) &&
      fs.readFileSync(path.join(migration.preBackup, 'shop.json'), 'utf8') === bookBeforeHub &&
      fs.readdirSync(path.join(migration.preBackup, 'attachments')).length === 1, JSON.stringify(migration).slice(0, 400));
    const rep = migration.report || {};
    check('1d. migration imported and verified every field and the photo', rep.verified === true && rep.leaves > 100 && rep.attachments === 1 && hs.hub.photosStored === 1, JSON.stringify(rep).slice(0, 300));
    check('1e. the original book file is kept, unchanged', fs.readFileSync(path.join(hostDir, 'shop.json'), 'utf8') === bookBeforeHub);
    const hostBook = await host.evaluate(() => ({ orders: Object.keys(db.orders).length, insp: Object.keys(db.inspections).length, att: Object.keys(db.attachments).length, tread: Object.values(db.inspections)[0].items['tires.tire.LF'].meas.tread, name: db.customers.c1.first }));
    check('1f. after the move the screen shows the same shop (ticket, inspection, photo record, LF 6/32)',
      hostBook.orders === 1 && hostBook.insp === 1 && hostBook.att === 1 && hostBook.tread === '6' && hostBook.name === 'Dana', JSON.stringify(hostBook));
    check('1g. the page says SYNCED on the host', !!(await until(async () => (await saveState(host)) === 'SYNCED', 6000)), await saveState(host));
    check('1h. a first hub backup was taken and verified before first use', !!(migration.firstHubBackup && migration.firstHubBackup.path && fs.existsSync(path.join(migration.firstHubBackup.path, 'manifest.json'))));
    void oldBookSha;

    /* ================= 2. pairing ================= */
    await host.evaluate(() => go('shopsync'));
    await host.click('text=PAIR DEVICE');
    const code = await until(async () => { const t = await host.textContent('#ss_paircode').catch(() => null); return t && /^\d{3} \d{3}$/.test(t.trim()) ? t.trim() : null; }, 5000);
    check('2a. PAIR DEVICE shows a one-time six-digit code (e.g. 482 193)', !!code, code);

    let laptop = await openPage(LAPTOP_CTL, 'laptop');
    await laptop.evaluate(() => go('shopsync'));
    await laptop.waitForSelector('#ss_addr');
    /* a wrong code first: refused, nothing saved */
    const wrong = code.replace(/^\d/, d => String((Number(d) + 1) % 10));
    await laptop.fill('#ss_addr', '127.0.0.1:' + HUB_PORT);
    await laptop.fill('#ss_code', wrong);
    await laptop.fill('#ss_name', 'Shop Laptop');
    await laptop.click('text=CONNECT TO SHOP HUB');
    const refused = await until(() => laptop.evaluate(() => { const j = (syncStatus && syncStatus.join) || {}; return j.state === 'failed' ? j.error : null; }), 8000);
    check('2b. a wrong pairing code is refused and the laptop stays unpaired', !!refused && (await ctl(LAPTOP_CTL, 'sync_status')).mode === 'local', refused);
    const secretsAfterWrong = fs.existsSync(path.join(laptopDir, 'secrets.json')) ? fs.readFileSync(path.join(laptopDir, 'secrets.json'), 'utf8') : '';
    check('2c. nothing was stored for the refused attempt', !/shop\//.test(secretsAfterWrong), secretsAfterWrong.slice(0, 200));

    /* an unauthenticated connection gets nothing */
    const unauth = await new Promise(resolve => {
      const net = require('net');
      const s = net.connect(HUB_PORT, '127.0.0.1', () => {
        s.write('GET /shophub HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        const hello = JSON.stringify({ t: 'hello', device: 'dev-fake', nonce: 'AAAAAAAAAAAAAAAAAAAAAA==', mac: 'AAAA' });
        const buf = Buffer.from(hello); const mask = Buffer.from([1, 2, 3, 4]);
        const head = Buffer.from([0x81, 0x80 | buf.length]);
        const body = Buffer.from(buf.map((b, i) => b ^ mask[i % 4]));
        setTimeout(() => s.write(Buffer.concat([head, mask, body])), 100);
      });
      let got = '';
      s.on('data', d => { got += d.toString('latin1'); });
      s.on('close', () => resolve(got));
      s.on('error', () => resolve(got));
      setTimeout(() => { s.destroy(); resolve(got); }, 4000);
    });
    check('2d. a device that is not paired is refused and receives no shop data', !/Dana|Accord|inspections/.test(unauth) && /refused|not paired|unknown/i.test(unauth), unauth.slice(-300));

    await laptop.fill('#ss_code', code);
    await laptop.click('text=CONNECT TO SHOP HUB');
    const verifyLaptop = await until(() => laptop.evaluate(() => { const j = (syncStatus && syncStatus.join) || {}; return j.state === 'verify' ? j.verify : null; }), 8000);
    /* the code was single-use for the wrong attempt? No: a wrong code does not use it up */
    const req = await until(async () => { const el = await host.$('[data-pairreq]'); return el ? await el.textContent() : null; }, 8000);
    check('2e. both screens show the same verification digits before approving', !!verifyLaptop && !!req && req.includes(verifyLaptop) &&
      (await laptop.textContent('#ss_verify')).includes(verifyLaptop), (verifyLaptop || '') + ' | ' + (req || '') + ' | ' + JSON.stringify((await ctl(LAPTOP_CTL, 'sync_status')).join) + ' | ' + JSON.stringify((await ctl(HOST_CTL, 'sync_status')).hub.pairing));
    await Promise.all([
      laptop.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => null),
      host.click('[data-pairreq] >> text=Approve')
    ]);
    await until(() => laptop.evaluate(() => typeof syncMode === 'string' && syncMode === 'client' && Object.keys(db.orders).length === 1), 15000, 100);
    const lb = await laptop.evaluate(() => ({ mode: syncMode, orders: Object.keys(db.orders).length, insp: Object.keys(db.inspections).length, att: Object.keys(db.attachments).length, name: db.customers.c1 && db.customers.c1.first }));
    check('2f. host approves: the laptop joins and shows the shop from the hub', lb.mode === 'client' && lb.orders === 1 && lb.insp === 1 && lb.att === 1 && lb.name === 'Dana', JSON.stringify(lb));
    const secrets = fs.readFileSync(path.join(laptopDir, 'secrets.json'), 'utf8');
    const replicaText = fs.readdirSync(path.join(laptopDir, 'shophub')).join(',');
    check('2g. the laptop keeps a durable device credential in its secret store (not in the book)', /shop\//.test(secrets) &&
      !(await laptop.evaluate(() => JSON.stringify(db))).includes(JSON.parse(secrets)[Object.keys(JSON.parse(secrets)).find(k => /shop\//.test(k))] || '@@none'), replicaText);
    check('2h. the laptop says SYNCED', !!(await until(async () => (await saveState(laptop)) === 'SYNCED', 6000)), await saveState(laptop));
    const devs = await until(async () => { const s = await ctl(HOST_CTL, 'sync_status'); const d = (s.hub.devices || []).find(x => x.name === 'Shop Laptop'); return d && d.online ? s.hub.devices : null; }, 6000);
    check('2i. the host lists Shop Laptop as ONLINE', !!devs, JSON.stringify(devs));
    await host.evaluate(() => drawShopSyncLive());
    check('2j. the host device list shows ONLINE on screen', /Shop Laptop[\s\S]*ONLINE/.test(await host.textContent('#shopSyncBody')));

    /* ================= 3. live on the same inspection ================= */
    const openInsp = page => page.evaluate(() => { openInspection('o1'); });
    await openInsp(host); await openInsp(laptop);
    await host.waitForSelector(F('mp|tires.tire.LF|tread')); await laptop.waitForSelector(F('mp|tires.tire.LF|tread'));
    const presence = await until(async () => { const t = await host.evaluate(() => { syncPresenceDraw(); const el = document.querySelector('[data-presence]'); return el && el.textContent; }); return t && /OPEN ON: Shop Laptop/.test(t) ? t : null; }, 6000);
    check('3a. presence: the host shows "OPEN ON: Shop Laptop" on the inspection', !!presence, presence);

    /* the host is typing in a note on another row while the laptop changes LF */
    await host.evaluate(() => { document.getElementById('app').firstElementChild.__marker = 'same-page'; });
    const noteSel = await host.evaluate(() => { const el = document.querySelector('[data-rowkey="tires.tire.RR"] input[type="text"], [data-rowkey="tires.tire.RR"] textarea'); if (!el) return null; el.id = el.id || 'hostTyping'; return '#' + el.id; });
    if (noteSel){ await host.focus(noteSel); }
    const t0 = Date.now();
    await laptop.selectOption(F('mp|tires.tire.LF|tread'), '4');
    const ackAt = await until(() => laptop.evaluate(() => { const c = (syncStatus && syncStatus.client) || {}; return c.pending === 0 && document.getElementById('saveState').textContent === 'SYNCED'; }), 3000, 5);
    const tAck = Date.now() - t0;
    const seen = await until(() => host.evaluate(() => { const e = document.querySelector('[data-f="mp|tires.tire.LF|tread"]'); return e && e.value === '4'; }), 3000, 5);
    const tSeen = Date.now() - t0;
    results.latency = { acknowledgedMs: tAck, visibleOnOtherComputerMs: tSeen };
    console.log('        measured: laptop SYNCED after ' + tAck + ' ms; visible on the host screen after ' + tSeen + ' ms');
    check('3b. a tread change on the laptop appears on the host screen in under 1 second', !!seen && tSeen < 1000, tSeen);
    check('3c. SYNCED only after the hub acknowledged it', !!ackAt);
    const noRedraw = await host.evaluate(sel => ({ same: document.getElementById('app').firstElementChild.__marker === 'same-page', focus: sel ? document.activeElement === document.querySelector(sel) : true, db: db.inspections[inspId].items['tires.tire.LF'].meas.tread }), noteSel);
    check('3d. the host page was not redrawn and kept its focus while the row updated', noRedraw.same && noRedraw.focus && noRedraw.db === '4', JSON.stringify(noRedraw));
    await host.evaluate(() => document.activeElement && document.activeElement.blur());

    /* different fields at the same moment */
    await Promise.all([host.selectOption(F('mp|tires.tire.RF|tread'), '5'), laptop.selectOption(F('mp|tires.tire.LR|tread'), '7')]);
    const both = await until(async () => {
      const a = await host.evaluate(() => [db.inspections[inspId].items['tires.tire.RF'].meas.tread, (db.inspections[inspId].items['tires.tire.LR'] || { meas: {} }).meas.tread].join());
      const b = await laptop.evaluate(() => [(db.inspections[inspId].items['tires.tire.RF'] || { meas: {} }).meas.tread, db.inspections[inspId].items['tires.tire.LR'].meas.tread].join());
      return a === '5,7' && b === '5,7' ? a : null;
    }, 4000);
    check('3e. different fields changed on both computers at once: both kept, no conflict', !!both &&
      !(await laptop.evaluate(() => (syncStatus.client.conflicts || []).length)) && !(await host.evaluate(() => (syncStatus.client.conflicts || []).length)));
    const domBoth = await until(() => host.evaluate(() => { const e = document.querySelector('[data-f="mp|tires.tire.LR|tread"]'); return e && e.value === '7'; }), 3000);
    check('3f. the host screen shows the laptop\'s LR change', !!domBoth, await host.evaluate(() => document.querySelector('[data-f="mp|tires.tire.LR|tread"]').value));

    /* ================= 4. same field: ask, never overwrite ================= */
    await idle(laptop); await idle(host);
    await ctl(LAPTOP_CTL, 'sync_debug_pause', { on: true });
    await until(() => laptop.evaluate(() => syncStatus && syncStatus.client && !syncStatus.client.online), 4000);
    await laptop.selectOption(F('mp|tires.tire.LF|tread'), '5');
    /* meanwhile the desktop moves it twice, each one reaching the hub */
    for (const v of ['3', '4']){
      await host.selectOption(F('mp|tires.tire.LF|tread'), v);
      await idle(host);
      await until(async () => (await ctl(HOST_CTL, 'sync_status')).client.pending === 0, 3000);
    }
    await laptop.evaluate(() => syncRefresh());
    const offl1 = await until(async () => { const t = await saveState(laptop); return /^OFFLINE — 1 CHANGE WAITING TO SYNC$/.test(t) ? t : null; }, 4000);
    check('4a. with the network gone the laptop says OFFLINE — 1 CHANGE WAITING TO SYNC', !!offl1, await saveState(laptop));
    await ctl(LAPTOP_CTL, 'sync_debug_pause', { on: false });
    const dlg = await until(async () => { const el = await laptop.$('#syncConflict.on'); return el ? await el.textContent() : null; }, 8000);
    check('4b. the laptop asks: "LF … TREAD DEPTH CHANGED ON ANOTHER DEVICE — USE 5/32 / USE 4/32"', !!dlg && /LF .*TREAD.* CHANGED ON ANOTHER DEVICE/i.test(dlg) && /USE 5\/32/.test(dlg) && /USE 4\/32/.test(dlg), dlg);
    const hostStill = await host.evaluate(() => db.inspections[inspId].items['tires.tire.LF'].meas.tread);
    check('4c. nothing was overwritten while the question is open (host still 4/32)', hostStill === '4', hostStill);
    await laptop.click('#syncKeepMine');
    const settled = await until(async () => {
      const a = await host.evaluate(() => { const e = document.querySelector('[data-f="mp|tires.tire.LF|tread"]'); return db.inspections[inspId].items['tires.tire.LF'].meas.tread + '|' + (e && e.value); });
      const b = await laptop.evaluate(() => db.inspections[inspId].items['tires.tire.LF'].meas.tread);
      return a === '5|5' && b === '5' ? a : null;
    }, 5000);
    check('4d. USE 5/32 on the laptop: both computers show 5/32', !!settled);
    const audit = await until(() => host.evaluate(() => (db.audit || []).find(a => a.action === 'sync-conflict')), 5000);
    check('4e. the choice is recorded in the shop\'s activity history (seen on the host too)', !!audit && /Shop Laptop/.test(audit.reason) && audit.to === '5/32', JSON.stringify(audit));

    /* ================= 5. offline queue ================= */
    await idle(laptop);
    await ctl(LAPTOP_CTL, 'sync_debug_pause', { on: true });
    await until(() => laptop.evaluate(() => syncStatus && syncStatus.client && !syncStatus.client.online), 4000);
    const seven = [['tires.tire.RR', 'tread', '6'], ['tires.tire.LF', 'psi', '33'], ['tires.tire.RF', 'psi', '34'], ['tires.tire.LR', 'psi', '35'], ['tires.tire.RR', 'psi', '36'], ['brakes.pads.LF', 'inner', '8'], ['brakes.pads.LF', 'outer', '7']];
    for (const [k, m, v] of seven){
      await laptop.evaluate(([k, m, v]) => { const i = db.inspections[inspId]; const it = inspItem(i, k); it.meas[m] = v; save(); }, [k, m, v]);
      await idle(laptop);
    }
    await laptop.evaluate(() => syncRefresh());
    const offl7 = await until(async () => { const t = await saveState(laptop); return t === 'OFFLINE — 7 CHANGES WAITING TO SYNC' ? t : null; }, 4000);
    check('5a. seven changes made offline: "OFFLINE — 7 CHANGES WAITING TO SYNC"', !!offl7, await saveState(laptop) + ' pending=' + (await ctl(LAPTOP_CTL, 'sync_status')).client.pending);
    const tr = Date.now();
    await ctl(LAPTOP_CTL, 'sync_debug_pause', { on: false });
    const synced7 = await until(async () => (await saveState(laptop)) === 'SYNCED', 8000, 20);
    results.reconnectMs = Date.now() - tr;
    const hostGot7 = await until(() => host.evaluate(s => s.every(([k, m, v]) => (db.inspections[inspId].items[k] || { meas: {} }).meas[m] === v), seven), 4000);
    check('5b. back on the network: SYNCED, and the host has all seven', !!synced7 && !!hostGot7, results.reconnectMs + ' ms');
    console.log('        measured: reconnect to SYNCED ' + results.reconnectMs + ' ms');

    /* ================= 6. photos ================= */
    const viewOnLaptop = await laptop.evaluate(async id => { const b64 = await attGet(id); return b64 ? b64.length : 0; }, hostPhoto.id).catch(e => 'error ' + e);
    check('6a. the photo taken on the desktop before hosting opens on the laptop (fetched from the hub)', typeof viewOnLaptop === 'number' && viewOnLaptop > 50, viewOnLaptop);
    const hash = b64 => require('crypto').createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
    const lapCopy = await ctl(LAPTOP_CTL, 'att_read', { id: hostPhoto.id });
    check('6b. the laptop\'s copy has the same SHA-256 as the original', hash(lapCopy) === hostPhoto.sha, hash(lapCopy) + ' vs ' + hostPhoto.sha);
    const lapPhoto = await laptop.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 150;
      const g = c.getContext('2d'); for (let i = 0; i < 2000; i++){ g.fillStyle = 'hsl(' + (i * 7 % 360) + ',80%,50%)'; g.fillRect(Math.random() * 200, Math.random() * 150, 6, 6); }
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const meta = await attAdd(new File([blob], 'rr-tread.png', { type: 'image/png' }), 'inspection', 'tires.tire.RR', { orderId: 'o1', vehicleId: 'v1' });
      return { id: meta.id, sha: meta.sha256 };
    });
    const badgeSeen = [];
    const photoSynced = await until(async () => {
      const st = await laptop.evaluate(id => { syncPhotoBadges(); return syncAttState[id] || ''; }, lapPhoto.id);
      badgeSeen.push(st);
      return st === 'synced';
    }, 8000, 20);
    check('6c. a photo taken on the laptop goes PHOTO UPLOADING → PHOTO SYNCED', !!photoSynced, badgeSeen.slice(-5).join(','));
    const hostHas = await until(async () => { const b = await ctl(HOST_CTL, 'att_read', { id: lapPhoto.id }); return hash(b) === lapPhoto.sha; }, 5000);
    check('6d. the hub has the laptop\'s photo with the same SHA-256, recorded once', !!hostHas && (await ctl(HOST_CTL, 'sync_status')).hub.photosStored === 2);
    const hostRec = await until(() => host.evaluate(id => !!db.attachments[id], lapPhoto.id), 4000);
    check('6e. the photo record appears on the host', !!hostRec);

    /* ================= 7. shop numbers never collide ================= */
    const newEst = page => page.evaluate(() => { const o = shapeOrder({ id: uid('o'), customerId: 'c1', vehicleId: 'v1', date: '2026-09-13', status: 'Estimate', labor: [], parts: [], extras: [], payments: [], history: [] }); ensureNumber(o, 'estimate'); db.orders[o.id] = o; save(); return o.estimateNo; });
    const nums = [];
    for (let i = 0; i < 3; i++){ nums.push(await newEst(host)); nums.push(await newEst(laptop)); }
    check('7. estimates created on both computers get different numbers, continuing from the book (≥102)', new Set(nums).size === nums.length && nums.every(n => n >= 102), JSON.stringify(nums));
    await idle(host); await idle(laptop);

    /* ================= 8. BACK UP NOW ================= */
    await host.evaluate(() => go('shopsync'));
    await host.click('text=BACK UP NOW');
    const bk = await until(async () => { const t = await host.textContent('#shopSyncBody'); return /Backed up and verified/.test(t) ? t : null; }, 10000);
    check('8a. BACK UP NOW makes a backup and proves it rebuilds', !!bk, (await host.textContent('#shopSyncBody')).slice(0, 300));
    const backups = await ctl(HOST_CTL, 'sync_backups');
    const manual = (backups || []).find(b => b.reason === 'manual');
    const ver = manual ? await ctl(HOST_CTL, 'sync_verify_backup', { name: manual.name }) : null;
    check('8b. the backup verifies again from disk (fields and both photos)', !!ver && ver.photos === 2 && ver.leaves > 100, JSON.stringify(ver));

    /* ================= 9. the host restarts ================= */
    await stopSim('host');
    const hubOffline = await until(async () => /SHOP HUB OFFLINE/.test(await saveState(laptop)) ? await saveState(laptop) : null, 20000, 100);
    check('9a. host shut down: the laptop says SHOP HUB OFFLINE', !!hubOffline, await saveState(laptop));
    await laptop.evaluate(() => { db.customers.c1.phone = '509-555-0199'; save(); });
    await idle(laptop);
    await laptop.evaluate(() => syncRefresh());
    const q1 = await until(async () => { const t = await saveState(laptop); return /^OFFLINE — 1 CHANGE WAITING TO SYNC$/.test(t) ? t : null; }, 5000);
    check('9b. a change made while the host is down waits on the laptop', !!q1, await saveState(laptop));
    await startSim('host', hostDir, HOST_CTL, ['--hub-port', String(HUB_PORT)]);
    await host.reload({ waitUntil: 'load' });
    await until(() => host.evaluate(() => typeof syncMode === 'string' && syncMode === 'host'), 10000);
    const back = await until(async () => (await saveState(laptop)) === 'SYNCED', 20000, 100);
    const hostPhone = await until(() => host.evaluate(() => db.customers.c1.phone === '509-555-0199'), 8000, 100);
    check('9c. the host comes back: the laptop reconnects by itself, sends the change, SYNCED', !!back && !!hostPhone);
    const hostKept = await host.evaluate(() => ({ lf: db.inspections[Object.keys(db.inspections)[0]].items['tires.tire.LF'].meas.tread, atts: Object.keys(db.attachments).length, orders: Object.keys(db.orders).length }));
    check('9d. after the restart the hub still has everything (LF 5/32, 2 photos, 7 tickets)', hostKept.lf === '5' && hostKept.atts === 2 && hostKept.orders === 7, JSON.stringify(hostKept));

    /* ================= 10. the laptop restarts ================= */
    await stopSim('laptop');
    await host.evaluate(() => { openInspection('o1'); });
    await host.waitForSelector(F('mp|tires.tire.RF|tread'));
    await host.selectOption(F('mp|tires.tire.RF|tread'), '3');
    await idle(host);
    const offlineSeen = await until(async () => { const s = await ctl(HOST_CTL, 'sync_status'); const d = (s.hub.devices || []).find(x => x.name === 'Shop Laptop'); return d && !d.online ? d : null; }, 30000, 200);
    check('10a. the host shows Shop Laptop OFFLINE with when it was last seen', !!offlineSeen && !!offlineSeen.lastSeen, JSON.stringify(offlineSeen));
    await startSim('laptop', laptopDir, LAPTOP_CTL);
    await laptop.reload({ waitUntil: 'load' });
    const lapBack = await until(() => laptop.evaluate(() => typeof syncMode === 'string' && syncMode === 'client' && db.inspections[Object.keys(db.inspections)[0]].items['tires.tire.RF'].meas.tread === '3' && db.customers.c1.phone === '509-555-0199'), 15000, 100);
    check('10b. the laptop restarts still paired and catches up on what changed while it was off', !!lapBack);
    check('10c. the laptop says SYNCED after its restart', !!(await until(async () => (await saveState(laptop)) === 'SYNCED', 8000)), await saveState(laptop));

    /* ================= 11. revoke ================= */
    const lapId = (await ctl(LAPTOP_CTL, 'sync_status')).client.deviceId;
    await host.evaluate(() => go('shopsync'));
    await host.waitForSelector('text=REVOKE DEVICE');
    await host.click('text=REVOKE DEVICE');
    const revoked = await until(async () => { const s = await ctl(LAPTOP_CTL, 'sync_status'); return !s.client.online && /revoked|not paired|refused/i.test(s.client.lastError) ? s.client.lastError : null; }, 10000, 100);
    check('11. REVOKE DEVICE disconnects the laptop and it cannot reconnect', !!revoked && (await ctl(HOST_CTL, 'sync_status')).hub.devices.find(d => d.id === lapId).revoked, revoked);

    const errs = host.errs.concat(laptop.errs);
    check('12. no script errors on either computer', errs.length === 0, errs.join(' | '));
  } catch (e){
    failures.push('the run stopped: ' + (e && e.stack || e));
    console.log(' FAIL   the run stopped: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
    await stopSim('host'); await stopSim('laptop');
  }

  console.log('\n' + JSON.stringify({ latency: results.latency, reconnectMs: results.reconnectMs }));
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL SHOP SYNC CHECKS PASSED');
  process.exit(0);
})();
