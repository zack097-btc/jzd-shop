/* A ticket's photographs (2.9.3), after the first real job: four photos taken
   on the phone showed as "4" but could not be found, and four more taken in
   the inspection were not tied to the ticket at all.

   Checked: a photo taken in the inspection carries its ticket and vehicle; an
   older inspection photo without them is still found through its
   inspection; the ticket on the desktop shows every photo, labelled with what
   it is of; the phone's PHOTOS count and PHOTOS screen show the same photos;
   the PHOTOS screen shows a new photo as soon as it is taken. */
const { chromium, devices } = require('playwright');

const APP = 'file://' + process.cwd().split(String.fromCharCode(92)).join('/') + '/index.html';
const failures = [];
function check(name, cond, detail){
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 700)));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept());
  const jpeg = async color => Buffer.from(await page.evaluate(async c => {
    const cv = document.createElement('canvas'); cv.width = 400; cv.height = 300; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 400, 300);
    return cv.toDataURL('image/jpeg', 0.8).split(',')[1];
  }, color), 'base64');
  const take = async (color, name) => {
    await page.setInputFiles('#attInput', { name: name || 'image.jpg', mimeType: 'image/jpeg', buffer: await jpeg(color) });
    await page.waitForTimeout(400);
  };
  try {
    await page.goto(APP); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(300);
    await page.evaluate(() => {
      saveCustomer({ id: 'c1', first: 'Sam', last: 'Ortiz', phone: '5095550111' });
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2003', make: 'BMW', model: '325xi', vin: '', mileage: '181000' };
      db.orders.o1 = shapeOrder({ id: 'o1', customerId: 'c1', vehicleId: 'v1', date: '2026-09-28', status: 'In Progress', complaint: 'Check engine light', labor: [], parts: [], extras: [], payments: [], history: [] });
      db.orders.o9 = shapeOrder({ id: 'o9', customerId: 'c1', vehicleId: 'v1', date: '2026-09-20', status: 'Estimate', complaint: 'Another ticket', labor: [], parts: [], extras: [], payments: [], history: [] });
      save(); openInspection('o1');
    });
    const inspId = await page.evaluate(() => inspId);
    const key = await page.evaluate(() => { const i = db.inspections[inspId]; const g = i.template.groups.find(g => /wheel/i.test(g.id)) || i.template.groups[0]; const it = g.items[0]; return g.id + '.' + it.id + '.RR'; });

    /* ---------- 1. a photo in the inspection, with another ticket open in the editor ---------- */
    await page.evaluate(() => { cur = JSON.parse(JSON.stringify(db.orders.o9)); });   /* a stale open ticket must not capture it */
    await page.evaluate(k => pickPhotos('insp', inspId + '|' + k), key);
    await take('#c33', 'image.jpg');
    const a1 = await page.evaluate(() => Object.values(db.attachments).find(a => a.ctx === 'insp'));
    check('1. a photo taken in the inspection belongs to that inspection\'s ticket and vehicle (not whatever ticket was open)', a1 && a1.orderId === 'o1' && a1.vehicleId === 'v1', JSON.stringify(a1 && { o: a1.orderId, v: a1.vehicleId }));
    await page.evaluate(() => { cur = null; });

    /* ---------- 2. an older inspection photo, saved without its ticket ---------- */
    await page.evaluate(k => {
      db.attachments['att-old-1'] = { id: 'att-old-1', name: 'image.jpg', file: 'att-old-1.jpg', mime: 'image/jpeg', ctx: 'insp', ctxId: inspId + '|' + k.replace('.RR', '.LF'), orderId: '', vehicleId: '', at: '2026-09-28T22:08:06Z', thumb: '' };
      db.attachments['att-veh-1'] = { id: 'att-veh-1', name: 'image.jpg', file: 'att-veh-1.jpg', mime: 'image/jpeg', ctx: 'vehicle', ctxId: 'v1', orderId: 'o1', vehicleId: 'v1', at: '2026-09-28T22:04:46Z', thumb: '' };
      save();
    }, key);
    const all = await page.evaluate(() => attsForOrder(db.orders.o1).map(a => [a.id, attWhat(a)]));
    check('2a. every photo of the ticket is found: the vehicle photo, the new inspection photo, and the older one saved without its ticket', all.length === 3, JSON.stringify(all));
    check('2b. each says what it is of — the inspection ones name the item and the wheel', all.filter(x => /^Inspection: .+ (RR|LF)$/.test(x[1])).length === 2 && all.some(x => x[1] === 'Vehicle'), JSON.stringify(all));

    /* ---------- 3. the desktop ticket shows them ---------- */
    const onTicket = await page.evaluate(() => { editOrder('o1'); const t = document.getElementById('woSheet').innerText; const n = document.querySelectorAll('#woSheet .photogroup .thumb').length; closeWO(); return { t, n }; });
    check('3. the ticket has a Photos section with all 3, grouped by what they are of', onTicket.n === 3 && /3 on this ticket/.test(onTicket.t) && /Inspection: /.test(onTicket.t), onTicket.n + ' ' + onTicket.t.slice(Math.max(0, onTicket.t.indexOf('on this ticket') - 80), onTicket.t.indexOf('on this ticket') + 300));

    /* ---------- 4. the phone: the count and the screen agree, and a new photo shows at once ---------- */
    await page.evaluate(() => { document.body.classList.add('phone'); go('phone'); });
    const count = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[data-order="o1"] button')).find(x => /PHOTOS/.test(x.textContent)); return b && b.textContent; });
    await page.evaluate(() => phonePhotos('o1'));
    const sheet = await page.evaluate(() => ({ thumbs: document.querySelectorAll('#recSheet .thumb').length, text: document.getElementById('recSheet').innerText }));
    check('4a. PHOTOS says 3, and the PHOTOS screen shows those 3 (the inspection ones labelled)', /PHOTOS\s*3/.test(count) && sheet.thumbs === 3 && /Inspection: /.test(sheet.text), JSON.stringify([count, sheet.thumbs]));
    await page.evaluate(() => pickPhotos('vehicle', 'v1', { orderId: 'o1' }));
    await take('#3c3', 'image.jpg');
    const after = await page.evaluate(() => ({ open: document.getElementById('recOverlay').classList.contains('on'), thumbs: document.querySelectorAll('#recSheet .thumb').length,
      count: (Array.from(document.querySelectorAll('[data-order="o1"] button')).find(x => /PHOTOS/.test(x.textContent)) || {}).textContent }));
    check('4b. a photo taken from the PHOTOS screen appears on it straight away, and the count goes to 4', after.open && after.thumbs === 4 && /PHOTOS\s*4/.test(after.count), JSON.stringify(after));
    check('5. no script errors', !errs.length, errs.join(' | '));
  } catch (e){
    failures.push('the run stopped: ' + (e && e.stack || e));
    console.log(' FAIL   the run stopped: ' + (e && e.stack || e));
  } finally { await browser.close(); }
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL TICKET PHOTO CHECKS PASSED');
  process.exit(0);
})();
