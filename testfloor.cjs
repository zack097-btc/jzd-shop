/* The shop floor: bays, technician time, quality control, diagnosis, comebacks,
   vehicle history and maintenance.

   The rule under test above all others: SOLD hours and CLOCK hours never touch.
   Every timing check below uses fixed timestamps, so the arithmetic can be done
   by hand and compared, rather than trusting the program to agree with itself.

   The second rule: history is surfaced, never concluded. A comeback links to
   the earlier job without changing it; missing service history reads UNKNOWN.

   The network is never touched. */
const { chromium } = require('playwright');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const LS_KEY = 'jzd.shop.db';
const DAY = '2026-09-12';

/* A v2.6.0 book: everything the parts phase added, on top of an appointment,
   an inspection, a photograph and a finalized invoice. */
const V26_BOOK = {
  settings: {
    shopName: 'JZD Inc.', laborRate: 112.5, rateMin: 100, rateMax: 125, taxRate: 8.25,
    taxLabor: false, taxParts: true, taxFees: false, partsMarkup: 40,
    nextInvoice: 1012, nextEstimate: 9, nextRO: 7, nextInspection: 2, nextPO: 1001, fees: [], techs: ['Marco', 'Zack'],
    bays: ['Bay 1', 'Bay 2', 'Alignment Rack'], dayStart: 8, dayEnd: 18,
    markupMatrix: [{ upTo: 10, pct: 100 }, { upTo: null, pct: 40 }], inventoryUnits: ['each', 'quart'],
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
      labor: [{ id: 'l1', type: 'catalog-labor', desc: 'Oil service', bill: 'H', hours: 0.5, billedHours: 0.5, rate: 112.5, rateSource: 'locked', source: 'SHOP SEED', jobState: 'Completed' }],
      parts: [{ id: 'pOld', type: 'part', desc: 'Filter', qty: '1', cost: '8', markup: 40, price: '11.20' }],
      extras: [], payments: [{ id: 'pay1', at: '2026-08-20T10:00:00Z', amount: 68.37, method: 'Card', note: '' }],
      history: [], auth: { state: 'Approved', entries: [], approvedTotal: 68.37 },
      finalized: { at: '2026-08-20T10:00:00Z', taxRate: 8.25, taxLabor: false, taxParts: true, taxFees: false, laborRate: 112.5 },
      checkin: { at: '2026-08-20T08:00:00Z', by: 'Zack', fuel: '1/2', keys: '2', damage: [] },
      inspectionId: 'inspOld', notes: 'oil changed'
    }
  },
  appointments: {
    aOld: { id: 'aOld', customerId: 'cOld', vehicleId: 'vOld', date: '2026-09-20', time: '09:00', hours: 1,
      concern: 'Service', notes: '', tech: 'Marco', bay: 'Bay 1', status: 'Scheduled', orderId: '',
      requested: [{ id: 'rq1', desc: 'Oil service', serviceId: '', hours: 1, amount: 120, custNote: '', intNote: '', recId: '' }],
      history: [], reminder: { requested: false, channel: '', status: 'Not sent', lastAt: null },
      createdAt: '2026-09-01T09:00:00Z', updatedAt: '2026-09-01T09:00:00Z' }
  },
  inspections: {
    inspOld: { id: 'inspOld', no: 1, orderId: 'oOld', vehicleId: 'vOld', vin: '1FTFW1EF5FKD12345',
      mileage: '88000', tech: 'Marco', state: 'Completed', startedAt: '2026-08-20T08:10:00Z',
      completedAt: '2026-08-20T09:00:00Z', template: { version: '2.4.0', groups: [] },
      items: { 'tires.tire.RR': { state: 'Urgent', meas: { tread: '3' }, flags: [], note: '', custNote: '', photos: [], at: null, tech: 'Marco' } } }
  },
  recommendations: {},
  attachments: {
    attOld: { id: 'attOld', name: 'old.png', file: 'attOld.png', mime: 'image/png', size: 120,
      at: '2026-08-20T08:05:00Z', caption: 'old damage', custVisible: true, ctx: 'damage', ctxId: 'dmgOld',
      tech: 'Zack', orderId: 'oOld', vehicleId: 'vOld', thumb: 'data:image/jpeg;base64,AAAA' }
  },
  parts: {
    prtOld: { id: 'prtOld', sku: 'OF-1', altSku: '', supersededBy: '', desc: 'Oil filter', brand: 'Mann', category: 'Filters',
      defaultVendorId: 'venOld', vendorSku: '', cost: 8, price: null, markup: null, taxable: null, tracked: true, onHand: 6,
      reorderLevel: 2, bin: 'A-1', unit: 'each', notes: '', active: true, sources: [], costHistory: [{ at: '2026-08-01T00:00:00Z', cost: 8 }] }
  },
  vendors: { venOld: { id: 'venOld', name: 'Spokane Auto Supply', active: true } },
  purchaseOrders: {
    poOld: { id: 'poOld', no: 1000, vendorId: 'venOld', status: 'Received', createdAt: '2026-08-01T00:00:00Z',
      lines: [{ id: 'pl1', partId: 'prtOld', desc: 'Oil filter', qty: 6, qtyReceived: 6, unitCost: 8, status: 'Received' }], history: [] }
  },
  movements: [{ id: 'mv1', at: '2026-08-01T00:00:00Z', partId: 'prtOld', qty: 6, type: 'Receive', poId: 'poOld', orderId: '', who: '', note: '' }],
  catalog: { labor: {}, parts: {}, overrides: {}, disabled: {} },
  vinCache: {}, audit: []
};

