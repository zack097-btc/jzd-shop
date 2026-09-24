/* The VIN scanner (2.9).

   What matters most: a VIN is never filled in wrong without someone seeing
   that it might be. Checked on photographs made here - a door-jamb label with
   a Code 39 barcode (tilted, noisy), printed text, a light-on-dark windshield
   style plate, a QR code, a photo with no VIN, a barcode whose check digit does
   not calculate, and text with one misread character - through the real
   readers (zxing-cpp and Tesseract, from vendor/), served over HTTP the way
   the Shop Hub serves them to a phone. NHTSA is answered by a fixture. */
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

/* a real VIN with a valid check digit, and the one character that breaks it */
const GOOD = '1HGCM82633A004352';          /* 2003 Honda Accord, check digit 3 */
const TRUCK = '1FTFW1ET9DFC10312';         /* 2013 Ford F-150 (check digit 9) */
const EURO = 'WVWZZZ1JZ3W386752';          /* built for Europe: position 9 is not a check digit */

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.route('https://vpic.nhtsa.dot.gov/**', r => {
    const vin = r.request().url().split('/DecodeVinValues/')[1].split('?')[0];
    const known = { [GOOD]: ['2003', 'HONDA', 'Accord'], [TRUCK]: ['2013', 'FORD', 'F-150'], [EURO]: ['2003', 'VOLKSWAGEN', 'Golf'] }[vin];
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ Results: [known ? { ModelYear: known[0], Make: known[1], Model: known[2], ErrorCode: '0' } : { ErrorCode: '1', ErrorText: '1 - Check Digit (9th position) does not calculate properly' }] }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept());
  try {
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload(); await page.waitForTimeout(300);

    /* ---------- the rules, on text ---------- */
    const rules = await page.evaluate(({ GOOD, EURO }) => {
      const c = (t, s) => vinRank(vinCandidatesFromText(t, s || 'text')).map(x => ({ vin: x.vin, ok: x.checkOk, unsure: x.fixed.filter(f => !f.certain).map(f => f.pos + ':' + f.from + '>' + f.to), sure: x.fixed.filter(f => f.certain).length, amb: (x.ambiguous || []).length }));
      return {
        plain: c('VIN ' + GOOD + ' MFD BY HONDA'),
        split: c('VIN 1HGCM 82633 A004352'),
        ioq: c('VIN 1HGCM82633AOO4352'),                 /* two zeros read as letter O */
        conf: c('VIN 1HGCM8263SA004352'),                /* 3 at position 10 fine; S at position 10? no: S in place of 3 at 10th */
        oneBad: c('VIN 1HGCM8Z633A004352'),              /* 2 read as Z at position 7 */
        voted: vinRank(vinVote(vinCandidatesFromText('VIN 1HGCM8Z633A004352', 'text').concat(vinCandidatesFromText('VIN 1HGCM82633A0D4352', 'text')))).map(x => ({ vin: x.vin, ok: x.checkOk, unsure: x.fixed.map(f => f.pos + ':' + f.from + '>' + f.to) })),
        euroText: c('VIN ' + EURO),
        euroBarcode: c(EURO, 'barcode'),
        noise: c('LOT 4411 PART 8765-332 CUSTOMER DANA REYES'),
        tooShort: c('1HGCM82633A00435')
      };
    }, { GOOD, EURO });
    check('1a. a clean VIN in the text is found with its check digit OK', rules.plain[0] && rules.plain[0].vin === GOOD && rules.plain[0].ok && !rules.plain[0].unsure.length, JSON.stringify(rules.plain));
    check('1b. a VIN the reader split into pieces is put back together', rules.split[0] && rules.split[0].vin === GOOD && rules.split[0].ok, JSON.stringify(rules.split));
    check('1c. O read for 0 is corrected (O is never in a VIN) and says so', rules.ioq[0] && rules.ioq[0].vin === GOOD && rules.ioq[0].ok && rules.ioq[0].sure === 2, JSON.stringify(rules.ioq));
    check('1d. one misread character (Z for 2) in a single read is NOT guessed at: it is shown as not checking', rules.oneBad.length && rules.oneBad.every(x => !x.ok) && !rules.oneBad.some(x => x.vin === GOOD), JSON.stringify(rules.oneBad));
    check('1h. two reads that each got one character wrong, in different places: the reading that checks is offered with both characters marked',
      rules.voted.some(x => x.vin === GOOD && x.ok && x.unsure.length === 2), JSON.stringify(rules.voted));
    check('1e. a printed VIN that does not check is not offered as checked', rules.euroText.every(x => !x.ok || x.unsure.length), JSON.stringify(rules.euroText));
    check('1f. a barcode VIN that does not check (Europe) is offered as read, marked', rules.euroBarcode[0] && rules.euroBarcode[0].vin === EURO && !rules.euroBarcode[0].ok, JSON.stringify(rules.euroBarcode));
    check('1g. part numbers and names are never mistaken for a VIN; 16 characters is not a VIN', !rules.noise.length && !rules.tooShort.length, JSON.stringify([rules.noise, rules.tooShort]));

    /* ---------- real photographs through the real readers ---------- */
    const scan = (kind, vin) => page.evaluate(async ({ kind, vin }) => {
      /* Code 39, the barcode on door-jamb labels */
      const C39 = { '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
        A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000', F: '001011000', G: '000001101', H: '100001100', I: '001001100', J: '000011100', K: '100000011', L: '001000011',
        M: '101000010', N: '000010011', O: '100010010', P: '001010010', Q: '000000111', R: '100000110', S: '001000110', T: '000010110', U: '110000001', V: '011000001', W: '111000000',
        X: '010010001', Y: '110010000', Z: '011010000', '*': '010010100' };
      const W = 1800, H = 1100;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      const noise = (n, a) => { for (let i = 0; i < n; i++){ g.fillStyle = 'rgba(0,0,0,' + (Math.random() * a) + ')'; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); } };
      if (kind === 'plate'){
        g.fillStyle = '#1b1f24'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#d8dde3'; g.font = 'bold 92px Consolas, monospace'; g.fillText(vin, 120, 580);
      } else {
        g.fillStyle = '#f4f1e8'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#111'; g.font = '28px Arial'; g.fillText('MFD BY AMERICAN HONDA MOTOR CO INC   06/03', 80, 90);
        g.fillText('GVWR 4050 LB  GAWR FRT 2150 LB  GAWR RR 1900 LB', 80, 140);
        g.fillText('THIS VEHICLE CONFORMS TO ALL APPLICABLE U.S. FEDERAL MOTOR VEHICLE SAFETY STANDARDS', 80, 190);
        if (kind === 'text' || kind === 'label'){ g.font = 'bold 64px Consolas, monospace'; g.fillText(vin, 160, 330); }
        if (kind === 'label' || kind === 'barcode'){
          g.save(); g.translate(150, 420); g.rotate(kind === 'label' ? -0.06 : 0.04);
          const code = '*' + vin + '*'; let x = 0; const n = 4, w = 11;
          for (const ch of code){ const p = C39[ch]; for (let i = 0; i < 9; i++){ const wd = p[i] === '1' ? w : n; if (i % 2 === 0){ g.fillStyle = '#000'; g.fillRect(x, 0, wd, 170); } x += wd; } x += n; }
          g.restore();
        }
        if (kind === 'qr'){
          const qr = qrcode(0, 'M'); qr.addData(vin); qr.make();
          const m = qr.getModuleCount(), cell = 12; g.fillStyle = '#000';
          for (let r = 0; r < m; r++) for (let q = 0; q < m; q++) if (qr.isDark(r, q)) g.fillRect(500 + q * cell, 300 + r * cell, cell, cell);
        }
        noise(20000, 0.35);
      }
      if (kind === 'qr' && !window.qrcode) throw new Error('qrcode.js not loaded');
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      const t0 = performance.now();
      const res = await vinScanImage(new File([blob], 'IMG.jpg', { type: 'image/jpeg' }));
      return { ms: Math.round(performance.now() - t0), top: res.candidates.slice(0, 3).map(x => ({ vin: x.vin, source: x.source, ok: x.checkOk, trust: vinTrust(x).level, unsure: x.fixed.filter(f => !f.certain).length })), notes: res.notes };
    }, { kind, vin });
    await page.evaluate(async () => { const s = document.createElement('script'); s.src = 'vendor/qrcode.js'; document.head.appendChild(s); await new Promise(r => s.onload = r); });

    const bc = await scan('label', GOOD);
    console.log('        barcode label: ' + bc.ms + ' ms');
    check('2a. a tilted, noisy door-jamb label: the barcode gives the VIN, check digit OK, top of the list', bc.top[0] && bc.top[0].vin === GOOD && bc.top[0].source === 'barcode' && bc.top[0].trust === 'high', JSON.stringify(bc));
    const bc2 = await scan('barcode', TRUCK);
    check('2b. a barcode on its own', bc2.top[0] && bc2.top[0].vin === TRUCK && bc2.top[0].trust === 'high', JSON.stringify(bc2));
    const qr = await scan('qr', TRUCK);
    check('2c. a QR code', qr.top[0] && qr.top[0].vin === TRUCK && qr.top[0].source === 'barcode', JSON.stringify(qr));
    const eu = await scan('barcode', EURO);
    check('2d. a barcode whose check digit does not calculate is offered, marked, never as HIGH', eu.top[0] && eu.top[0].vin === EURO && eu.top[0].trust === 'medium', JSON.stringify(eu));
    const tx = await scan('text', GOOD);
    console.log('        printed text: ' + tx.ms + ' ms');
    check('2e. no barcode: the printed VIN is read, check digit OK', tx.top[0] && tx.top[0].vin === GOOD && tx.top[0].source === 'text' && tx.top[0].ok, JSON.stringify(tx));
    const pl = await scan('plate', TRUCK);
    console.log('        windshield-style plate: ' + pl.ms + ' ms');
    check('2f. light characters on a dark plate are read', pl.top[0] && pl.top[0].vin === TRUCK && pl.top[0].ok, JSON.stringify(pl));
    const none = await scan('none', GOOD);
    check('2g. a photo with no VIN in it gives nothing, not a guess', none.top.length === 0 || none.top.every(x => x.trust === 'low'), JSON.stringify(none));

    /* ---------- on screen: shown, decoded, confirmed ---------- */
    await page.evaluate(() => {
      saveCustomer({ id: 'c1', first: 'Dana', last: 'Reyes', phone: '5095550100' });
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '', make: '', model: '', vin: '', mileage: '90000' };
      db.orders.o1 = shapeOrder({ id: 'o1', customerId: 'c1', vehicleId: 'v1', date: '2026-09-24', status: 'In Progress', estimateNo: 5, labor: [], parts: [], extras: [], payments: [], history: [] });
      save(); render();
      vinScanOpen({ purpose: 'vehicle', vehicleId: 'v1' });
    });
    await page.evaluate(v => vinShow({ candidates: vinRank(vinCandidatesFromText('VIN ' + v, 'barcode')), notes: [] }), GOOD);
    const shown = await page.waitForFunction(() => { const d = document.getElementById('vinDec0'); return d && /HONDA/.test(d.textContent) ? d.textContent : null; }, null, { timeout: 5000 }).then(h => h.jsonValue()).catch(() => null);
    check('3a. the result shows the VIN, how it was read, and the vehicle NHTSA says it is', !!shown && /2003 HONDA Accord/.test(shown) &&
      /READ FROM THE BARCODE — CHECK DIGIT OK/.test(await page.textContent('#vinWork')), shown);
    const filledBefore = await page.evaluate(() => db.vehicles.v1.vin);
    check('3b. nothing is filled in until USE THIS VIN is pressed', filledBefore === '');
    await page.$eval('.vincand button', b => b.click());
    const after = await page.evaluate(() => ({ vin: db.vehicles.v1.vin, year: db.vehicles.v1.year, make: db.vehicles.v1.make, audit: db.audit.filter(a => a.action === 'vin-scanned').length, open: document.getElementById('vinOverlay').classList.contains('on') }));
    check('3c. USE THIS VIN records it on the vehicle, fills the blank year and make, and notes it in the history', after.vin === GOOD && after.year === '2003' && /HONDA/.test(after.make) && after.audit === 1 && !after.open, JSON.stringify(after));

    await page.evaluate(() => vinScanOpen({ purpose: 'vehicle', vehicleId: 'v1' }));
    await page.evaluate(v => vinShow({ candidates: vinRank(vinCandidatesFromText('VIN ' + v, 'barcode')), notes: [] }), TRUCK);
    await page.waitForTimeout(300);
    const dialogs = [];
    page.removeAllListeners('dialog'); page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await page.$eval('.vincand button', b => b.click());
    const kept = await page.evaluate(() => db.vehicles.v1.vin);
    check('3d. a scan that differs from the VIN on record asks before replacing it, and No keeps the old one', kept === GOOD && dialogs.some(m => /on record with VIN 1HGCM82633A004352/.test(m)), JSON.stringify(dialogs));
    page.removeAllListeners('dialog'); page.on('dialog', d => d.accept());
    await page.evaluate(() => closeVin());

    /* a new vehicle scanned on the phone, and one already in the book */
    const before = await page.evaluate(() => [Object.keys(db.vehicles).length, Object.keys(db.orders).length]);
    await page.evaluate(() => vinScanOpen({ purpose: 'new' }));
    await page.evaluate(v => vinShow({ candidates: vinRank(vinCandidatesFromText(v, 'barcode')), notes: [] }), TRUCK);
    await page.waitForTimeout(300);
    await page.$eval('.vincand button', b => b.click());
    const made = await page.evaluate(() => { const v = Object.values(db.vehicles).find(x => x.vin === '1FTFW1ET9DFC10312'); const o = v && Object.values(db.orders).find(x => x.vehicleId === v.id); return { v: !!v, make: v && v.make, o: o && ticketNo(o), status: o && o.status, counts: [Object.keys(db.vehicles).length, Object.keys(db.orders).length] }; });
    check('3e. a new VIN makes the vehicle (decoded) and an estimate, so it shows up on every device', made.v && /FORD/.test(made.make) && /^EST-/.test(made.o) && made.counts[0] === before[0] + 1 && made.counts[1] === before[1] + 1, JSON.stringify(made));
    await page.evaluate(() => vinScanOpen({ purpose: 'new' }));
    await page.evaluate(v => vinShow({ candidates: vinRank(vinCandidatesFromText(v, 'barcode')), notes: [] }), GOOD);
    await page.waitForTimeout(300);
    await page.$eval('.vincand button', b => b.click());
    const dupe = await page.evaluate(() => [Object.keys(db.vehicles).length, Object.values(db.vehicles).filter(v => v.vin === '1HGCM82633A004352').length]);
    check('3f. scanning a VIN already in the book finds that vehicle instead of making a second one', dupe[0] === before[0] + 1 && dupe[1] === 1, JSON.stringify(dupe));

    /* the phone's home and the inspection fit the phone */
    await page.evaluate(() => { document.body.classList.add('phone'); go('phone'); });
    const fit = await page.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth, cards: document.querySelectorAll('.phonecard').length }));
    check('4a. the phone\'s home lists the open tickets and nothing runs off the side', fit.cards >= 2 && fit.sw <= fit.w, JSON.stringify(fit));
    await page.evaluate(() => { newInspection('o1', 'v1'); save(); openInspection('o1'); });
    const insp = await page.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth, card: getComputedStyle(document.querySelector('table.imatrix tr')).display, label: getComputedStyle(document.querySelector('table.imatrix td[data-label]'), '::before').content }));
    check('4b. on a phone each wheel is a card with its fields labelled, and nothing runs off the side', insp.card === 'block' && /Tread/.test(insp.label) && insp.sw <= insp.w, JSON.stringify(insp));

    check('5. no script errors', errs.length === 0, errs.join(' | '));
  } catch (e){
    failures.push('the run stopped: ' + (e && e.stack || e));
    console.log(' FAIL   the run stopped: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL VIN SCANNER CHECKS PASSED');
  process.exit(0);
})();
