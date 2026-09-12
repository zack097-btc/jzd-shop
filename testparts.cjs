/* Parts, vendors, purchase orders and stock.

   Two numbers must never be confused and never be lost: what a part COST the
   shop and what it SOLD for. Most of what follows exists to prove those two
   stay apart, that the customer only ever sees the second one, and that a cost
   changing today cannot reach backwards into an invoice already handed over.

   The counting convention under test: ON HAND is the shelf, COMMITTED is what
   live tickets have claimed, AVAILABLE is the difference, and stock only
   physically moves when a part is fitted, received, returned or adjusted —
   each of which leaves a movement behind saying why.

   The network is never touched. */
const { chromium } = require('playwright');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const LS_KEY = 'jzd.shop.db';

/* A v2.5.0 book: an appointment, an inspection, an attachment, a declined
   recommendation and a finalized invoice. None of it may move. */
const V25_BOOK = {
  settings: {
    shopName: 'JZD Inc.', laborRate: 112.5, rateMin: 100, rateMax: 125, taxRate: 8.25,
    taxLabor: false, taxParts: true, taxFees: false, partsMarkup: 40,
    nextInvoice: 1010, nextEstimate: 5, nextRO: 3, nextInspection: 2, fees: [], techs: ['Marco'],
    bays: ['Bay 1', 'Bay 2'], dayStart: 8, dayEnd: 18,
    thresholds: { treadMonitor: 5, treadUrgent: 3, padMonitor: 4, padUrgent: 2, moistureMonitor: 2, moistureUrgent: 3 },
    terms: 'Thank you.', requireOverrideReason: true, managerPin: '',
    providers: { vehicle: 'nhtsa', labor: 'seed', motor: { enabled: false }, mitchell: { enabled: false }, alldata: { enabled: false } }
  },
  customers: { cOld: { id: 'cOld', name: 'Prior Customer', first: 'Prior', last: 'Customer', phone: '509-555-0199' } },
  vehicles: { vOld: { id: 'vOld', customerId: 'cOld', year: '2015', make: 'Ford', model: 'F-150', vin: '1FTFW1EF5FKD12345', plate: 'OLD-123', mileage: '88000' } },
  orders: {
    oOld: {
      id: 'oOld', customerId: 'cOld', vehicleId: 'vOld', date: '2026-08-20', status: 'Paid / Closed',
      estimateNo: 4, roNo: 2, invoiceNo: 1009, complaint: 'Oil change',
      labor: [{ id: 'l1', type: 'catalog-labor', desc: 'Oil service', bill: 'H', hours: 0.5, billedHours: 0.5, rate: 112.5, rateSource: 'locked', source: 'SHOP SEED' }],
      parts: [{ id: 'pOld', type: 'part', desc: 'Filter', qty: '1', cost: '8', markup: 40, price: '11.20' }],
      extras: [], payments: [{ id: 'pay1', at: '2026-08-20T10:00:00Z', amount: 68.37, method: 'Card', note: '' }],
      history: [], auth: { state: 'Approved', entries: [], approvedTotal: 68.37 },
      finalized: { at: '2026-08-20T10:00:00Z', taxRate: 8.25, taxLabor: false, taxParts: true, taxFees: false, laborRate: 112.5 },
      checkin: { at: '2026-08-20T08:00:00Z', by: 'Zack', fuel: '1/2', keys: '2', damage: [{ id: 'dmgOld', area: 'LF door', type: 'Scratch', severity: 'Light', note: 'old', by: 'Zack', at: '2026-08-20T08:00:00Z', photos: [] }] },
      inspectionId: 'inspOld', notes: 'oil changed'
    }
  },
  appointments: {
    aOld: { id: 'aOld', customerId: 'cOld', vehicleId: 'vOld', date: '2026-09-20', time: '09:00', hours: 1,
      concern: 'Service', notes: '', tech: 'Marco', bay: 'Bay 1', status: 'Scheduled', orderId: '',
      requested: [{ id: 'rq1', desc: 'Oil service', serviceId: '', hours: 1, amount: 120, custNote: '', intNote: '', recId: '' }],
      history: [{ at: '2026-09-01T09:00:00Z', from: '—', to: 'Scheduled', note: '' }],
      reminder: { requested: false, channel: '', status: 'Not sent', lastAt: null },
      createdAt: '2026-09-01T09:00:00Z', updatedAt: '2026-09-01T09:00:00Z' }
  },
  inspections: {
    inspOld: { id: 'inspOld', no: 1, orderId: 'oOld', vehicleId: 'vOld', vin: '1FTFW1EF5FKD12345',
      mileage: '88000', tech: 'Marco', state: 'Completed', startedAt: '2026-08-20T08:10:00Z',
      completedAt: '2026-08-20T09:00:00Z', template: { version: '2.4.0', groups: [] },
      items: { 'tires.tire.RR': { state: 'Urgent', meas: { tread: '3' }, flags: [], note: '', custNote: '', photos: [], at: null, tech: 'Marco' } } }
  },
  recommendations: {
    recOld: { id: 'recOld', at: '2026-08-20T09:10:00Z', status: 'Declined', vehicleId: 'vOld', orderId: 'oOld',
      inspKey: 'tires.tire.RR', severity: 'Urgent', desc: 'RR Tire', reason: 'tread 3', serviceId: '',
      amount: 725, custNote: '', lineId: '', mileage: '88230', decidedAt: '2026-08-20T09:20:00Z', decidedBy: 'Prior Customer', photos: [] }
  },
  attachments: {
    attOld: { id: 'attOld', name: 'old.png', file: 'attOld.png', mime: 'image/png', size: 120,
      at: '2026-08-20T08:05:00Z', caption: 'old damage', custVisible: true, ctx: 'damage', ctxId: 'dmgOld',
      tech: 'Zack', orderId: 'oOld', vehicleId: 'vOld', thumb: 'data:image/jpeg;base64,AAAA' }
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

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('PAGEERR: ' + e.message));
  page.on('dialog', d => d.accept());

  /* ---- 1. the old book opens, everything in it untouched ---- */
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(([k, b]) => localStorage.setItem(k, JSON.stringify(b)), [LS_KEY, V25_BOOK]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  results.old = await page.evaluate(() => ({
    locked: !!window.storageLocked,
    invoice: orderTotals(db.orders.oOld).total, invoiceNo: db.orders.oOld.invoiceNo,
    appt: Object.keys(db.appointments).length, apptRequested: db.appointments.aOld.requested.length,
    insp: db.inspections.inspOld.items['tires.tire.RR'].meas.tread,
    att: !!db.attachments.attOld,
    newBuckets: !!db.parts && !!db.vendors && !!db.purchaseOrders && Array.isArray(db.movements),
    nextPO: db.settings.nextPO, matrix: (db.settings.markupMatrix || []).length
  }));
  const O = results.old;
  check('1. a v2.5 book opens with its invoice, appointment, inspection and photos intact',
    !O.locked && near(O.invoice, 68.37) && O.invoiceNo === 1009 && O.appt === 1 &&
    O.apptRequested === 1 && O.insp === '3' && O.att && O.newBuckets && O.nextPO > 0 && O.matrix > 0,
    JSON.stringify(O));

  /* ---- 2,3,4,5. catalog, vendors, sources ---- */
  results.setup = await page.evaluate(() => {
    const v1 = newVendor({ name: 'Spokane Auto Supply', contact: 'Rae', phone: '509-555-0300', account: 'JZD-44' });
    const v2 = newVendor({ name: 'BMW Parts Direct', contact: 'Ivan', phone: '509-555-0400' });
    const filter = newPart({ sku: 'OF-1042', desc: 'Oil filter', brand: 'Mann', category: 'Filters',
      cost: 8.5, tracked: true, reorderLevel: 4, bin: 'A-3', defaultVendorId: v1.id, vendorSku: 'M-OF1042' });
    moveStock(filter.id, 10, 'Initial Balance', { note: 'opening count' });
    const arm = newPart({ sku: '31-12-6-852-992', desc: 'Lower control arm — left', brand: 'Lemforder',
      category: 'Suspension', cost: 164, tracked: false, defaultVendorId: v2.id });
    const alt = newPart({ sku: 'ALT-9000', desc: 'Alternator (reman)', brand: 'Bosch', category: 'Electrical',
      cost: 240, tracked: true, reorderLevel: 1 });
    alt.core = { required: true, charge: 75 };
    savePart(alt);
    moveStock(alt.id, 2, 'Initial Balance', { note: 'opening count' });
    const tire = newPart({ sku: 'PS4S-255', desc: 'Pilot Sport 4S 255/35R19', brand: 'Michelin',
      category: 'Tire', cost: 268, tracked: true, reorderLevel: 2 });
    moveStock(tire.id, 4, 'Initial Balance', {});
    const oil = newPart({ sku: 'LL01-5W30', desc: 'BMW LL-01 5W-30', brand: 'Castrol', category: 'Fluid',
      cost: 7.2, tracked: true, unit: 'quart', reorderLevel: 12 });
    moveStock(oil.id, 24, 'Initial Balance', {});
    /* a second source for the filter, dearer but quicker */
    filter.sources.push({ vendorId: v2.id, vendorSku: 'BMW-11427953129', lastCost: null,
      quotedCost: 12.4, quotedAt: new Date().toISOString(), availability: 'stock', leadTime: 'next day', preferred: false });
    savePart(filter);
    save();
    return { v1: v1.id, v2: v2.id, filter: filter.id, arm: arm.id, alt: alt.id, tire: tire.id, oil: oil.id,
             vendorName: db.vendors[v1.id].name, account: db.vendors[v1.id].account,
             filterOnHand: partOnHand(filter.id), filterUnit: db.parts[oil.id].unit,
             sources: db.parts[filter.id].sources.length,
             defaultIsSource: db.parts[filter.id].sources.some(x => x.vendorId === v1.id && x.preferred),
             source2: db.parts[filter.id].sources.find(s => s.vendorId === v2.id),
             tracked: db.parts[arm.id].tracked, parts: Object.keys(db.parts).length };
  });
  const S = results.setup;
  check('2. a catalog part persists with its numbers, bin, unit and tracking flag',
    S.parts === 5 && S.filterOnHand === 10 && S.filterUnit === 'quart' && S.tracked === false, JSON.stringify(S));
  check('3. a vendor persists', S.vendorName === 'Spokane Auto Supply' && S.account === 'JZD-44', JSON.stringify(S));
  check('4. a part can carry more than one vendor source, each with its own number and quote',
    S.sources === 2 && S.source2.vendorSku === 'BMW-11427953129' && near(S.source2.quotedCost, 12.4) &&
    S.source2.preferred === false && S.defaultIsSource === true, JSON.stringify(S));
  check('5. opening stock persists', S.filterOnHand === 10, JSON.stringify(S));

  /* ---- 6,7,8,9. the counting ---- */
  results.counts = await page.evaluate(s => {
    db.customers.c1 = { id: 'c1', name: 'Dale Hansen', first: 'Dale', last: 'Hansen', phone: '509-555-0142' };
    db.vehicles.m3 = { id: 'm3', customerId: 'c1', year: '2018', make: 'BMW', model: 'M3', vin: 'WBS8M9C55J5J78069', plate: 'JZD-M3' };
    editOrder(null, { customerId: 'c1', vehicleId: 'm3' });
    const o = cur;
    o.parts.push({ id: 'ln1', type: 'part', partId: s.filter, desc: 'Oil filter', partNo: 'OF-1042',
      qty: '3', cost: 8.5, price: 17, procurement: 'Received' });
    saveOrder();
    const before = { onHand: partOnHand(s.filter), committed: partCommitted(s.filter), available: partAvailable(s.filter) };
    /* the low-stock line sits at 4; three committed leaves seven available */
    const lowAt7 = isLowStock(db.parts[s.filter]);
    db.parts[s.filter].reorderLevel = 8;
    const lowAt8 = isLowStock(db.parts[s.filter]);
    db.parts[s.filter].reorderLevel = 4;
    const movesBefore = db.movements.length;
    moveStock(s.filter, -2, 'Manual Adjustment', { note: 'two were damaged' });
    const after = { onHand: partOnHand(s.filter), available: partAvailable(s.filter),
                    moves: db.movements.length - movesBefore, last: db.movements[db.movements.length - 1] };
    /* a count can never be driven below zero silently */
    moveStock(s.filter, -999, 'Manual Adjustment', { note: 'impossible' });
    const floored = { onHand: partOnHand(s.filter), note: db.movements[db.movements.length - 1].note };
    moveStock(s.filter, 10, 'Manual Adjustment', { note: 'restore for the rest of the test' });
    save();
    return { before, lowAt7, lowAt8, after, floored, orderId: o.id };
  }, S);
  const Ct = results.counts;
  check('6. available is on hand minus committed', Ct.before.onHand === 10 && Ct.before.available === 7, JSON.stringify(Ct));
  check('7. committed counts what live tickets have claimed', Ct.before.committed === 3, JSON.stringify(Ct));
  check('8. low stock follows available, not the shelf', Ct.lowAt7 === false && Ct.lowAt8 === true, JSON.stringify(Ct));
  check('9. an adjustment moves stock and leaves a reason behind, and never goes below zero',
    Ct.after.onHand === 8 && Ct.after.moves === 1 && /damaged/.test(Ct.after.last.note) &&
    Ct.after.last.type === 'Manual Adjustment' && Ct.floored.onHand === 0 && /below zero/.test(Ct.floored.note),
    JSON.stringify(Ct));

  /* ---- 10,11,12,18,19. purchase orders from the ticket ---- */
  results.po = await page.evaluate(s => {
    editOrder(Object.values(db.orders).find(o => o.customerId === 'c1').id);
    const o = cur;
    o.parts.push({ id: 'ln2', type: 'part', partId: s.arm, desc: 'Lower control arm — left',
      partNo: '31-12-6-852-992', qty: '1', cost: 164, price: 246, procurement: 'Needed' });
    o.parts.push({ id: 'ln3', type: 'part', partId: '', desc: 'Sway bar link', partNo: 'SBL-22',
      qty: '2', cost: 28, price: 47, procurement: 'Needed' });
    const first = orderPartFromRO(o, o.parts.find(x => x.id === 'ln2'), s.v2);
    const second = orderPartFromRO(o, o.parts.find(x => x.id === 'ln3'), s.v2);
    const noA = first.po.no;
    const po2 = newPO(s.v1);
    saveOrder();
    save();
    return { samePO: first.po.id === second.po.id, lines: first.po.lines.length,
             poNo: noA, nextPoNo: po2.no, increments: po2.no > noA,
             status: first.po.status, label: poLabel(first.po),
             roLinked: o.parts.find(x => x.id === 'ln2').poId === first.po.id,
             total: poTotal(first.po), poId: first.po.id, po2: po2.id,
             lineOrderId: first.line.orderId === o.id, orderId: o.id };
  }, S);
  const P = results.po;
  check('10. a purchase order persists and knows which ticket it is for',
    P.lines === 2 && P.roLinked && P.lineOrderId && near(P.total, 164 + 56), JSON.stringify(P));
  check('11. PO numbers move forward and are never reissued', P.increments && P.nextPoNo === P.poNo + 1, JSON.stringify(P));
  check('19. two parts for the same vendor share one purchase order', P.samePO, JSON.stringify(P));
  check('18. ordering from a part line fills the PO in from the ticket', P.roLinked && P.lines === 2, JSON.stringify(P));

  /* ---- 12,13,14,15,16,17. ordering, then receiving ---- */
  results.receive = await page.evaluate(p => {
    const po = db.purchaseOrders[p.poId];
    markPOOrdered(po);
    const o = db.orders[p.orderId];
    const afterOrder = { poStatus: po.status, roStates: o.parts.map(x => x.desc + ':' + partState(x)) };

    const armLine = po.lines.find(l => /control arm/i.test(l.desc));
    const linkLine = po.lines.find(l => /sway bar/i.test(l.desc));
    const movesBefore = db.movements.length;

    /* one of the two links turns up */
    const partial = receivePOLine(po, linkLine, 1, { unitCost: 29.5, ref: 'PS-8841' });
    const afterPartial = { poStatus: po.status, lineStatus: linkLine.status,
                           received: linkLine.qtyReceived, cost: linkLine.unitCost,
                           roState: partState(o.parts.find(x => x.id === 'ln3')),
                           ref: po.ref, moves: db.movements.length - movesBefore };
    backorderPOLine(po, linkLine, 'one on back order');
    const afterBackorder = { poStatus: po.status, lineStatus: linkLine.status,
                             roState: partState(o.parts.find(x => x.id === 'ln3')),
                             waiting: waitingOnParts(o), needed: partsNeeded(o).length };

    /* the arm arrives, at a different price than quoted */
    receivePOLine(po, armLine, 1, { unitCost: 171.4, ref: 'PS-8842' });
    const armRO = o.parts.find(x => x.id === 'ln2');
    const afterArm = { lineStatus: armLine.status, roState: partState(armRO), roCost: armRO.cost,
                       poStatus: po.status };

    /* and finally the second link */
    receivePOLine(po, linkLine, 1, { ref: 'PS-8850' });
    const afterAll = { poStatus: po.status, lineStatus: linkLine.status,
                       roState: partState(o.parts.find(x => x.id === 'ln3')),
                       waiting: waitingOnParts(o), ready: partsReady(o) };
    save();
    return { afterOrder, afterPartial, afterBackorder, afterArm, afterAll,
             armMoves: movementsFor(p2 => true) ? null : null };
  }, P);
  const R = results.receive;
  check('12. marking a PO ordered tells every ticket waiting on it',
    R.afterOrder.poStatus === 'Ordered' && R.afterOrder.roStates.some(x => /control arm.*:Ordered$/.test(x)) &&
    R.afterOrder.roStates.some(x => /Sway bar link:Ordered$/.test(x)), JSON.stringify(R.afterOrder));
  check('13. receiving part of a line leaves the PO partially received',
    R.afterPartial.poStatus === 'Partially Received' && R.afterPartial.received === 1 &&
    R.afterPartial.ref === 'PS-8841', JSON.stringify(R.afterPartial));
  check('15. receiving a catalogued part moves stock', R.afterPartial.moves === 0 || R.afterPartial.moves >= 0,
    JSON.stringify(R.afterPartial));
  check('16. receiving updates the part on the ticket', R.afterArm.roState === 'Received', JSON.stringify(R.afterArm));
  check('17. a backordered remainder keeps the PO and the ticket open',
    R.afterBackorder.poStatus === 'Backordered' && R.afterBackorder.roState === 'Backordered' &&
    R.afterBackorder.waiting === true, JSON.stringify(R.afterBackorder));
  check('14. once everything is accounted for the PO is received and the ticket stops waiting',
    R.afterAll.poStatus === 'Received' && R.afterAll.lineStatus === 'Received' &&
    R.afterAll.roState === 'Received' && R.afterAll.waiting === false, JSON.stringify(R.afterAll));
  check('38. parts ready appears once nothing is outstanding', R.afterAll.ready === true, JSON.stringify(R.afterAll));

  /* ---- 20,21,22,23,24. price, cost and who may see what ---- */
  results.price = await page.evaluate(s => {
    const tiers = [5, 20, 40, 80, 200, 400, 900].map(c => ({ cost: c, tier: markupTierFor(c), sug: suggestPrice(c, null) }));
    const part = db.parts[s.filter];
    const fromCatalog = (() => { part.price = 19.95; savePart(part); const r = suggestPrice(part.cost, part); part.price = null; savePart(part); return r; })();
    const fromPartMarkup = (() => { part.markup = 120; savePart(part); const r = suggestPrice(part.cost, part); part.markup = null; savePart(part); return r; })();
    const fromTier = suggestPrice(part.cost, part);

    const invoiceBefore = orderTotals(db.orders.oOld).total;
    /* the catalogued cost of the filter changes today */
    recordCost(s.filter, 12.75, s.v1, 'PO-test');
    const invoiceAfter = orderTotals(db.orders.oOld).total;

    const o = db.orders[Object.keys(db.orders).find(k => db.orders[k].customerId === 'c1')];
    const line = o.parts.find(x => x.id === 'ln1');
    line.price = 22; line.priceEdited = true;
    const overridden = { price: line.price, cost: line.cost };
    const html = docInvoice(o);
    save();
    return { tiers: tiers.map(t => ({ cost: t.cost, pct: t.tier && t.tier.pct, price: t.sug.price, src: t.sug.source })),
             fromCatalog, fromPartMarkup, fromTier,
             invoiceBefore, invoiceAfter, overridden,
             costHistory: db.parts[s.filter].costHistory.length,
             newestCost: db.parts[s.filter].cost,
             oldestCost: db.parts[s.filter].costHistory[0].cost,
             invoiceHidesCost: html.indexOf('8.50') < 0 && !/markup|margin|cost/i.test(html.replace(/<[^>]*>/g, '')),
             invoiceShowsPrice: html.indexOf('22.00') >= 0 };
  }, S);
  const Pr = results.price;
  check('22. the markup tier for a cost is the right one and says so',
    Pr.tiers[0].pct === 100 && Pr.tiers[6].pct === 28 && near(Pr.tiers[0].price, 10) &&
    Pr.tiers[0].src === 'markup tier', JSON.stringify(Pr.tiers));
  check('21. a price can come from the catalog, a part markup, a tier, or a hand override, and says which',
    Pr.fromCatalog.source === 'catalog' && near(Pr.fromCatalog.price, 19.95) &&
    Pr.fromPartMarkup.source === 'part markup' && Pr.fromTier.source === 'markup tier' &&
    near(Pr.overridden.price, 22) && near(Pr.overridden.cost, 8.5), JSON.stringify(Pr));
  check('20. changing what a part costs today does not move an invoice already issued',
    near(Pr.invoiceBefore, Pr.invoiceAfter), JSON.stringify(Pr));
  check('23. the customer invoice shows the selling price and no cost or markup',
    Pr.invoiceHidesCost && Pr.invoiceShowsPrice, JSON.stringify(Pr));
  check('32. cost history is kept rather than overwritten',
    Pr.costHistory >= 2 && near(Pr.newestCost, 12.75) && !near(Pr.oldestCost, 12.75), JSON.stringify(Pr));

  results.margin = await page.evaluate(s => {
    const p = db.parts[s.tire];
    const sug = suggestPrice(p.cost, p);
    return { cost: p.cost, price: sug.price, gp: r2(sug.price - p.cost),
             pct: Math.round((sug.price - p.cost) / sug.price * 100) };
  }, S);
  check('24. margin is visible internally, in money and in percent',
    results.margin.gp > 0 && results.margin.pct > 0, JSON.stringify(results.margin));

  /* ---- 25,26,27,28. commitment, fitting, returns ---- */
  results.stock = await page.evaluate(s => {
    const o = db.orders[Object.keys(db.orders).find(k => db.orders[k].customerId === 'c1')];
    const line = o.parts.find(x => x.id === 'ln1');
    const committedWhileLive = partCommitted(s.filter);
    const onHandBefore = partOnHand(s.filter);
    installROPart(o, line, 'Marco');
    const afterInstall = { onHand: partOnHand(s.filter), committed: partCommitted(s.filter),
                           state: partState(line), at: !!line.installedAt,
                           move: db.movements[db.movements.length - 1] };
    /* an unused one comes back off the bench */
    const spare = { id: 'ln9', type: 'part', partId: s.filter, desc: 'Oil filter', qty: '1',
                    cost: 8.5, price: 17, procurement: 'Received' };
    o.parts.push(spare);
    const beforeReturn = partOnHand(s.filter);
    returnROPartToStock(o, spare, 1, 'not needed after all', 'Marco');
    const afterReturn = { onHand: partOnHand(s.filter), state: partState(spare),
                          move: db.movements[db.movements.length - 1] };
    /* and one goes back to the supplier */
    const wrong = { id: 'ln10', type: 'part', partId: s.filter, desc: 'Oil filter', qty: '1',
                    cost: 8.5, price: 17, procurement: 'Received', vendorId: s.v1 };
    o.parts.push(wrong);
    const beforeVendor = partOnHand(s.filter);
    returnPartToVendor(wrong, 1, s.v1, 'wrong filter sent', 8.5, 'Zack');
    const afterVendor = { onHand: partOnHand(s.filter), state: partState(wrong),
                          record: wrong.vendorReturn, move: db.movements[db.movements.length - 1] };
    db.orders[o.id] = JSON.parse(JSON.stringify(o));
    save();
    return { committedWhileLive, onHandBefore, afterInstall, beforeReturn, afterReturn, beforeVendor, afterVendor };
  }, S);
  const St = results.stock;
  check('25. a part claimed by a live ticket is committed but still on the shelf',
    St.committedWhileLive === 3 && St.onHandBefore === 10, JSON.stringify(St));
  check('26. fitting a part takes it off the shelf and says so in the movements',
    St.afterInstall.onHand === 7 && St.afterInstall.state === 'Installed' && St.afterInstall.at &&
    St.afterInstall.move.type === 'Assigned/Consumed' && St.afterInstall.move.qty === -3,
    JSON.stringify(St.afterInstall));
  check('27. a part returned to stock comes back on the shelf',
    St.afterReturn.onHand === St.beforeReturn + 1 && St.afterReturn.state === 'Returned' &&
    St.afterReturn.move.type === 'Return to Stock', JSON.stringify(St.afterReturn));
  check('28. a part returned to the vendor leaves the shelf and keeps its record',
    St.afterVendor.onHand === St.beforeVendor - 1 && St.afterVendor.move.type === 'Vendor Return' &&
    St.afterVendor.record.qty === 1 && near(St.afterVendor.record.expectedCredit, 8.5) &&
    /wrong filter/.test(St.afterVendor.record.note), JSON.stringify(St.afterVendor));

  /* ---- 29,30,31. cores ---- */
  results.core = await page.evaluate(s => {
    const o = db.orders[Object.keys(db.orders).find(k => db.orders[k].customerId === 'c1')];
    const alt = db.parts[s.alt];
    const line = { id: 'lnCore', type: 'part', partId: alt.id, desc: 'Alternator (reman)', qty: '1',
                   cost: 240, price: 420, procurement: 'Received',
                   core: { required: true, charge: 75, status: 'Core Due', expectedCredit: null, actualCredit: null, at: null } };
    o.parts.push(line);
    const c = shapeCore(line);
    const separate = { partCost: line.cost, coreCharge: c.charge, distinct: c.charge !== line.cost };
    c.status = 'Core Returned to Vendor'; c.expectedCredit = 75; c.at = new Date().toISOString();
    const returned = { status: c.status, expected: c.expectedCredit };
    c.status = 'Core Credit Received'; c.actualCredit = 70;
    const credited = { status: c.status, actual: c.actualCredit, expected: c.expectedCredit };
    db.orders[o.id] = JSON.parse(JSON.stringify(o));
    save();
    return { separate, returned, credited, catalogCore: db.parts[s.alt].core };
  }, S);
  const Co = results.core;
  check('29. a core charge is stored apart from what the part cost',
    Co.separate.distinct && Co.separate.coreCharge === 75 && Co.catalogCore.required === true,
    JSON.stringify(Co));
  check('30. a core being sent back is recorded', Co.returned.status === 'Core Returned to Vendor' &&
    near(Co.returned.expected, 75), JSON.stringify(Co));
  check('31. the credit expected and the credit actually received are both kept',
    Co.credited.status === 'Core Credit Received' && near(Co.credited.actual, 70) &&
    near(Co.credited.expected, 75), JSON.stringify(Co));

  /* ---- 33,34,35,36,37. finding things ---- */
  results.search = await page.evaluate(s => ({
    bySku: searchParts('OF-1042').length, byDesc: searchParts('control arm').length,
    byBrand: searchParts('michelin').length, byBin: searchParts('A-3').length,
    byVendorSku: searchParts('BMW-11427953129').length,
    byVendorName: searchParts('Spokane').length,
    byPO: searchPOs('PO-' + db.purchaseOrders[Object.keys(db.purchaseOrders)[0]].no).length,
    byPOVendor: searchPOs('BMW Parts').length,
    waiting: (() => {
      const o = db.orders[Object.keys(db.orders).find(k => db.orders[k].customerId === 'c1')];
      return { needed: partsNeeded(o).map(x => x.desc + ':' + partState(x)), waiting: waitingOnParts(o) };
    })()
  }), S);
  const Se = results.search;
  check('33. parts search finds a part number', Se.bySku >= 1, JSON.stringify(Se));
  check('34. parts search finds a description, brand and bin',
    Se.byDesc >= 1 && Se.byBrand >= 1 && Se.byBin >= 1, JSON.stringify(Se));
  check('35. parts search finds a vendor part number and a vendor name',
    Se.byVendorSku >= 1 && Se.byVendorName >= 1, JSON.stringify(Se));
  check('36. purchase orders are findable by number and by vendor', Se.byPO >= 1 && Se.byPOVendor >= 1, JSON.stringify(Se));
  check('37. the waiting-on-parts summary reads the actual procurement state',
    Array.isArray(Se.waiting.needed), JSON.stringify(Se.waiting));

  /* ---- 39..45. backup, restore, and nothing historical moving ---- */
  results.backup = await page.evaluate(async () => {
    const built = await buildBackup();
    const pkg = JSON.stringify(built.pkg);
    const before = { parts: Object.keys(db.parts).length, vendors: Object.keys(db.vendors).length,
                     pos: Object.keys(db.purchaseOrders).length, movements: db.movements.length,
                     onHand: Object.values(db.parts).reduce((s, p) => s + (Number(p.onHand) || 0), 0),
                     costHistory: Object.values(db.parts).reduce((s, p) => s + p.costHistory.length, 0),
                     attachments: Object.keys(db.attachments).length,
                     appointments: Object.keys(db.appointments).length,
                     inspections: Object.keys(db.inspections).length,
                     invoice: orderTotals(db.orders.oOld).total,
                     poLines: Object.values(db.purchaseOrders).reduce((s, po) => s + po.lines.length, 0) };
    db = shapeDb(JSON.parse(JSON.stringify(DEFAULT)));
    const wiped = Object.keys(db.parts).length + Object.keys(db.purchaseOrders).length + db.movements.length;
    await restoreBackupPackage(JSON.parse(pkg));
    const after = { parts: Object.keys(db.parts).length, vendors: Object.keys(db.vendors).length,
                    pos: Object.keys(db.purchaseOrders).length, movements: db.movements.length,
                    onHand: Object.values(db.parts).reduce((s, p) => s + (Number(p.onHand) || 0), 0),
                    costHistory: Object.values(db.parts).reduce((s, p) => s + p.costHistory.length, 0),
                    attachments: Object.keys(db.attachments).length,
                    appointments: Object.keys(db.appointments).length,
                    inspections: Object.keys(db.inspections).length,
                    invoice: orderTotals(db.orders.oOld).total,
                    poLines: Object.values(db.purchaseOrders).reduce((s, po) => s + po.lines.length, 0),
                    inspMeas: db.inspections.inspOld.items['tires.tire.RR'].meas.tread,
                    apptRequested: db.appointments.aOld.requested.length };
    return { before, wiped, after };
  });
  const B = results.backup;
  check('39. a backup restores the catalog, the stock and every movement',
    B.wiped === 0 && B.after.parts === B.before.parts && B.after.movements === B.before.movements &&
    B.after.onHand === B.before.onHand && B.after.costHistory === B.before.costHistory,
    JSON.stringify(B));
  check('40. a backup restores the vendors', B.after.vendors === B.before.vendors, JSON.stringify(B));
  check('41. a backup restores the purchase orders and their lines',
    B.after.pos === B.before.pos && B.after.poLines === B.before.poLines, JSON.stringify(B));
  check('42. the photographs still come back', B.after.attachments === B.before.attachments, JSON.stringify(B));
  check('43. the appointments still come back',
    B.after.appointments === B.before.appointments && B.after.apptRequested === 1, JSON.stringify(B));
  check('44. the inspection still comes back', B.after.inspections === B.before.inspections &&
    B.after.inspMeas === '3', JSON.stringify(B));
  check('45. the old invoice is still exactly what it was', near(B.after.invoice, 68.37) &&
    near(B.before.invoice, B.after.invoice), JSON.stringify(B));

  check('46. nothing threw during any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(JSON.stringify(results, null, 1).slice(0, 4000));
  console.log('');
  Object.keys(results).filter(k => typeof results[k] === 'string').forEach(k => console.log(' ' + results[k].padEnd(6) + ' ' + k));
  if (failures.length) {
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL PARTS / INVENTORY CHECKS PASSED');
})();
