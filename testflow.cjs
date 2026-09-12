/* Estimate to paid invoice.

   These checks guard the part of the program that touches money and promises.
   A wrong labor time is embarrassing; a quote that silently grows past what the
   customer agreed to, an invoice that changes its own total after it was
   printed, or a balance that says zero when it is not, are the mistakes that
   end a customer relationship or lose an argument the shop should have won.

   Two of them matter more than the rest and are checked hardest: a finalized
   invoice must be immovable against every later settings change, and work added
   after an approval must announce itself rather than ride along on the old yes.

   The network is never touched. */
const { chromium } = require('playwright');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const LS_KEY = 'jzd.shop.db';

/* A book exactly as v2.2.0 wrote one: no extras, no payments, no auth, no
   tax-on-parts setting, and the old status spellings. */
const LEGACY_BOOK = {
  settings: {
    shopName: 'JZD Inc.', tagline: 'Automotive Service & Repair', addr: '', phone: '', email: '',
    laborRate: 120, rateMin: 100, rateMax: 125, taxRate: 8.25, taxLabor: false,
    nextInvoice: 1044, terms: 'Thank you.', requireOverrideReason: true, managerPin: '',
    providers: { vehicle: 'nhtsa', labor: 'seed', motor: { enabled: false }, mitchell: { enabled: false }, alldata: { enabled: false } }
  },
  customers: { cOld: { id: 'cOld', name: 'Prior Customer', phone: '555-0199' } },
  vehicles: { vOld: { id: 'vOld', customerId: 'cOld', year: '2015', make: 'Ford', model: 'F-150', vin: '' } },
  orders: {
    oOld: {
      id: 'oOld', invoiceNo: 1043, customerId: 'cOld', vehicleId: 'vOld', date: '2026-09-01',
      status: 'InProgress', complaint: 'Brake noise', mileageIn: '81000', mileageOut: '',
      labor: [{ desc: 'Front brakes', hours: '2', rate: 120 }],
      parts: [{ desc: 'Brake pads', qty: '1', price: '90' }],
      notes: 'old ticket'
    },
    oPaid: {
      id: 'oPaid', invoiceNo: 1042, customerId: 'cOld', vehicleId: 'vOld', date: '2026-08-20',
      status: 'Paid', complaint: 'LOF', labor: [{ desc: 'Oil change', hours: '0.5', rate: 120 }],
      parts: [{ desc: 'Filter', qty: '1', price: '14.50' }], notes: ''
    }
  },
  catalog: { labor: {}, parts: {}, overrides: {}, disabled: {} },
  vinCache: {}, audit: []
};