const results = {};
const failures = [];
function check(name, cond, detail) {
  results[name] = cond ? 'PASS' : ('FAIL' + (detail ? ' — ' + detail : ''));
  if (!cond) failures.push(name + (detail ? ': ' + detail : ''));
}
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) < (tol || 0.005);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('PAGEERR: ' + e.message));
  page.on('dialog', d => d.accept());
  const reload = async () => { await page.waitForTimeout(700); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(500); };

  /* ---- 1. the v2.6 book opens, and gains the floor without losing anything ---- */
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(([k, b]) => localStorage.setItem(k, JSON.stringify(b)), [LS_KEY, V26_BOOK]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  results.old = await page.evaluate(() => ({
    locked: !!window.storageLocked, invoice: orderTotals(db.orders.oOld).total,
    parts: Object.keys(db.parts).length, pos: Object.keys(db.purchaseOrders).length, moves: db.movements.length,
    buckets: Array.isArray(db.timeSessions) && !!db.qcRecords && !!db.roadTests && !!db.diagnostics && !!db.comebacks &&
             Array.isArray(db.maintenance.records) && !!db.maintenance.overrides,
    maint: (db.settings.maintItems || []).length, maintBlank: (db.settings.maintItems || []).every(m => m.miles == null && m.months == null),
    qc: db.settings.qcRequired, bays: db.settings.bays.length, oldJob: jobState(db.orders.oOld.labor[0])
  }));
  const O = results.old;
  check('1. a v2.6 book opens with its invoice, stock and purchase orders, and gains the floor buckets',
    !O.locked && near(O.invoice, 68.37) && O.parts === 1 && O.pos === 1 && O.moves === 1 && O.buckets &&
    O.maint === 10 && O.maintBlank && O.qc === true && O.bays === 3 && O.oldJob === 'Completed', JSON.stringify(O));

  /* ---- the shop for the rest of the test ---- */
  results.setup = await page.evaluate(DAY => {
    const T = hm => DAY + 'T' + hm + ':00.000Z';
    const ln = (id, desc, hours, tech, extra) => Object.assign({ id, type: 'manual-labor', desc, hours, rate: 112.5, bill: 'H',
      rateSource: 'shop', source: SRC_MANUAL, tech }, extra || {});
    db.customers.c1 = { id: 'c1', name: 'Dale Hansen', first: 'Dale', last: 'Hansen', phone: '509-555-0142' };
    db.customers.c2 = { id: 'c2', name: 'Rae Ortiz', first: 'Rae', last: 'Ortiz', phone: '509-555-0177' };
    db.vehicles.m3 = { id: 'm3', customerId: 'c1', year: '2018', make: 'BMW', model: 'M3', vin: 'WBS8M9C55J5J78069', plate: 'JZD-M3', mileage: '89116' };
    db.vehicles.t1 = { id: 't1', customerId: 'c2', year: '2019', make: 'Ford', model: 'F-250', vin: '1FT7W2BT5KEC12345', plate: 'DSL-250', mileage: '120400' };
    const pads = newPart({ sku: 'BP-7', desc: 'Front brake pads', brand: 'Textar', cost: 44, tracked: true });
    moveStock(pads.id, 4, 'Initial Balance', {});
    const rotor = newPart({ sku: 'RT-3', desc: 'Front rotor', brand: 'Zimmermann', cost: 88, tracked: true });
    /* the earlier visit, closed and invoiced */
    db.orders.oA = shapeOrder({ id: 'oA', customerId: 'c1', vehicleId: 'm3', date: '2025-11-02', status: 'Paid / Closed',
      estimateNo: 5, roNo: 3, invoiceNo: 1010, complaint: 'Coolant leak at front of engine', mileageIn: '83420',
      labor: [ln('aL1', 'Oil service', 0.5, 'Zack', { jobState: 'Completed', completedAt: '2025-11-02T11:00:00Z' }),
              ln('aL2', 'Replace upper radiator hose', 1.2, 'Zack', { jobState: 'Completed', completedAt: '2025-11-02T12:00:00Z' })],
      parts: [{ id: 'aP1', type: 'part', desc: 'Upper radiator hose', partNo: 'RH-22', qty: '1', cost: 30, price: 54 }],
      extras: [], payments: [], history: [], checkin: { at: '2025-11-02T08:00:00Z', by: 'Zack' },
      finalized: { at: '2025-11-02T13:00:00Z', taxRate: 8.25, taxLabor: false, taxParts: true, taxFees: false, laborRate: 112.5 } });
    /* this visit */
    db.orders.o1 = shapeOrder({ id: 'o1', customerId: 'c1', vehicleId: 'm3', date: DAY, status: 'Approved', estimateNo: 6, roNo: 4,
      complaint: 'Coolant leak, sweet smell after driving', mileageIn: '89116',
      labor: [ln('lDiag', 'Diagnose coolant leak', 1.0, 'Zack'), ln('lTh', 'Replace thermostat housing', 3.8, 'Zack'),
              ln('lWp', 'Replace water pump', 3.2, 'Zack'), ln('lBrk', 'Front brake pads and rotors', 1.8, 'Marco'),
              ln('lAl', 'Four-wheel alignment', 1.0, 'Marco')],
      parts: [{ id: 'pWp', type: 'part', desc: 'Water pump', partNo: 'WP-1150', brand: 'Pierburg', qty: '1', cost: 210, price: 320,
                procurement: 'Ordered', jobLineId: 'lWp', vendor: 'BMW Parts Direct' },
              { id: 'pPads', type: 'part', partId: pads.id, desc: 'Front brake pads', partNo: 'BP-7', qty: '1', cost: 44, price: 79,
                procurement: 'Needed', jobLineId: 'lBrk' }],
      extras: [], payments: [], history: [], checkin: { at: T('07:45'), by: 'Zack' } });
    db.orders.o2 = shapeOrder({ id: 'o2', customerId: 'c2', vehicleId: 't1', date: DAY, status: 'Approved', estimateNo: 7, roNo: 5,
      complaint: 'Death wobble over bumps', mileageIn: '120400',
      labor: [ln('tA', 'Replace front track bar', 2.0, 'Marco'), ln('tB', 'Replace steering stabilizer', 1.5, 'Zack'),
              ln('tC', 'Replace front U-joints', 0.7, 'Marco'), ln('tD', 'Replace ball joints', 1.1, 'Marco', { jobState: 'Waiting Approval' }),
              ln('tE', 'Inspect tow hitch wiring', 0.4, 'Zack')],
      parts: [{ id: 'tPu', type: 'part', desc: 'U-joint kit', partNo: 'UJ-5', qty: '2', cost: 40, price: 70, procurement: 'Ordered', jobLineId: 'tC' },
              { id: 'tPt', type: 'part', desc: 'Track bar', partNo: 'TB-1', qty: '1', cost: 180, price: 290, procurement: 'Received', jobLineId: 'tA' },
              { id: 'tPs', type: 'part', desc: 'Stabilizer', partNo: 'ST-2', qty: '1', cost: 60, price: 110, procurement: 'Received', jobLineId: 'tB' }],
      extras: [], payments: [], history: [], checkin: { at: T('08:10'), by: 'Marco' } });
    save();
    return { pads: pads.id, rotor: rotor.id, invoiceA: orderTotals(db.orders.oA).total, invoiceOld: orderTotals(db.orders.oOld).total,
             oAjson: JSON.stringify(db.orders.oA) };
  }, DAY);
  const S = results.setup;

  /* ---- 2,3. bays ---- */
  results.bay = await page.evaluate(() => {
    const first = assignBay(db.orders.o1, 'Bay 1', { tech: 'Zack', note: 'on the lift' });
    const clash = assignBay(db.orders.o2, 'Bay 1', {});
    const clashWho = clash.conflict ? clash.conflict.map(o => o.id) : [];
    const stillOut = db.orders.o2.bay || '';
    const forced = assignBay(db.orders.o2, 'Bay 1', { override: true });
    const sharedCount = bayOccupants('Bay 1').length;
    const moved = assignBay(db.orders.o2, 'Bay 2', {});
    save();
    return { first, clashOk: clash.ok, clashWho, stillOut, forcedOk: forced.ok, forcedShared: forced.shared, sharedCount,
             movedOk: moved.ok, bay1: bayOccupants('Bay 1').map(o => o.id), history: (db.orders.o2.bayHistory || []).length };
  });
  await reload();
  results.bayAfter = await page.evaluate(() => ({ bay: db.orders.o1.bay, at: !!db.orders.o1.bayAt, tech: db.orders.o1.bayTech,
    note: db.orders.o1.bayNote, o2: db.orders.o2.bay, bay2: bayOccupants('Bay 2').map(o => o.id) }));
  const B = results.bay, BA = results.bayAfter;
  check('2. a bay assignment persists with its technician, time and note',
    B.first.ok && BA.bay === 'Bay 1' && BA.at && BA.tech === 'Zack' && BA.note === 'on the lift' && BA.o2 === 'Bay 2' &&
    BA.bay2.length === 1, JSON.stringify([B, BA]));
  check('3. a second vehicle in an occupied bay is refused until it is deliberately overridden',
    B.clashOk === false && B.clashWho.join() === 'o1' && B.stillOut === '' && B.forcedOk && B.forcedShared === true &&
    B.sharedCount === 2 && B.movedOk && B.bay1.join() === 'o1' && B.history === 1, JSON.stringify(B));

  /* ---- 4..12. the clock ---- */
  results.clock = await page.evaluate(DAY => {
    const T = hm => DAY + 'T' + hm + ':00.000Z';
    const o = db.orders.o1, L = id => findLine(o, id);
    const soldBefore = JSON.stringify(o.labor.map(l => [l.id, l.hours, l.billedHours, l.rate, lineAmount(l, o)]));

    jobStart(o, L('lDiag'), 'Zack', { at: T('08:00'), diagnosing: true });
    const afterStart = { sessions: sessionsFor(o, L('lDiag')).length, open: !!openSessionOn(o, L('lDiag')), state: jobState(L('lDiag')) };
    const queue = { zack: queueGroups('Zack'), marco: queueGroups('Marco') };
    const q = g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map(x => x.l.id)]));

    jobPause(o, L('lDiag'), { at: T('09:00') });
    const afterPause = { open: !!openSessionOn(o, L('lDiag')), end: sessionsFor(o, L('lDiag'))[0].end, state: jobState(L('lDiag')) };

    jobResume(o, L('lDiag'), 'Zack', { at: T('09:30') });
    const afterResume = { sessions: sessionsFor(o, L('lDiag')).length, open: !!openSessionOn(o, L('lDiag')), state: jobState(L('lDiag')),
                          secondStart: sessionsFor(o, L('lDiag'))[1].start };

    const finishedAs = jobFinish(o, L('lDiag'), { at: T('10:00'), work: 'Pressure tested cooling system' });
    const afterFinish = { open: !!openSessionOn(o, L('lDiag')), state: jobState(L('lDiag')), finishedAs,
                          clock: clockHours(o, L('lDiag')), history: L('lDiag').stateHistory.map(h => h.to) };

    /* Zack on the thermostat housing; Marco starts brakes at the same time */
    jobStart(o, L('lTh'), 'Zack', { at: T('10:00') });
    jobStart(o, L('lBrk'), 'Marco', { at: T('10:15') });
    /* Marco moves to the alignment: his brakes clock stops, Zack's does not */
    jobStart(o, L('lAl'), 'Marco', { at: T('11:00') });
    const independent = { zackOpen: openSessionsOf('Zack').map(s => s.lineId), marcoOpen: openSessionsOf('Marco').map(s => s.lineId),
                          brakes: jobState(L('lBrk')), thermostat: jobState(L('lTh')) };
    jobResume(o, L('lBrk'), 'Marco', { at: T('11:30') });
    jobFinish(o, L('lBrk'), { at: T('12:00') });
    jobFinish(o, L('lTh'), { at: T('12:30') });
    /* the water pump arrives; Zack fits it */
    const wpBefore = jobPartsState(o, L('lWp'));
    o.parts.find(x => x.id === 'pWp').procurement = 'Received';
    const wpAfter = jobPartsState(o, L('lWp'));
    jobStart(o, L('lWp'), 'Zack', { at: T('12:30') });
    jobResume(o, L('lAl'), 'Marco', { at: T('13:00') });
    jobFinish(o, L('lAl'), { at: T('13:30') });
    jobFinish(o, L('lWp'), { at: T('15:00') });

    const soldAfter = JSON.stringify(o.labor.map(l => [l.id, l.hours, l.billedHours, l.rate, lineAmount(l, o)]));
    const zack = techProduction('Zack', DAY, DAY), marco = techProduction('Marco', DAY, DAY);
    save();
    return { afterStart, queue: { zack: q(queue.zack), marco: q(queue.marco) }, afterPause, afterResume, afterFinish, independent,
             soldSame: soldBefore === soldAfter, soldDiag: soldHours(L('lDiag')), wpBefore, wpAfter,
             clocks: Object.fromEntries(o.labor.map(l => [l.id, clockHours(o, l)])), zack, marco };
  }, DAY);
  const C = results.clock;
  check('4. each technician queue shows their own work, in the right place',
    C.queue.zack.NOW.join() === 'lDiag' && C.queue.zack.NEXT.indexOf('lTh') >= 0 && C.queue.zack.WAITING.indexOf('lWp') >= 0 &&
    C.queue.marco.NEXT.indexOf('lBrk') >= 0 && C.queue.marco.NEXT.indexOf('lAl') >= 0 && C.queue.marco.NOW.length === 0 &&
    C.queue.zack.NEXT.indexOf('tE') >= 0, JSON.stringify(C.queue));
  check('5. starting a job opens a time session', C.afterStart.sessions === 1 && C.afterStart.open && C.afterStart.state === 'Diagnosing',
    JSON.stringify(C.afterStart));
  check('6. pausing closes the running segment', !C.afterPause.open && C.afterPause.end === DAY + 'T09:00:00.000Z' &&
    C.afterPause.state === 'Paused', JSON.stringify(C.afterPause));
  check('7. resuming opens a new segment and goes back to what it was doing',
    C.afterResume.sessions === 2 && C.afterResume.open && C.afterResume.state === 'Diagnosing' &&
    C.afterResume.secondStart === DAY + 'T09:30:00.000Z', JSON.stringify(C.afterResume));
  check('8. completing closes the clock and sends the job to QC',
    !C.afterFinish.open && C.afterFinish.state === 'QC Required' && C.afterFinish.finishedAs === 'QC Required' &&
    C.afterFinish.history.join('>') === 'Diagnosing>Paused>Diagnosing>QC Required', JSON.stringify(C.afterFinish));
  check('9. sold hours and line amounts are untouched by any of the timing', C.soldSame && C.soldDiag === 1, JSON.stringify(C));
  check('10. actual clock time adds up by hand (diag 1.0 + 0.5, brakes 0.75 + 0.5, alignment 0.5 + 0.5)',
    near(C.clocks.lDiag, 1.5) && near(C.clocks.lTh, 2.5) && near(C.clocks.lWp, 2.5) && near(C.clocks.lBrk, 1.25) && near(C.clocks.lAl, 1.0),
    JSON.stringify(C.clocks));
  check('11. efficiency = sold completed / clock (Zack 8.0 / 6.5 = 123.1%, Marco 2.8 / 2.25 = 124.4%)',
    near(C.zack.sold, 8) && near(C.zack.clock, 6.5) && C.zack.efficiency === 123.1 && C.zack.jobsCompleted === 3 &&
    near(C.marco.sold, 2.8) && near(C.marco.clock, 2.25) && C.marco.efficiency === 124.4 && near(C.marco.avgClock, 1.125),
    JSON.stringify([C.zack, C.marco]));
  check('12. two technicians keep separate clocks; starting a job only pauses your own',
    C.independent.zackOpen.join() === 'lTh' && C.independent.marcoOpen.join() === 'lAl' &&
    C.independent.brakes === 'Paused' && C.independent.thermostat === 'In Progress', JSON.stringify(C.independent));

  /* ---- 13..16. quality control ---- */
  results.qc = await page.evaluate(DAY => {
    const T = hm => DAY + 'T' + hm + ':00.000Z';
    const o = db.orders.o1, L = id => findLine(o, id);
    const all = st => QC_ITEMS.map(i => ({ key: i.key, label: i.label, state: st }));
    const pass = recordQC(o, { lineIds: ['lDiag', 'lWp'], by: 'Marco', at: T('15:10'), items: all('Pass'), notes: 'looks good' });
    const failItems = all('Pass'); failItems.find(i => i.key === 'leaks').state = 'Fail';
    const fail = recordQC(o, { lineIds: ['lTh'], by: 'Marco', at: T('15:20'), items: failItems, returnTo: 'In Progress', notes: 'weep at housing' });
    const afterFail = { state: jobState(L('lTh')), failures: L('lTh').qcFailures, failedItems: fail.failedItems, result: fail.result };
    /* reworked and checked again */
    jobResume(o, L('lTh'), 'Zack', { at: T('16:00') });
    jobFinish(o, L('lTh'), { at: T('16:30') });
    recordQC(o, { lineIds: ['lTh'], by: 'Marco', at: T('16:40'), items: all('Pass') });
    recordQC(o, { lineIds: ['lBrk', 'lAl'], by: 'Zack', at: T('16:45'), items: all('Pass') });
    save();
    return { passId: pass.id, passResult: pass.result, failId: fail.id, afterFail };
  }, DAY);
  await reload();
  results.qcAfter = await page.evaluate(ids => {
    const o = db.orders.o1, L = id => findLine(o, id);
    return { pass: db.qcRecords[ids.passId], fail: db.qcRecords[ids.failId],
             diag: jobState(L('lDiag')), wp: jobState(L('lWp')), th: jobState(L('lTh')), thFailures: L('lTh').qcFailures,
             thHistory: L('lTh').stateHistory.map(h => h.to), thQcIds: L('lTh').qcIds.length,
             thRecords: qcFor(o).filter(r => r.lineIds.indexOf('lTh') >= 0).map(r => r.result),
             passedAt: !!L('lDiag').qcPassedAt, column: boardColumn(o),
             grown: (() => { recordAuthorization(o, 'Approved', 'Dale Hansen', 'Phone', 10, ''); const r = { col: boardColumn(o), warn: orderWarnings(o), need: needsAdditionalAuth(o) };
                             o.auth.entries.pop(); o.auth.state = 'Not Requested'; o.auth.approvedTotal = authorizedTotal(o); return r; })() };
  }, { passId: results.qc.passId, failId: results.qc.failId });
  const Q = results.qc, QA = results.qcAfter;
  check('13. a QC record persists with who, when, every item and the notes',
    QA.pass && QA.pass.by === 'Marco' && QA.pass.items.length === 12 && QA.pass.notes === 'looks good' && QA.pass.lineIds.length === 2,
    JSON.stringify(QA.pass));
  check('14. a passed QC marks the jobs QC Passed', Q.passResult === 'Pass' && QA.diag === 'QC Passed' && QA.wp === 'QC Passed' && QA.passedAt,
    JSON.stringify(QA));
  check('15. a failed QC names the failed item and sends the job back to work',
    Q.afterFail.result === 'Fail' && Q.afterFail.state === 'In Progress' && Q.afterFail.failures === 1 &&
    Q.afterFail.failedItems.join() === 'Leaks checked' && QA.fail.returnTo === 'In Progress', JSON.stringify(Q.afterFail));
  check('16. the failure stays in the history after the rework passes',
    QA.th === 'QC Passed' && QA.thFailures === 1 && QA.thRecords.join() === 'Fail,Pass' && QA.thQcIds === 2 &&
    QA.thHistory.indexOf('QC Failed') >= 0 && QA.thHistory[QA.thHistory.length - 1] === 'QC Passed' &&
    QA.column === 'READY FOR PICKUP', JSON.stringify(QA));

  check('16b. a finished car that grew past its approval stays READY FOR PICKUP and carries the warning',
    QA.grown.need === true && QA.grown.col === 'READY FOR PICKUP' && QA.grown.warn.indexOf('ADDITIONAL AUTH') >= 0, JSON.stringify(QA.grown));

  /* ---- 17..21. road tests and diagnosis ---- */
  results.dx = await page.evaluate(DAY => {
    const T = hm => DAY + 'T' + hm + ':00.000Z';
    const o = db.orders.o1;
    const pre = recordRoadTest(o, { kind: 'Pre-Repair', tech: 'Zack', at: T('07:50'), mileageStart: '89116', mileageEnd: '89121', symptoms: 'temp climbs at idle' });
    const post = recordRoadTest(o, { kind: 'Post-Repair', tech: 'Zack', at: T('16:35'), mileageStart: '89121', mileageEnd: '89128',
      steering: 'Normal', braking: 'Normal', vibration: 'Normal', noise: 'Normal', powertrain: 'Normal', warningLights: 'Normal', result: 'Repair verified' });
    const odd = recordRoadTest(o, { kind: 'Sideways', tech: 'Zack' });
    delete db.roadTests[odd.id];
    const d = diagFor(o, true);
    const recsBefore = Object.keys(db.recommendations).length, linesBefore = o.labor.length;
    addMeasurement(d, { type: 'Pressure', label: 'cooling system pressure test', value: '15', unit: 'psi', spec: '', tech: 'Zack', at: T('08:20') });
    addMeasurement(d, { type: 'Temperature', label: 'thermostat housing', value: '212', unit: '°F', spec: '195-220', tech: 'Zack', at: T('08:30') });
    const dtc = addDTC(d, { module: 'DME', code: 'p0597', description: '', status: 'Stored', phase: 'Before repair', tech: 'Zack', at: T('08:10') });
    const afterDtc = { rootCause: d.rootCause, diagnosed: diagnosed(d), recs: Object.keys(db.recommendations).length - recsBefore,
                       lines: o.labor.length - linesBefore, desc: dtc.description, code: dtc.code };
    d.rootCause = 'Water pump seal weeping, pressure drop to 11 psi in 10 min';
    d.recommendedRepair = 'Replace water pump';
    save();
    return { pre: pre.id, post: post.id, oddKind: odd.kind, dx: d.id, afterDtc };
  }, DAY);
  await reload();
  results.dxAfter = await page.evaluate(ids => {
    const o = db.orders.o1;
    const d = db.diagnostics[ids.dx];
    return { pre: db.roadTests[ids.pre], post: db.roadTests[ids.post], kinds: roadTestsFor(o).map(r => r.kind),
             meas: d.measurements.map(m => [m.type, m.value, m.unit, m.spec, m.specSource, m.tech]),
             dtcs: d.dtcs.map(c => [c.module, c.code, c.description, c.status, c.phase]), root: d.rootCause, diagnosed: diagnosed(d) };
  }, results.dx);
  const D = results.dx, DA = results.dxAfter;
  check('17. a road test persists with its mileage, observations and result',
    DA.post && DA.post.mileageEnd === '89128' && DA.post.steering === 'Normal' && DA.post.result === 'Repair verified' && DA.post.tech === 'Zack',
    JSON.stringify(DA.post));
  check('18. pre- and post-repair road tests are kept apart',
    DA.pre.kind === 'Pre-Repair' && DA.post.kind === 'Post-Repair' && DA.kinds.join() === 'Pre-Repair,Post-Repair' && D.oddKind === 'Post-Repair',
    JSON.stringify(DA.kinds));
  check('19. a measurement persists with its unit, spec, spec source and technician',
    DA.meas.length === 2 && DA.meas[0].join('|') === 'Pressure|15|psi|||Zack' &&
    DA.meas[1].join('|') === 'Temperature|212|°F|195-220|entered by technician|Zack', JSON.stringify(DA.meas));
  check('20. a trouble code persists, upper-cased, without a made-up description',
    DA.dtcs.length === 1 && DA.dtcs[0].join('|') === 'DME|P0597||Stored|Before repair', JSON.stringify(DA.dtcs));
  check('21. recording a code does not make a diagnosis or a repair',
    D.afterDtc.rootCause === '' && D.afterDtc.diagnosed === false && D.afterDtc.recs === 0 && D.afterDtc.lines === 0 &&
    D.afterDtc.desc === '' && DA.diagnosed === true, JSON.stringify(D.afterDtc));

  /* ---- 22..30. the vehicle's history ---- */
  results.hist = await page.evaluate(DAY => {
    const T = hm => DAY + 'T' + hm + ':00.000Z';
    const o1 = db.orders.o1;
    installROPart(o1, o1.parts.find(x => x.id === 'pWp'), 'Zack');
    save();
    const priorBefore = JSON.stringify(db.orders.o1);
    const o3 = shapeOrder({ id: 'o3', customerId: 'c1', vehicleId: 'm3', date: DAY, status: 'Estimate', estimateNo: 8,
      complaint: 'Coolant leak again near water pump', mileageIn: '91005', labor: [], parts: [], extras: [], payments: [], history: [],
      checkin: { at: T('17:00'), by: 'Zack' } });
    db.orders.o3 = o3;
    const c = flagComeback(o3, { priorOrderId: 'o1', priorLineId: 'lWp', priorPartLineId: 'pWp', sameConcern: 'Yes', by: 'Zack' });
    cbSet(c.id, 'warrantyDecision', 'Covered — shop warranty');
    cbSet(c.id, 'supplierClaim', 'RMA-5521');
    cbSet(c.id, 'correctiveAction', 'Replaced pump under warranty');
    save();
    const priorAfter = JSON.stringify(db.orders.o1);
    return { cb: c.id, priorSame: priorBefore === priorAfter, finding: c.finding, milesSince: milesSince(c) };
  }, DAY);
  await reload();
  results.histAfter = await page.evaluate(() => {
    const c = Object.values(db.comebacks)[0];
    const tl = vehicleTimeline('m3');
    const parts = installedParts('m3');
    const s = q => searchVehicleHistory('m3', q).map(e => e.kind);
    return { c, o3cb: db.orders.o3.comebackId,
             parts: parts.map(p => [p.desc, p.partNo, p.ticket, p.job, p.mileage, p.brand, p.vendor]),
             legacy: installedParts('vOld').map(p => p.desc),
             sorted: tl.every((e, i) => i === 0 || tl[i - 1].at >= e.at), kinds: Array.from(new Set(tl.map(e => e.kind))),
             firstAt: tl[0].at, lastAt: tl[tl.length - 1].at,
             sWater: s('water pump'), sPart: s('WP-1150'), sDtc: s('p0597'), sTech: s('marco').length, sMiles: s('83420').length,
             rep: repeatedConcerns('m3').map(r => [r.topic, r.visits.map(v => v.mileage)]) };
  });
  const H = results.hist, HA = results.histAfter;
  check('22. a comeback links to the earlier RO, job, part, date and mileage',
    HA.c.priorOrderId === 'o1' && HA.c.priorJob === 'Replace water pump' && /WP-1150/.test(HA.c.priorPart) && HA.c.priorMileage === '89116' &&
    HA.c.priorDate === DAY && HA.c.priorTicket === 'RO-4' && HA.c.priorTech === 'Zack' && HA.o3cb === HA.c.id && H.milesSince === 1889 &&
    H.finding === 'Undetermined', JSON.stringify(HA.c));
  check('23. linking a comeback changes nothing on the earlier RO', H.priorSame, '');
  check('24. the warranty / recheck decision persists', HA.c.warrantyDecision === 'Covered — shop warranty' && HA.c.supplierClaim === 'RMA-5521' &&
    HA.c.correctiveAction === 'Replaced pump under warranty' && HA.c.sameConcern === 'Yes', JSON.stringify(HA.c));
  check('25. installed-part history lists what was fitted, with part number, RO, job and mileage — and not what was only ordered',
    HA.parts.length === 2 && HA.parts[0].join('|') === 'Water pump|WP-1150|RO-4|Replace water pump|89116|Pierburg|BMW Parts Direct' &&
    HA.parts[1][0] === 'Upper radiator hose' && !HA.parts.some(p => /brake pads/i.test(p[0])) && HA.legacy.join() === 'Filter',
    JSON.stringify(HA.parts));
  check('26. the vehicle timeline is newest first and covers the technical record',
    HA.sorted && HA.firstAt >= HA.lastAt && ['Check-in', 'Repair', 'Diagnosis', 'DTC', 'Part installed', 'Comeback / recheck', 'QC Pass', 'QC Fail', 'Road test']
      .every(k => HA.kinds.indexOf(k) >= 0), JSON.stringify(HA.kinds));
  check('27. history search finds a repair', HA.sWater.indexOf('Repair') >= 0, JSON.stringify(HA.sWater));
  check('28. history search finds a part number', HA.sPart.indexOf('Part installed') >= 0, JSON.stringify(HA.sPart));
  check('29. history search finds a trouble code', HA.sDtc.indexOf('DTC') >= 0 && HA.sTech > 0 && HA.sMiles > 0, JSON.stringify([HA.sDtc, HA.sTech, HA.sMiles]));
  check('30. a repeated concern is surfaced with each visit mileage, oldest first',
    HA.rep.some(r => r[0] === 'Coolant leak / overheating' && r[1].join() === '83420,89116,91005'), JSON.stringify(HA.rep));

  /* ---- 31..33. maintenance ---- */
  results.maint = await page.evaluate(() => {
    const item = id => db.settings.maintItems.find(m => m.id === id);
    item('oil').miles = 5000;
    item('brakefluid').months = 24;
    item('coolant').months = 48;
    item('cabin').miles = 15000;
    db.maintenance.records.push({ id: 'mr1', vehicleId: 'm3', itemId: 'brakefluid', date: '2024-09-01', mileage: '', source: "customer's receipt", at: '' });
    save();
    const st = (id, o) => { const r = maintStatus('m3', item(id), o); return { state: r.state, note: r.note, due: r.dueMileage, dueDate: r.dueDate, left: r.milesLeft, days: r.daysLeft, last: r.last && r.last.source }; };
    return {
      oilNow: st('oil', { mileage: 91005 }), oilSoon: st('oil', { mileage: 87900 }), oilNot: st('oil', { mileage: 86000 }),
      bfNow: st('brakefluid', { today: '2026-09-12' }), bfSoon: st('brakefluid', { today: '2026-08-20' }), bfNot: st('brakefluid', { today: '2026-01-01' }),
      coolant: st('coolant', { today: '2026-09-12' }), cabin: st('cabin', {}), plugs: st('plugs', {}),
      truckOil: st('oil', {}) && maintStatus('t1', item('oil'), {}).state,
      override: (() => { db.maintenance.overrides.m3 = { oil: { miles: 8000, months: null } }; const r = maintStatus('m3', item('oil'), { mileage: 91005 }); return [r.state, r.dueMileage, r.interval.vehicleSpecific]; })()
    };
  });
  const M = results.maint;
  check('31. a mileage interval works: due now, due soon and not due',
    M.oilNow.state === 'DUE NOW' && M.oilNow.due === 88420 && M.oilSoon.state === 'DUE SOON' && M.oilSoon.left === 520 &&
    M.oilNot.state === 'NOT DUE' && /this shop/.test(M.oilNow.last) && M.override.join() === 'DUE SOON,91420,true', JSON.stringify(M));
  check('32. a time interval works from a hand-entered record that says where it came from',
    M.bfNow.state === 'DUE NOW' && M.bfNow.dueDate === '2026-09-01' && M.bfSoon.state === 'DUE SOON' && M.bfNot.state === 'NOT DUE' &&
    M.bfNow.last === "customer's receipt", JSON.stringify([M.bfNow, M.bfSoon, M.bfNot]));
  check('33. with no record the status is UNKNOWN, never assumed; with no interval it says so',
    M.coolant.state === 'UNKNOWN' && M.coolant.note === 'SERVICE HISTORY UNKNOWN' && M.cabin.state === 'UNKNOWN' &&
    M.plugs.state === 'NO INTERVAL SET' && M.truckOil === 'UNKNOWN', JSON.stringify([M.coolant, M.cabin, M.plugs, M.truckOil]));

  /* ---- 34..41. readiness, holds and the workload ---- */
  results.load = await page.evaluate(S => {
    const o2 = db.orders.o2, L = id => findLine(o2, id);
    /* parts readiness, from inventory and procurement */
    const o1 = db.orders.o1;
    const ready = {
      brakesFromStock: jobPartsState(o1, findLine(o1, 'lBrk')),
      noParts: jobPartsState(o1, findLine(o1, 'lDiag')),
      uJoints: jobPartsState(o2, L('tC')), trackBar: jobPartsState(o2, L('tA'))
    };
    o1.parts.push({ id: 'pRot', type: 'part', partId: S.rotor, desc: 'Front rotor', partNo: 'RT-3', qty: '2', cost: 88, price: 150, procurement: 'Needed', jobLineId: 'lBrk' });
    save();
    ready.rotorNoStock = jobPartsState(o1, findLine(o1, 'lBrk'));
    moveStock(S.rotor, 2, 'Initial Balance', {});
    ready.rotorStocked = jobPartsState(o1, findLine(o1, 'lBrk'));
    o1.parts = o1.parts.filter(x => x.id !== 'pRot');

    /* put the M3 visits away so the truck is the only car on the floor */
    markDelivered(db.orders.o1, 'Zack');
    db.orders.o3.status = 'Cancelled';
    const hold = setHold(o2, L('tE'), 'Waiting Customer', 'call back about hitch', 'Marco');
    jobStart(o2, L('tB'), 'Zack', {});
    save();
    return { ready, holdReason: hold.reason };
  }, S);
  await reload();
  results.loadAfter = await page.evaluate(DAY => {
    const o2 = db.orders.o2, L = id => findLine(o2, id);
    const w = shopWorkload(DAY);
    const tz = techWorkload('Zack', DAY), tm = techWorkload('Marco', DAY);
    const m = shopMetrics('2000-01-01', '2100-12-31');
    return { hold: L('tE').hold, holdHistory: (L('tE').holdHistory || []).length, bucketE: jobBucket(o2, L('tE')),
             floor: floorOrders().map(o => o.id), w, tz, tm, comebacks: m.comebacks, qcFailures: m.qcFailures, column: boardColumn(o2),
             delivered: !!db.orders.o1.deliveredAt, o1bay: db.orders.o1.bay };
  }, DAY);
  const Ld = results.load, LA = results.loadAfter;
  check('34. parts readiness reads procurement and the shelf',
    Ld.ready.brakesFromStock === 'ALL PARTS READY' && Ld.ready.noParts === 'NO PARTS REQUIRED' && Ld.ready.uJoints === 'WAITING PARTS' &&
    Ld.ready.trackBar === 'ALL PARTS READY' && Ld.ready.rotorNoStock === 'PARTIAL PARTS' && Ld.ready.rotorStocked === 'ALL PARTS READY',
    JSON.stringify(Ld.ready));
  check('35. a hold reason persists with its note and history',
    LA.hold && LA.hold.reason === 'Waiting Customer' && LA.hold.note === 'call back about hitch' && LA.holdHistory === 1 && LA.bucketE === 'waiting',
    JSON.stringify(LA.hold));
  check('36. ready sold hours add up (track bar 2.0)', LA.floor.join() === 'o2' && near(LA.w.soldReady, 2.0) && LA.w.jobsReady === 1, JSON.stringify(LA.w));
  check('37. in-progress sold hours add up (stabilizer 1.5)', near(LA.w.soldInProgress, 1.5) && LA.w.jobsInProgress === 1 && LA.column === 'IN PROGRESS', JSON.stringify(LA.w));
  check('38. waiting-parts and awaiting-approval sold hours add up (U-joints 0.7, ball joints 1.1)',
    near(LA.w.soldWaitingParts, 0.7) && near(LA.w.soldAwaitingApproval, 1.1) && near(LA.w.soldWaitingOther, 0.4) && LA.w.jobsWaiting === 3 &&
    near(LA.w.soldCompletedToday, 10.8) && LA.w.vehicles === 1, JSON.stringify(LA.w));
  check('39. each technician workload adds up on its own',
    near(LA.tm.ready, 2.0) && near(LA.tm.waiting, 1.8) && near(LA.tm.active, 0) && near(LA.tm.completedToday, 2.8) && LA.tm.jobsParts === 1 &&
    near(LA.tz.active, 1.5) && near(LA.tz.waiting, 0.4) && near(LA.tz.completedToday, 8.0) && LA.tz.current && LA.tz.current.lineId === 'tB' &&
    near(LA.tz.assigned, 1.9) && near(LA.tm.assigned, 3.8), JSON.stringify([LA.tz, LA.tm].map(x => Object.assign({}, x, { jobs: x.jobs.length }))));
  check('40. the comeback count is right', LA.comebacks === 1, String(LA.comebacks));
  check('41. the QC failure count is right', LA.qcFailures === 1, String(LA.qcFailures));

  /* ---- the floor screens draw without throwing ---- */
  results.screens = await page.evaluate(() => {
    const seen = {};
    ['board', 'bays', 'dispatch', 'queue', 'production'].forEach(t => { floorTab = t; go('board'); seen[t] = document.getElementById('app').innerText.length; });
    floorTab = 'board'; go('board');
    const boardText = document.getElementById('app').innerText;
    openVehicle('m3');
    const vehText = document.getElementById('app').innerText;
    editOrder('o2');
    const sheet = document.getElementById('woSheet').innerText;
    openQC('o2', 'tA'); closeRec();
    openRoadTest('o2', 'Pre-Repair'); closeRec();
    openTorque('o2', 'tA'); closeRec();
    openRefs('o2', 'tA'); closeRec();
    openMeasurement('o2'); closeRec();
    closeWO();
    go('settings');
    const settings = document.getElementById('app').innerText;
    go('dash');
    return { seen, board: ['CHECKED IN', 'IN PROGRESS', 'READY FOR PICKUP'].every(c => boardText.indexOf(c) >= 0),
             veh: /Maintenance/.test(vehText) && /Technical timeline/.test(vehText) && /Installed parts/.test(vehText) && /REPEATED CONCERN/.test(vehText),
             sheet: /On the floor/.test(sheet) && /PAUSE|RESUME|START/.test(sheet), settings: /maintenance intervals/i.test(settings) };
  });
  const Sc = results.screens;

  /* ---- 42..46. backup, restore, and nothing earlier moving ---- */
  results.backup = await page.evaluate(async () => {
    const count = () => ({
      sessions: db.timeSessions.length, qc: Object.keys(db.qcRecords).length, road: Object.keys(db.roadTests).length,
      dx: Object.values(db.diagnostics).reduce((s, d) => s + d.measurements.length + d.dtcs.length, 0), root: Object.values(db.diagnostics)[0].rootCause,
      cb: JSON.stringify(Object.values(db.comebacks)), installed: installedParts('m3').length,
      maint: JSON.stringify([db.maintenance, db.settings.maintItems.map(m => [m.miles, m.months])]),
      history: findLine(db.orders.o1, 'lTh').stateHistory.length, hold: (findLine(db.orders.o2, 'tE').hold || {}).reason,
      bay: db.orders.o2.bay, clockZack: techProduction('Zack', '2026-09-12', '2026-09-12').clock,
      insp: db.inspections.inspOld.items['tires.tire.RR'].meas.tread, att: Object.keys(db.attachments).length,
      appt: db.appointments.aOld.requested.length, parts: Object.keys(db.parts).length, pos: Object.keys(db.purchaseOrders).length,
      moves: db.movements.length, onHand: Object.values(db.parts).reduce((s, p) => s + (Number(p.onHand) || 0), 0),
      invOld: orderTotals(db.orders.oOld).total, invA: orderTotals(db.orders.oA).total, oA: JSON.stringify(db.orders.oA)
    });
    const before = count();
    const built = await buildBackup();
    const pkg = JSON.stringify(built.pkg);
    db = shapeDb(JSON.parse(JSON.stringify(DEFAULT)));
    const wiped = db.timeSessions.length + Object.keys(db.qcRecords).length + Object.keys(db.comebacks).length;
    await restoreBackupPackage(JSON.parse(pkg));
    return { before, after: count(), wiped };
  });
  const Bk = results.backup;
  const same = k => JSON.stringify(Bk.before[k]) === JSON.stringify(Bk.after[k]);
  check('42. a backup restores time sessions, QC, road tests, diagnosis, comebacks, installed parts and maintenance',
    Bk.wiped === 0 && ['sessions', 'qc', 'road', 'dx', 'root', 'cb', 'installed', 'maint', 'history', 'hold', 'bay', 'clockZack'].every(same) &&
    Bk.before.sessions === 10 && near(Bk.after.clockZack, 7.0), JSON.stringify(Bk));
  check('43. the inspection and the photographs still come back', same('insp') && same('att') && Bk.after.insp === '3' && Bk.after.att === 1, JSON.stringify(Bk.after));
  check('44. the appointments still come back', same('appt') && Bk.after.appt === 1, JSON.stringify(Bk.after));
  check('45. the stock, purchase orders and movements still come back', same('parts') && same('pos') && same('moves') && same('onHand') && Bk.after.pos === 1,
    JSON.stringify(Bk.after));
  check('46. the historical invoices are exactly what they were',
    near(Bk.after.invOld, 68.37) && near(Bk.after.invA, S.invoiceA) && near(S.invoiceOld, 68.37) && Bk.after.oA === S.oAjson && same('oA'),
    JSON.stringify([Bk.after.invOld, Bk.after.invA, S.invoiceA]));

  check('47. every floor screen and sheet draws, and nothing threw during any of it',
    Sc.board && Sc.veh && Sc.sheet && Sc.settings && Object.values(Sc.seen).every(n => n > 50) && pageErrors.length === 0,
    JSON.stringify(Sc) + ' ' + pageErrors.join(' | '));

  await browser.close();
  console.log('');
  Object.keys(results).filter(k => typeof results[k] === 'string').forEach(k => console.log(' ' + results[k].slice(0, 300).padEnd(6) + ' ' + k));
  if (failures.length) {
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f.slice(0, 1500)));
    process.exit(1);
  }
  console.log('\nALL SHOP-FLOOR OPERATIONS CHECKS PASSED');
})();
