/* Before an inspection (2.9.3): the shop's rule that no inspection starts
   until the ticket has the customer (a name, and a phone or an email), the
   vehicle (year, make, model) and the reason it came in.

   Checked on a computer screen and on a phone-sized screen: a ticket missing
   any of these asks for exactly them and does not start; an existing customer
   can be picked by searching; a new one is created; the reason goes on the
   ticket; an inspection already started always opens. */
const { chromium, devices } = require('playwright');

const APP = 'file://' + process.cwd().split(String.fromCharCode(92)).join('/') + '/index.html';
const failures = [];
function check(name, cond, detail){
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 700)));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}

(async () => {
  const browser = await chromium.launch();
  for (const [label, opts] of [['computer', { viewport: { width: 1400, height: 950 } }], ['phone', { ...devices['iPhone 13'] }]]){
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    let dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    const P = label === 'phone' ? 'P' : 'C';
    try {
      await page.goto(APP); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(300);
      await page.evaluate(() => {
        saveCustomer({ id: 'c1', first: 'Dana', last: 'Reyes', phone: '5095550100' });
        db.vehicles.v1 = { id: 'v1', customerId: '', year: '', make: '', model: '', vin: '', mileage: '' };
        db.orders.o1 = shapeOrder({ id: 'o1', customerId: '', vehicleId: 'v1', date: '2026-09-28', status: 'Estimate', complaint: '', labor: [], parts: [], extras: [], payments: [], history: [] });
        /* a ticket with everything */
        saveCustomer({ id: 'c2', first: 'Sam', last: 'Ortiz', email: 'sam@example.com' });
        db.vehicles.v2 = { id: 'v2', customerId: 'c2', year: '2003', make: 'BMW', model: '325xi', vin: '', mileage: '181000' };
        db.orders.o2 = shapeOrder({ id: 'o2', customerId: 'c2', vehicleId: 'v2', date: '2026-09-28', status: 'Estimate', complaint: 'Check engine light, secondary air', labor: [], parts: [], extras: [], payments: [], history: [] });
        save();
      });

      /* ---------- 1. a bare ticket ---------- */
      const miss = await page.evaluate(() => intakeMissing(db.orders.o1));
      check(P + '1a. a ticket with no customer, no year/make/model and no reason is missing all three', miss.join() === 'customer,vehicle,reason', miss.join());
      await page.evaluate(() => openInspection('o1'));
      const shown = await page.evaluate(() => ({ sheet: document.getElementById('recOverlay').classList.contains('on') && /Before the inspection/.test(document.getElementById('recSheet').textContent),
        insp: Object.keys(db.inspections).length, view }));
      check(P + '1b. Start inspection asks for them first, and no inspection is made yet', shown.sheet && shown.insp === 0 && shown.view !== 'insp', JSON.stringify(shown));
      await page.$eval('#ik_reason', el => el.value = 'Check engine light');
      await page.evaluate(() => window.__ikGo());
      const said = await page.textContent('#ik_msg');
      check(P + '1c. pressing SAVE AND START with things missing says exactly what is still needed, and starts nothing',
        /customer's name/.test(said) && /phone number or email/.test(said) && /year, make and model/.test(said) && !/why/.test(said) && await page.evaluate(() => Object.keys(db.inspections).length === 0), said);

      /* ---------- 2. pick the customer by searching ---------- */
      await page.fill('#ik_q', '555010');
      const picks = await page.$$eval('.intakepick', els => els.map(e => e.textContent));
      check(P + '2a. searching by part of the phone number finds the customer', picks.length === 1 && /Dana Reyes/.test(picks[0]), JSON.stringify(picks));
      await page.$eval('.intakepick', b => b.click());
      const kept = await page.$eval('#ik_reason', el => el.value);
      check(P + '2b. picking them fills in their phone, and keeps what was already typed', /Dana Reyes/.test(await page.textContent('.intakechosen')) &&
        (await page.$eval('#ik_phone', el => el.value)) === '5095550100' && kept === 'Check engine light', kept);
      await page.fill('#ik_year', '2003'); await page.fill('#ik_make', 'BMW'); await page.fill('#ik_model', '325xi'); await page.fill('#ik_miles', '181000');
      await page.evaluate(() => window.__ikGo());
      const after = await page.evaluate(() => ({ view, insp: Object.values(db.inspections).map(i => i.orderId), o: db.orders.o1, v: db.vehicles.v1 }));
      check(P + '2c. with it all in, the inspection starts, and the ticket has the customer, the reason and the mileage',
        after.view === 'insp' && after.insp.join() === 'o1' && after.o.customerId === 'c1' && after.o.complaint === 'Check engine light' && after.o.mileageIn === '181000', JSON.stringify(after.o).slice(0, 300));
      check(P + '2d. and the vehicle has its year, make, model and owner', after.v.year === '2003' && after.v.make === 'BMW' && after.v.model === '325xi' && after.v.customerId === 'c1', JSON.stringify(after.v));

      /* ---------- 3. a new customer, and a customer with no way to reach them ---------- */
      await page.evaluate(() => {
        db.vehicles.v3 = { id: 'v3', customerId: '', year: '2011', make: 'Ford', model: 'F-150', vin: '', mileage: '' };
        db.orders.o3 = shapeOrder({ id: 'o3', customerId: '', vehicleId: 'v3', date: '2026-09-28', status: 'Estimate', complaint: 'Brakes grinding', labor: [], parts: [], extras: [], payments: [], history: [] });
        save(); go('orders'); openInspection('o3');
      });
      await page.fill('#ik_first', 'Lee'); await page.fill('#ik_last', 'Park');
      await page.evaluate(() => window.__ikGo());
      const noContact = await page.textContent('#ik_msg');
      check(P + '3a. a name alone is not enough: it asks for a phone or email', /phone number or email/.test(noContact) && !/year/.test(noContact), noContact);
      await page.fill('#ik_phone', '509 555 0199');
      await page.evaluate(() => window.__ikGo());
      const lee = await page.evaluate(() => { const o = db.orders.o3; const c = db.customers[o.customerId]; return { view, name: c && customerName(c), phone: c && c.phone, insp: !!inspectionFor(o) }; });
      check(P + '3b. the new customer is added to the book with the phone, and the inspection starts', lee.view === 'insp' && lee.name === 'Lee Park' && lee.phone === '509 555 0199' && lee.insp, JSON.stringify(lee));

      /* ---------- 4. a complete ticket, and an inspection already started ---------- */
      await page.evaluate(() => { go('orders'); openInspection('o2'); });
      check(P + '4a. a ticket that already has everything starts the inspection straight away', await page.evaluate(() => view === 'insp' && !!inspectionFor(db.orders.o2) && !document.getElementById('recOverlay').classList.contains('on')));
      await page.evaluate(() => { db.orders.o2.complaint = ''; save(); go('orders'); openInspection('o2'); });
      check(P + '4b. an inspection already started always opens, even if the ticket has since lost something', await page.evaluate(() => view === 'insp' && !document.getElementById('recOverlay').classList.contains('on')));
      check(P + '5. no script errors', !errs.length, errs.join(' | '));
    } catch (e){
      failures.push(P + ' the run stopped: ' + (e && e.stack || e));
      console.log(' FAIL   ' + P + ' the run stopped: ' + (e && e.stack || e));
    }
    await ctx.close();
  }
  await browser.close();
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL INSPECTION CHECK-IN CHECKS PASSED');
  process.exit(0);
})();
