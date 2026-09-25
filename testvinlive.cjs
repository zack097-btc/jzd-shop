/* Live VIN scanning: the camera pointed at the sticker (2.9.3).

   The phone's camera is replaced by a moving picture drawn here (a canvas
   stream standing in for getUserMedia), so what the live reader sees is
   known exactly. Checked, through the real readers from vendor/:
     - a door-jamb barcode is read live and offered only after two separate
       frames agree, then NHTSA's decode is shown and nothing is filled in
       until USE THIS VIN;
     - a printed VIN (no barcode) is read live the same way;
     - a printed VIN whose check digit does not calculate is never offered
       live (READ THIS FRAME is the way for that), and neither is a picture
       with no VIN;
     - READ THIS FRAME runs the full photo reader;
     - closing the scanner turns the camera off. */
const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const failures = [];
function check(name, cond, detail){
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 700)));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/octet-stream' };
function serve(){
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const rel = u === '/' ? 'index.html' : u.replace(/^\/+/, '');
      if (!/^(index\.html|vendor\/[A-Za-z0-9._-]+)$/.test(rel)){ rsp.writeHead(404); rsp.end(); return; }
      const f = path.join(ROOT, rel);
      if (!fs.existsSync(f)){ rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}
const GOOD = '1HGCM82633A004352';
const BAD_TEXT = '1HGCM82643A004352';     /* one character off: the check digit does not calculate */

/* the stand-in camera: a canvas stream, redrawn with a little shake and noise
   so no two frames are the same */
const FAKE_CAMERA = `(() => {
  const cam = { scene: 'none', vin: '', stopped: 0, opened: 0 };
  window.__cam = cam;
  const C39 = { '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
    A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000', F: '001011000', G: '000001101', H: '100001100', J: '000011100', K: '100000011', L: '001000011',
    M: '101000010', N: '000010011', P: '001010010', R: '100000110', S: '001000110', T: '000010110', U: '110000001', V: '011000001', W: '111000000',
    X: '010010001', Y: '110010000', Z: '011010000', '*': '010010100' };
  function draw(c){
    const W = c.width, H = c.height, g = c.getContext('2d');
    const dx = (Math.random() - 0.5) * 12, dy = (Math.random() - 0.5) * 8;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#5a5f66'; g.fillRect(0, 0, W, H);
    if (cam.scene === 'none'){ g.fillStyle = '#777'; g.fillRect(200 + dx, 200 + dy, 900, 400); return; }
    g.translate(dx, dy);
    g.fillStyle = '#f4f1e8'; g.fillRect(90, 250, 1740, 580);
    g.fillStyle = '#111'; g.font = '26px Arial'; g.fillText('MFD BY AMERICAN HONDA MOTOR CO INC   06/03', 130, 300);
    if (cam.scene === 'text'){ g.font = 'bold 76px Consolas, monospace'; g.fillText(cam.vin, 230, 560); }
    if (cam.scene === 'barcode'){
      g.save(); g.translate(170, 420); g.rotate(-0.03);
      let x = 0; for (const ch of '*' + cam.vin + '*'){ const p = C39[ch]; for (let i = 0; i < 9; i++){ const wd = p[i] === '1' ? 9 : 4; if (i % 2 === 0){ g.fillStyle = '#000'; g.fillRect(x, 0, wd, 190); } x += wd; } x += 4; }
      g.restore();
    }
    for (let i = 0; i < 4000; i++){ g.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.3) + ')'; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
  }
  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async (want) => {
    cam.opened++; cam.want = want;
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    draw(c);
    const stream = c.captureStream(12);
    const t = setInterval(() => draw(c), 80);
    for (const tr of stream.getTracks()){ const stop = tr.stop.bind(tr); tr.stop = () => { cam.stopped++; clearInterval(t); stop(); }; }
    return stream;
  };
})();`;

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.addInitScript(FAKE_CAMERA);
  await ctx.route('https://vpic.nhtsa.dot.gov/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ Results: [{ ModelYear: '2003', Make: 'HONDA', Model: 'Accord', ErrorCode: '0' }] }) }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept());
  const until = async (fn, ms) => { const t0 = Date.now(); for (;;){ const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await page.waitForTimeout(100); } };
  const offered = () => page.evaluate(() => Array.from(document.querySelectorAll('#vinWork .vincand')).map(e => ({ vin: e.dataset.vin, cls: e.className, text: e.innerText })));
  try {
    await page.goto(base);
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload(); await page.waitForTimeout(300);
    await page.evaluate(() => {
      saveCustomer({ id: 'c1', first: 'Dana', last: 'Reyes', phone: '5095550100' });
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '', make: '', model: '', vin: '', mileage: '' }; save();
    });

    /* ---------- 1. a barcode, live ---------- */
    await page.evaluate(v => { __cam.scene = 'barcode'; __cam.vin = v; vinScanOpen({ purpose: 'vehicle', vehicleId: 'v1' }); }, GOOD);
    const btn = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#vinSheet button')).find(x => /POINT THE CAMERA/.test(x.textContent)); return b ? { first: b === document.querySelector('#vinSheet .phonebig') } : null; });
    check('1a. on a secure page the scanner offers the live camera first', !!btn && btn.first, JSON.stringify(btn));
    const t0 = Date.now();
    await page.evaluate(() => vinLive());
    const live = await until(async () => { const o = await offered(); return o.length ? o : null; }, 15000);
    const ms = Date.now() - t0;
    console.log('        measured: barcode read live in ' + ms + ' ms');
    const cam = await page.evaluate(() => ({ opened: __cam.opened, stopped: __cam.stopped, back: JSON.stringify(__cam.want) }));
    check('1b. pointed at a door-jamb barcode, the VIN is offered within a few seconds, from the barcode, check digit OK', !!live && live[0].vin === GOOD && /vin-high/.test(live[0].cls) && ms < 8000, JSON.stringify(live) + ' ' + ms);
    check('1c. it says two separate frames read the same 17 characters', !!live && /same 17 characters in \d+ separate camera frames/.test(await page.textContent('#vinWork')), await page.textContent('#vinWork'));
    check('1d. the camera asked for is the back camera, and it is off once the VIN is offered', /environment/.test(cam.back) && cam.stopped >= 1, JSON.stringify(cam));
    const before = await page.evaluate(() => db.vehicles.v1.vin);
    await page.waitForTimeout(600);
    const decode = await page.textContent('#vinDec0');
    check('1e. nothing is filled in yet; NHTSA\'s decode is shown for the person to compare', before === '' && /2003 HONDA Accord/.test(decode), JSON.stringify([before, decode]));
    await page.$eval('#vinWork .vincand button', b => b.click());
    check('1f. USE THIS VIN fills it in', await page.evaluate(v => db.vehicles.v1.vin === v, GOOD));

    /* ---------- 2. printed text only, live ---------- */
    await page.evaluate(v => { __cam.scene = 'text'; __cam.vin = v; db.vehicles.v1.vin = ''; vinScanOpen({ purpose: 'vehicle', vehicleId: 'v1' }); vinLive(); }, GOOD);
    const t1 = Date.now();
    const txt = await until(async () => { const o = await offered(); return o.length ? o : null; }, 30000);
    console.log('        measured: printed VIN read live in ' + (Date.now() - t1) + ' ms');
    check('2a. pointed at a printed VIN with no barcode, it is offered after two frames agree, check digit OK', !!txt && txt[0].vin === GOOD && /vin-good|vin-high/.test(txt[0].cls), JSON.stringify(txt));

    /* ---------- 3. what is never offered live ---------- */
    await page.evaluate(v => { __cam.scene = 'text'; __cam.vin = v; vinScanOpen({ purpose: 'vehicle', vehicleId: 'v1' }); vinLive(); }, BAD_TEXT);
    await page.waitForTimeout(9000);
    const bad = await offered();
    const stillLive = await page.evaluate(() => !!vinLiveState && !!document.getElementById('vinVideo'));
    check('3a. a printed VIN whose check digit does not calculate is never offered live — it keeps looking', !bad.length && stillLive, JSON.stringify(bad));
    await page.evaluate(() => { __cam.scene = 'none'; });
    await page.waitForTimeout(4000);
    check('3b. nor is anything offered from a picture with no VIN', !(await offered()).length);

    /* ---------- 4. READ THIS FRAME: the full photo reader ---------- */
    await page.evaluate(v => { __cam.scene = 'text'; __cam.vin = v; }, BAD_TEXT);
    await page.waitForTimeout(400);
    await page.evaluate(() => vinLiveCapture());
    const full = await until(async () => { const o = await offered(); if (o.length) return o; const t = await page.textContent('#vinWork'); return /NO VIN FOUND/.test(t) ? [{ none: true }] : null; }, 60000);
    check('4. READ THIS FRAME runs the full reader: the misread VIN is shown as NOT checking, never as checked',
      !!full && !full[0].none && full.every(c => /vin-low|vin-check/.test(c.cls) || c.vin !== GOOD) && full.some(c => /DOES NOT CALCULATE|DISAGREED/.test(c.text)), JSON.stringify(full));

    /* ---------- 5. the camera is let go ---------- */
    await page.evaluate(() => { __cam.scene = 'none'; vinScanOpen({ purpose: 'vehicle', vehicleId: 'v1' }); vinLive(); });
    await until(() => page.evaluate(() => !!(vinLiveState && vinLiveState.video)), 5000);
    const openedNow = await page.evaluate(() => __cam.stopped);
    await page.evaluate(() => closeVin());
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ stopped: __cam.stopped, state: vinLiveState }));
    check('5. closing the scanner turns the camera off', after.stopped === openedNow + 1 && after.state === null, JSON.stringify([openedNow, after]));
    check('6. no script errors', !errs.length, errs.join(' | '));
  } catch (e){
    failures.push('the run stopped: ' + (e && e.stack || e));
    console.log(' FAIL   the run stopped: ' + (e && e.stack || e));
  } finally { await browser.close(); srv.close(); }
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL LIVE VIN CHECKS PASSED');
  process.exit(0);
})();
