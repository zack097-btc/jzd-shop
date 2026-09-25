/* Parts that come with each job (2.9.1).

   What matters: adding a job brings its typical parts onto the ticket with NO
   price and no part number; nothing unpriced ever reaches a customer as $0.00
   or gets invoiced; a package's included oil and filter stay included; the
   shop can change a job's list; removing a job offers to remove its parts. */
const { chromium } = require('playwright');
const fs = require('fs');

const APP = 'file://' + process.cwd().split(String.fromCharCode(92)).join('/') + '/index.html';
const failures = [];
function check(name, cond, detail){
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 700)));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  let dialogs = []; let answer = true;
  page.on('dialog', d => { dialogs.push(d.message()); if (d.type() === 'confirm') (answer ? d.accept() : d.dismiss()); else if (d.type() === 'prompt') d.dismiss(); else d.accept(); });
  try {
    await page.goto(APP); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(300);

    /* ---------- the data ---------- */
    const data = await page.evaluate(() => {
      const ids = Object.keys(SEED_JOB_PARTS);
      const rows = ids.flatMap(k => SEED_JOB_PARTS[k]);
      return { jobs: SEED.length, withParts: ids.length, unknown: ids.filter(k => !SEED_BY_ID[k]), lines: rows.length,
        bad: rows.filter(r => !r[0] || !(r[1] > 0) || ['part', 'fluid'].indexOf(r[3]) < 0).length,
        priced: rows.filter(r => /\$|\d+\.\d\d/.test(r[0] + ' ' + (r[4] || ''))).length,
        brakes: SEED_JOB_PARTS['GEN-BRK-002'].map(r => r[0]), diag: jobPartsFor('GEN-DIAG-001').length };
    });
    check('1a. every job with parts is a real job; 200+ jobs carry their typical parts', data.withParts >= 200 && !data.unknown.length && data.lines > 400, JSON.stringify(data).slice(0, 300));
    check('1b. every part has a name, a quantity and a kind, and no price or dollar figure anywhere', data.bad === 0 && data.priced === 0, JSON.stringify(data));
    check('1c. brakes (pads + rotors) bring pads, two rotors and hardware; a diagnosis brings none', data.brakes.indexOf('Brake pad set') >= 0 && data.brakes.indexOf('Brake rotor') >= 0 &&
      data.brakes.some(n => /hardware/.test(n)) && data.diag === 0, JSON.stringify(data.brakes));

    /* ---------- adding a job ---------- */
    const added = await page.evaluate(() => {
      saveCustomer({ id: 'c1', first: 'Dana', last: 'Reyes', phone: '5095550100' });
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2019', make: 'Honda', model: 'Accord', vin: '', mileage: '64000' };
      save();
      editOrder(null, { customerId: 'c1', vehicleId: 'v1' });
      addJob('GEN-BRK-002');
      const l = cur.labor[cur.labor.length - 1];
      const t = orderTotals(cur);
      return { labor: cur.labor.length, parts: cur.parts.map(p => ({ desc: p.desc, qty: p.qty, price: p.price, partNo: p.partNo, seed: p.seedPart, job: p.jobLine === l.id })),
        partsTotal: t.parts, unpriced: unpricedParts(cur).length, banner: $('#partsWrap') ? $('#partsWrap').innerText : '', rows: document.getElementById('partsRows').innerText };
    });
    check('2a. adding the job brings its parts onto the ticket, tied to that job, with no price and no part number', added.parts.length === 6 &&
      added.parts.every(p => p.price === '' && p.partNo === '' && p.seed && p.job) && added.parts.some(p => p.desc === 'Brake rotor' && p.qty === '2'), JSON.stringify(added.parts));
    check('2b. the ticket says the parts are not priced yet, and the total does not pretend they are free', added.unpriced === 6 && added.partsTotal === 0 &&
      /6 PARTS NOT PRICED YET/.test(added.banner) && /PRICE NEEDED/.test(added.rows) && /SHOP SEED — VERIFY FITMENT/.test(added.rows), added.banner);

    /* the customer's estimate */
    const est = await page.evaluate(() => { saveOrder(); const o = Object.values(db.orders)[0]; editOrder(o.id); return docEstimate(cur); });
    const est6 = (est.match(/<i>price to follow<\/i><\/td>/g) || []).length; check('3a. the printed estimate says "price to follow" for each unpriced part, never $0.00', est6 === 6 &&
      /does not yet include 6 parts/.test(est), est6 + ' | ' + est.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(400, 1300));

    /* ---------- no invoice with an unpriced part ---------- */
    dialogs = [];
    const blocked = await page.evaluate(() => {
      const before = cur.status;
      changeStatus('Invoiced');
      const a = canonStatus(cur.status);
      printDoc('Invoice');
      const b = canonStatus(cur.status);
      closePaid();
      const c = canonStatus(cur.status);
      return { before, a, b, c, inv: cur.invoiceNo || null };
    });
    check('4a. it cannot be invoiced, printed as an invoice or closed as paid while a part has no price — and it says which', blocked.a === 'Estimate' && blocked.b === 'Estimate' && blocked.c === 'Estimate' &&
      !blocked.inv && dialogs.length >= 3 && /Brake rotor/.test(dialogs[0]) && /0 if it is free/.test(dialogs[0]), JSON.stringify([blocked, dialogs[0]]));

    /* price what was used, remove what was not */
    const priced = await page.evaluate(() => {
      cur.parts.forEach(p => {
        if (/sensor|cleaner|grease/i.test(p.desc)) return;
        p.partNo = 'X-' + p.desc.length; p.price = p.desc === 'Brake rotor' ? '64.50' : '42.00';
      });
      cur.parts = cur.parts.filter(p => !/sensor|cleaner|grease/i.test(p.desc));
      renderLines(); updateTotals();
      const t = orderTotals(cur);
      changeStatus('Invoiced');
      return { status: canonStatus(cur.status), inv: cur.invoiceNo, parts: t.parts, banner: $('#partsWrap').innerText };
    });
    check('4b. once every part used has a price and the rest are removed, it invoices', priced.status === 'Invoiced' && !!priced.inv && priced.parts === 42 + 129 + 42 &&
      !/NOT PRICED/.test(priced.banner), JSON.stringify(priced));

    /* ---------- a package: the oil is included ---------- */
    const pkg = await page.evaluate(() => {
      closeWO(); editOrder(null, { customerId: 'c1', vehicleId: 'v1' });
      addJob('MENU-LOF-002');
      const t = orderTotals(cur);
      return { parts: cur.parts.map(p => [p.desc, p.included, p.price, partState(p)]), unpriced: unpricedParts(cur).length, total: t.subtotal, labor: t.labor,
        banner: $('#partsWrap').innerText, rows: document.getElementById('partsRows').innerText };
    });
    check('5a. an oil-change package lists its oil and filter as INCLUDED, off the shelf, not waiting and not unpriced', pkg.parts.length === 3 && pkg.parts.every(p => p[1] && p[2] === '0' && p[3] === 'Received') &&
      pkg.unpriced === 0 && !/WAITING ON PARTS|NOT PRICED/.test(pkg.banner) && /INCLUDED IN THE JOB'S PRICE/.test(pkg.rows), JSON.stringify(pkg).slice(0, 500));
    check('5b. and the package costs what the menu says, no more', pkg.total === pkg.labor && pkg.total === 105, JSON.stringify([pkg.total, pkg.labor]));

    /* ---------- removing a job ---------- */
    answer = true; dialogs = [];
    const removed = await page.evaluate(() => {
      addJob('GEN-SUS-011');                   /* CV axle: axle, nut, fluid */
      const cv = cur.labor.length - 1;
      const cvParts = cur.parts.filter(p => p.jobLine === cur.labor[cv].id);
      cvParts[0].price = '189.00'; cvParts[0].procurement = 'Ordered';   /* the axle is on order */
      delLine('labor', cv);
      return { left: cur.parts.filter(p => cvParts.indexOf(p) >= 0).map(p => p.desc), total: cur.parts.length };
    });
    check('6. removing a job offers to remove its parts, and keeps any part already priced or on order', dialogs.some(m => /Also remove the 2 parts/.test(m)) &&
      removed.left.join() === 'CV axle assembly', JSON.stringify([removed, dialogs]));

    /* ---------- the shop's own list ---------- */
    const own = await page.evaluate(() => {
      go('services'); editJobParts('GEN-MAINT-003');
      window.__jpAdd();
      const inputs = document.querySelectorAll('#recSheet [data-jp="1"]');
      inputs[0].value = 'Air filter pre-cleaner'; inputs[0].dispatchEvent(new Event('input'));
      inputs[1].value = '1'; inputs[1].dispatchEvent(new Event('input'));
      window.__jpSave();
      const list = jobPartsFor('GEN-MAINT-003').map(r => r[0]);
      closeWO(); editOrder(null, { customerId: 'c1', vehicleId: 'v1' }); addJob('GEN-MAINT-003');
      const onTicket = cur.parts.map(p => p.desc);
      closeWO(); go('services'); editJobParts('GEN-MAINT-003'); window.__jpReset();
      return { list, onTicket, after: jobPartsFor('GEN-MAINT-003').map(r => r[0]), audit: db.audit.filter(a => a.action === 'job-parts').length };
    });
    check('7. the shop can change a job\'s parts; the next ticket uses it; Reset goes back to the seed', own.list.join() === 'Engine air filter,Air filter pre-cleaner' &&
      own.onTicket.join() === own.list.join() && own.after.join() === 'Engine air filter' && own.audit === 1, JSON.stringify(own));

    /* ---------- an older book ---------- */
    const old = await page.evaluate(() => { const b = JSON.parse(JSON.stringify(db)); delete b.catalog.jobParts; const d = shapeDb(b); return jobPartsFor('GEN-BRK-001').length > 0 && !d.catalog.jobParts; });
    check('8. a book from before 2.9.1 opens with the seed lists and no shop lists', old);
    check('9. no script errors', errs.length === 0, errs.join(' | '));
  } catch (e){
    failures.push('the run stopped: ' + (e && e.stack || e));
    console.log(' FAIL   the run stopped: ' + (e && e.stack || e));
  } finally { await browser.close(); }
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL JOB PARTS CHECKS PASSED');
  process.exit(0);
})();