const results = {};
const failures = [];
function check(name, cond, detail) {
  results[name] = cond ? 'PASS' : ('FAIL' + (detail ? ' — ' + detail : ''));
  if (!cond) failures.push(name + (detail ? ': ' + detail : ''));
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const r2 = n => Math.round(Number(n) * 100) / 100;   /* the page has its own; this is for the assertions here */

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('PAGEERR: ' + e.message));
  page.on('dialog', d => d.accept());

  /* ---- 1. a book written by the previous version opens, intact ---- */
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(([k, b]) => localStorage.setItem(k, JSON.stringify(b)), [LS_KEY, LEGACY_BOOK]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);

  results.legacyOpen = await page.evaluate(() => {
    const o = db.orders.oOld, paid = db.orders.oPaid;
    const t = orderTotals(o);
    return {
      locked: !!window.storageLocked,
      customers: Object.keys(db.customers).length, orders: Object.keys(db.orders).length,
      rateKept: db.settings.laborRate,                 /* their rate, not the new default */
      nextInvoiceKept: db.settings.nextInvoice,
      oldStatusReadable: canonStatus(o.status), paidStatusReadable: canonStatus(paid.status),
      /* 2 hr x $120 + $90 part, parts taxable at 8.25% */
      labor: t.labor, parts: t.parts, tax: t.tax, total: t.total,
      newFieldsDefaulted: { taxParts: db.settings.taxParts, markup: db.settings.partsMarkup, fees: Array.isArray(db.settings.fees) }
    };
  });
  const L = results.legacyOpen;
  check('1. a v2.2.0 book opens with its data and its prices unchanged',
    !L.locked && L.customers === 1 && L.orders === 2 && L.rateKept === 120 && L.nextInvoiceKept === 1044 &&
    L.oldStatusReadable === 'In Progress' && L.paidStatusReadable === 'Paid / Closed' &&
    near(L.labor, 240) && near(L.parts, 90) && near(L.tax, 7.43) && near(L.total, 337.43) &&
    L.newFieldsDefaulted.taxParts === true && L.newFieldsDefaulted.fees,
    JSON.stringify(L));

  /* ---- 2,3,4. a VIN-decoded vehicle, a catalog job, a menu job ---- */
  results.build = await page.evaluate(() => {
    db.settings.laborRate = 112.50;
    db.vinCache['WBS8M9C55J5J78069'] = { vin: 'WBS8M9C55J5J78069', year: '2018', make: 'BMW', model: 'M3',
      series: '3-Series', cylinders: '6', displacementL: '3', fuelType: 'Gasoline',
      provider: 'NHTSA vPIC', decodedAt: new Date().toISOString(), raw: {}, warnings: [] };
    db.customers.c1 = { id: 'c1', name: 'Field Test', phone: '555-0100' };
    db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2018', make: 'BMW', model: 'M3', vin: 'WBS8M9C55J5J78069' };

    editOrder(null, { customerId: 'c1', vehicleId: 'v1' });
    const p = vehicleProfile(db.vehicles.v1);
    const hourly = searchCatalog(p, '').find(h => h.row.bill === 'H' && h.row.hrs >= 1).row;
    const menu = SEED_BY_ID['MENU-TIRE-001'];
    addJob(hourly.id);
    addJob(menu.id);
    const t1 = orderTotals(cur);

    db.settings.laborRate = 125;
    const t2 = orderTotals(cur);
    db.settings.laborRate = 112.50;

    return { m3: p.m3 && p.m3.key, hourlyId: hourly.id, hourlyHours: hourly.hrs, menuPrice: menu.fix,
             laborAt112: t1.labor, laborAt125: t2.labor,
             menuLine: lineAmount(cur.labor.find(l => l.bill === 'F'), cur),
             menuLineAt125: (() => { db.settings.laborRate = 125; const v = lineAmount(cur.labor.find(l => l.bill === 'F'), cur); db.settings.laborRate = 112.50; return v; })() };
  });
  const B = results.build;
  check('2. a VIN-identified vehicle starts an estimate with jobs matched to it', B.m3 === 'F80', JSON.stringify(B));
  check('3. a catalog labor line prices at hours x the shop rate',
    near(B.laborAt112, B.hourlyHours * 112.5 + B.menuPrice) && near(B.laborAt125, B.hourlyHours * 125 + B.menuPrice), JSON.stringify(B));
  check('4. a menu-priced service does not move when the labor rate does',
    near(B.menuLine, B.menuPrice) && near(B.menuLineAt125, B.menuPrice), JSON.stringify(B));

  /* ---- 5,6,7. parts: cost, markup, price, quantity ---- */
  results.parts = await page.evaluate(() => {
    db.settings.partsMarkup = 40;
    addLine('parts');
    const i = cur.parts.length - 1, x = cur.parts[i];
    x.desc = 'Brake pads'; x.qty = '2'; x.cost = '50';
    x.price = suggestedPrice(x.cost, db.settings.partsMarkup);
    const one = { cost: partCost(x), sell: partSelling(x), unit: x.price };
    x.qty = '4';
    const four = { cost: partCost(x), sell: partSelling(x) };
    /* a price typed by hand must not disturb what the part cost */
    x.price = '62'; x.priceEdited = true;
    const edited = { cost: partCost(x), sell: partSelling(x), costField: x.cost };
    return { one, four, edited, suggested: suggestedPrice(50, 40) };
  });
  const P = results.parts;
  check('5. extended part cost is quantity x unit cost', near(P.one.cost, 100) && near(P.four.cost, 200), JSON.stringify(P));
  check('6. selling price comes from cost and markup, and survives being typed over',
    near(P.suggested, 70) && near(P.one.unit, 70) && near(P.one.sell, 140) &&
    near(P.edited.sell, 248) && near(P.edited.costField, 50), JSON.stringify(P));
  check('7. changing quantity recalculates the line and the ticket',
    near(P.four.sell, 280) && near(P.four.cost, 200), JSON.stringify(P));

  /* ---- 8,9. discounts and tax ---- */
  results.money = await page.evaluate(() => {
    db.settings.taxRate = 10; db.settings.taxLabor = false; db.settings.taxParts = true; db.settings.taxFees = false;
    cur.extras = [];
    const before = orderTotals(cur);

    cur.extras.push({ id: 'd1', type: 'discount', desc: 'Repeat customer', mode: 'amount', value: 25 });
    const flat = orderTotals(cur);
    cur.extras[0] = { id: 'd1', type: 'discount', desc: '10% off', mode: 'percent', value: 10 };
    const pct = orderTotals(cur);
    cur.extras = [];

    const noTax = orderTotals(cur);
    db.settings.taxLabor = true;
    const withLaborTax = orderTotals(cur);
    db.settings.taxLabor = false;
    db.settings.taxRate = 8.25;
    const at825 = orderTotals(cur);
    return { before: {labor:before.labor, parts:before.parts, sub:before.subtotal, tax:before.tax},
             flat: {sub:flat.subtotal, disc:flat.discounts, tax:flat.tax, total:flat.total},
             pct: {sub:pct.subtotal, disc:pct.discounts},
             pre: r2(before.labor + before.parts),
             noTax: {taxable:noTax.taxable, tax:noTax.tax},
             withLaborTax: {taxable:withLaborTax.taxable, tax:withLaborTax.tax},
             at825: {tax:at825.tax} };
  });
  const M = results.money;
  check('8. a discount comes off the subtotal, flat or as a percentage',
    near(M.flat.disc, -25) && near(M.flat.sub, M.before.sub - 25) &&
    near(M.pct.disc, -r2(M.pre * 0.10)) && near(M.pct.sub, M.before.sub - r2(M.pre * 0.10)),
    JSON.stringify(M));
  check('9. tax follows the settings and is taken only on what is taxable',
    near(M.noTax.taxable, M.before.parts) && near(M.noTax.tax, r2(M.before.parts * 0.10)) &&
    near(M.withLaborTax.taxable, r2(M.before.parts + M.before.labor)) &&
    near(M.at825.tax, r2(M.before.parts * 0.0825)), JSON.stringify(M));

  /* ---- 12,13. authorization, and work that grows past it ---- */
  results.auth = await page.evaluate(() => {
    const t = orderTotals(cur);
    recordAuthorization(cur, 'Approved', 'Field Test', 'Phone', t.total, 'approved on the phone');
    const afterApproval = { state: cur.auth.state, approved: authorizedTotal(cur), need: needsAdditionalAuth(cur),
                            snap: cur.auth.entries[0].snapshot.total, lines: cur.auth.entries[0].snapshot.lines.length,
                            who: cur.auth.entries[0].who, method: cur.auth.entries[0].method, at: !!cur.auth.entries[0].at };
    /* the customer says yes, then the technician finds something else */
    const extra = SEED.find(r => r.bill === 'H' && r.hrs >= 2);
    addJob(extra.id);
    const afterExtra = { total: orderTotals(cur).total, approved: authorizedTotal(cur), need: needsAdditionalAuth(cur) };
    const gap = r2(afterExtra.total - afterExtra.approved);
    recordAuthorization(cur, 'Approved', 'Field Test', 'Text', gap, 'approved the extra');
    const afterSecond = { approved: authorizedTotal(cur), need: needsAdditionalAuth(cur), entries: cur.auth.entries.length };
    return { afterApproval, afterExtra, afterSecond };
  });
  const A = results.auth;
  check('12. an approval is recorded with who, how, when and a snapshot of what they agreed to',
    A.afterApproval.state === 'Approved' && A.afterApproval.need === false &&
    A.afterApproval.who === 'Field Test' && A.afterApproval.method === 'Phone' &&
    A.afterApproval.at && A.afterApproval.lines > 0 && near(A.afterApproval.snap, A.afterApproval.approved),
    JSON.stringify(A));
  check('13. work added after an approval demands a new one, and a second approval clears it',
    A.afterExtra.need === true && A.afterExtra.total > A.afterExtra.approved &&
    A.afterSecond.need === false && A.afterSecond.entries === 2, JSON.stringify(A));

  /* ---- 10,11. the invoice stops moving ---- */
  results.frozen = await page.evaluate(() => {
    setStatus(cur, 'Invoiced', 'test');
    const at = orderTotals(cur);
    const snapshot = { taxRate: cur.finalized.taxRate, laborRate: cur.finalized.laborRate, invoiceNo: cur.invoiceNo };
    /* now change everything a shop could plausibly change afterwards */
    db.settings.laborRate = 200;
    db.settings.taxRate = 20;
    db.settings.taxLabor = true;
    db.settings.taxParts = false;
    db.settings.partsMarkup = 100;
    const after = orderTotals(cur);
    db.settings.laborRate = 112.50; db.settings.taxRate = 8.25; db.settings.taxLabor = false; db.settings.taxParts = true;
    return { snapshot, before: {labor:at.labor, tax:at.tax, total:at.total}, after: {labor:after.labor, tax:after.tax, total:after.total} };
  });
  const F = results.frozen;
  check('10. a finalized invoice keeps the tax rate it was invoiced at',
    near(F.snapshot.taxRate, 8.25) && near(F.before.tax, F.after.tax), JSON.stringify(F));
  check('11. a finalized invoice does not move when the shop rate, tax or markup changes',
    near(F.before.labor, F.after.labor) && near(F.before.total, F.after.total), JSON.stringify(F));

  /* ---- 14,15. payments ---- */
  results.pay = await page.evaluate(() => {
    const t = orderTotals(cur);
    recordPayment(cur, 100, 'Cash', 'deposit');
    const partial = orderTotals(cur);
    recordPayment(cur, r2(t.total - 100), 'Card', 'balance');
    const full = orderTotals(cur);
    setStatus(cur, 'Paid / Closed', 'balance cleared');
    saveOrder();
    return { total: t.total, afterPartial: { paid: partial.paid, balance: partial.balance },
             afterFull: { paid: full.paid, balance: full.balance }, status: canonStatus(db.orders[Object.keys(db.orders).find(k => db.orders[k].auth && db.orders[k].auth.entries.length === 2)].status) };
  });
  const Y = results.pay;
  check('14. a partial payment leaves exactly the right balance',
    near(Y.afterPartial.paid, 100) && near(Y.afterPartial.balance, r2(Y.total - 100)), JSON.stringify(Y));
  check('15. paying the rest brings the balance to zero and the ticket can close',
    near(Y.afterFull.paid, Y.total) && near(Y.afterFull.balance, 0) && Y.status === 'Paid / Closed', JSON.stringify(Y));

  /* ---- 18,19. what the customer is allowed to see ---- */
  results.privacy = await page.evaluate(() => {
    const id = Object.keys(db.orders).find(k => db.orders[k].auth && db.orders[k].auth.entries.length === 2);
    const o = db.orders[id];
    o.internalNotes = 'SECRETINTERNAL do not show the customer';
    o.custNotes = 'Customer facing note';
    o.notes = 'Technician findings here';
    o.parts.forEach(x => { x.intNote = 'VENDORSECRET'; x.vendor = 'SupplierCo'; });
    const invoice = docInvoice(o), estimate = docEstimate(o), ro = docRepairOrder(o);
    const costStrings = o.parts.filter(x => Number(x.cost) > 0).map(x => money(partCost(x)));
    return {
      invoiceHasInternal: /SECRETINTERNAL/.test(invoice),
      estimateHasInternal: /SECRETINTERNAL/.test(estimate),
      roHasInternal: /SECRETINTERNAL/.test(ro),
      invoiceHasVendorNote: /VENDORSECRET|SupplierCo/.test(invoice),
      invoiceHasCost: costStrings.some(c => invoice.indexOf('>' + c + '<') >= 0),
      invoiceHasMarkupWord: /markup|MU%|margin|cost/i.test(invoice),
      invoiceHasCustNote: /Customer facing note/.test(invoice),
      roHasFindings: /Technician findings here/.test(ro),
      roLineTablesPriced: (ro.match(/<table[\s\S]*?<\/table>/g) || []).some(t => /\$\d/.test(t)),
      roShowsAuthCeiling: /approved to \$/.test(ro)
    };
  });
  const V = results.privacy;
  check('18. internal notes never reach a customer document, but do reach the shop copy',
    V.invoiceHasInternal === false && V.estimateHasInternal === false && V.roHasInternal === true &&
    V.invoiceHasCustNote && V.roHasFindings, JSON.stringify(V));
  check('19. what the shop paid stays off the invoice, and the shop copy carries no line pricing',
    V.invoiceHasCost === false && V.invoiceHasVendorNote === false && V.invoiceHasMarkupWord === false &&
    V.roLineTablesPriced === false && V.roShowsAuthCeiling === true, JSON.stringify(V));

  /* ---- 16,17. it all survives being closed and reopened ---- */
  const beforeReload = await page.evaluate(() => {
    const id = Object.keys(db.orders).find(k => db.orders[k].auth && db.orders[k].auth.entries.length === 2);
    const o = db.orders[id];
    return { id, status: canonStatus(o.status), total: orderTotals(o).total, paid: orderTotals(o).paid,
             estimateNo: o.estimateNo, roNo: o.roNo, invoiceNo: o.invoiceNo,
             nextEstimate: db.settings.nextEstimate, nextRO: db.settings.nextRO, nextInvoice: db.settings.nextInvoice,
             auth: o.auth.entries.length, payments: o.payments.length, history: o.history.length };
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  results.afterReload = await page.evaluate(id => {
    const o = db.orders[id];
    if (!o) return { missing: true };
    const t = orderTotals(o);
    return { status: canonStatus(o.status), total: t.total, paid: t.paid, balance: t.balance,
             estimateNo: o.estimateNo, roNo: o.roNo, invoiceNo: o.invoiceNo,
             nextEstimate: db.settings.nextEstimate, nextRO: db.settings.nextRO, nextInvoice: db.settings.nextInvoice,
             auth: o.auth.entries.length, payments: o.payments.length, history: o.history.length,
             frozenTaxRate: o.finalized && o.finalized.taxRate,
             legacyStillThere: !!db.orders.oOld && near2(orderTotals(db.orders.oOld).total, 337.43) };
    function near2(a, b) { return Math.abs(a - b) < 0.005; }
  }, beforeReload.id);
  const R = results.afterReload;
  check('16. status, totals and payments survive closing and reopening the program',
    !R.missing && R.status === beforeReload.status && near(R.total, beforeReload.total) &&
    near(R.paid, beforeReload.paid) && near(R.balance, 0) &&
    R.auth === beforeReload.auth && R.payments === beforeReload.payments && R.history === beforeReload.history &&
    R.legacyStillThere, JSON.stringify({ beforeReload, R }));
  check('17. estimate, RO and invoice numbers survive a restart and are never reissued',
    R.estimateNo === beforeReload.estimateNo && R.roNo === beforeReload.roNo && R.invoiceNo === beforeReload.invoiceNo &&
    R.nextEstimate >= beforeReload.nextEstimate && R.nextRO >= beforeReload.nextRO && R.nextInvoice >= beforeReload.nextInvoice &&
    near(R.frozenTaxRate, 8.25), JSON.stringify({ beforeReload, R }));

  /* ---- 20. the v2.2.0 behaviour is all still there ---- */
  results.stillWorks = await page.evaluate(() => {
    const p = vehicleProfile(db.vehicles.v1);
    const m3 = searchCatalog(p, '').filter(h => h.row.sec === 'BMW M3');
    const truck = vehicleProfile({ id: 't', year: '2019', make: 'FORD', model: 'F-250', vin: '',
      decoded: { year: '2019', make: 'FORD', model: 'F-250', series: 'Super Duty', bodyClass: 'Pickup',
                 vehicleType: 'TRUCK', fuelType: 'Diesel', driveType: '4WD/4-Wheel Drive/4x4',
                 gvwrClass: 'Class 3: 10,001 - 14,000 lb (4,536 - 6,350 kg)' } });
    return { catalog: SEED.length, m3Gen: p.m3 && p.m3.key, m3Rows: m3.length,
             m3AllF80: m3.every(h => h.row.scope.indexOf('F80') >= 0),
             truckRows: searchCatalog(truck, '').filter(h => h.row.sec === 'Truck & Fleet').length,
             searchLof: searchCatalog(p, 'LOF').length,
             motorStillOff: Providers.motor.active === false,
             seedSource: effectiveSeed(SEED[0]).source };
  });
  const S = results.stillWorks;
  check('20. the v2.2.0 catalog, matching and provider behaviour is untouched',
    S.catalog === 245 && S.m3Gen === 'F80' && S.m3Rows > 0 && S.m3AllF80 && S.truckRows > 0 &&
    S.searchLof > 0 && S.motorStillOff && S.seedSource === 'SHOP SEED', JSON.stringify(S));

  check('21. nothing threw during any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(JSON.stringify(results, null, 1));
  console.log('');
  Object.keys(results).filter(k => typeof results[k] === 'string').forEach(k => console.log(' ' + results[k].padEnd(6) + ' ' + k));
  if (failures.length) {
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL ESTIMATE-TO-INVOICE CHECKS PASSED');
})();
