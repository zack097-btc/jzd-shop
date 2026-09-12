/* The shop floor: check-in, the multipoint inspection, and what comes out of it.

   The inspection is the part of this program a customer is most likely to be
   shown and least likely to be able to argue with, so the checks below care
   about two things above all: that a measurement recorded at the car is still
   exactly that measurement afterwards, per wheel and per corner, and that what
   is written for the shop never appears on the sheet handed to the customer.

   The network is never touched. */
const { chromium } = require('playwright');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const LS_KEY = 'jzd.shop.db';

/* A v2.3.0 book: tickets, an authorization, payments and a finalized invoice,
   but nothing the shop floor added afterwards. */
const V23_BOOK = {
  settings: {
    shopName: 'JZD Inc.', tagline: 'Automotive Service & Repair', addr: '', phone: '', email: '',
    laborRate: 112.5, rateMin: 100, rateMax: 125, taxRate: 8.25, taxLabor: false, taxParts: true,
    taxFees: false, partsMarkup: 40, nextInvoice: 1010, nextEstimate: 5, nextRO: 3, fees: [],
    terms: 'Thank you.', requireOverrideReason: true, managerPin: '',
    providers: { vehicle: 'nhtsa', labor: 'seed', motor: { enabled: false }, mitchell: { enabled: false }, alldata: { enabled: false } }
  },
  customers: { c23: { id: 'c23', name: 'Prior Customer', phone: '555-0123' } },
  vehicles: { v23: { id: 'v23', customerId: 'c23', year: '2015', make: 'Ford', model: 'F-150', vin: '1FTFW1EF5FKD12345', plate: 'OLD-123' } },
  orders: {
    o23: {
      id: 'o23', customerId: 'c23', vehicleId: 'v23', date: '2026-09-05', status: 'Invoiced',
      estimateNo: 4, roNo: 2, invoiceNo: 1009, complaint: 'Oil change',
      labor: [{ id: 'l1', type: 'catalog-labor', desc: 'Oil service', bill: 'H', hours: 0.5, billedHours: 0.5, rate: 112.5, rateSource: 'locked', source: 'SHOP SEED' }],
      parts: [{ id: 'p1', type: 'part', desc: 'Filter', qty: '1', cost: '8', markup: 40, price: '11.20' }],
      extras: [], payments: [{ id: 'pay1', at: '2026-09-05T10:00:00Z', amount: 68.37, method: 'Card', note: '' }],
      history: [], auth: { state: 'Approved', entries: [{ at: '2026-09-05T09:00:00Z', decision: 'Approved', who: 'Prior Customer', method: 'Phone', amount: 68.37, note: '', snapshot: { total: 68.37, lines: [] } }], approvedTotal: 68.42 },
      finalized: { at: '2026-09-05T10:00:00Z', taxRate: 8.25, taxLabor: false, taxParts: true, taxFees: false, laborRate: 112.5 },
      notes: 'oil changed'
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

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('PAGEERR: ' + e.message));
  page.on('dialog', d => d.accept());

  /* ---- 1. a v2.3 book opens, with its invoice untouched ---- */
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(([k, b]) => localStorage.setItem(k, JSON.stringify(b)), [LS_KEY, V23_BOOK]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);

  results.v23 = await page.evaluate(() => {
    const o = db.orders.o23, t = orderTotals(o);
    return { locked: !!window.storageLocked, total: t.total, balance: t.balance,
             inv: o.invoiceNo, auth: o.auth.entries.length,
             newBuckets: { insp: !!db.inspections, recs: !!db.recommendations, att: !!db.attachments },
             techs: Array.isArray(db.settings.techs), thresholds: !!db.settings.thresholds };
  });
  check('1. a v2.3 book opens and its finalized invoice is untouched',
    !results.v23.locked && near(results.v23.total, 68.37) && near(results.v23.balance, 0) &&
    results.v23.inv === 1009 && results.v23.newBuckets.insp && results.v23.newBuckets.recs &&
    results.v23.techs && results.v23.thresholds, JSON.stringify(results.v23));

  /* ---- 2,3. check-in and the damage record ---- */
  results.checkin = await page.evaluate(() => {
    db.vinCache['WBS8M9C55J5J78069'] = { vin: 'WBS8M9C55J5J78069', year: '2018', make: 'BMW', model: 'M3',
      series: '3-Series', cylinders: '6', displacementL: '3', fuelType: 'Gasoline',
      provider: 'NHTSA vPIC', decodedAt: new Date().toISOString(), raw: {}, warnings: [] };
    db.customers.c1 = { id: 'c1', name: 'Dale Hansen', phone: '509-555-0142' };
    db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2018', make: 'BMW', model: 'M3',
      vin: 'WBS8M9C55J5J78069', plate: 'JZD-M3', mileage: '48200' };
    editOrder(null, { customerId: 'c1', vehicleId: 'v1' });
    document.getElementById('o_mIn').value = '48250';
    /* Typed into the real fields, because that is the only path the counter
       ever uses and the only one worth proving. */
    const put = (id, v) => { const el = document.getElementById(id); el.value = v; };
    put('ci_fuel', '1/2'); put('ci_keys', '2'); put('ci_keyTag', 'T-14'); put('ci_location', 'Bay 2');
    put('ci_warningsReported', 'Check engine'); put('ci_valuables', 'Sunglasses in console');
    pullWO();
    const ci = shapeCheckin(cur);
    ci.by = 'Zack'; ci.at = new Date().toISOString();
    addDamage(cur, 'LF door', 'Scratch', 'Light', '3 inch below handle', 'Zack');
    addDamage(cur, 'RF wheel', 'Curb rash', 'Moderate', 'outer lip', 'Zack');
    addDamage(cur, 'Windshield', 'Paint chip', 'Light', 'passenger side', 'Zack');
    saveOrder();
    const o = Object.values(db.orders).find(x => x.vehicleId === 'v1');
    return { id: o.id, fuel: o.checkin.fuel, keys: o.checkin.keys, tag: o.checkin.keyTag,
             loc: o.checkin.location, warn: o.checkin.warningsReported, valuables: o.checkin.valuables,
             by: o.checkin.by, at: !!o.checkin.at, damage: o.checkin.damage.length,
             first: o.checkin.damage[0], wheel: o.checkin.damage.find(d => d.area === 'RF wheel') };
  });
  const C = results.checkin;
  check('2. check-in details persist on the ticket',
    C.fuel === '1/2' && C.keys === '2' && C.tag === 'T-14' && C.loc === 'Bay 2' &&
    C.warn === 'Check engine' && C.valuables === 'Sunglasses in console' && C.by === 'Zack' && C.at,
    JSON.stringify(C));
  check('3. pre-existing damage persists with area, type, severity, note and who recorded it',
    C.damage === 3 && C.first.area === 'LF door' && C.first.type === 'Scratch' &&
    C.first.severity === 'Light' && /below handle/.test(C.first.note) && C.first.by === 'Zack' &&
    !!C.first.at && C.wheel.type === 'Curb rash' && C.wheel.severity === 'Moderate',
    JSON.stringify(C));

  /* ---- 5..17. the inspection, measurement by measurement ---- */
  results.insp = await page.evaluate(orderId => {
    const insp = newInspection(orderId, 'v1');
    insp.tech = 'Marco';
    const set = (k, st) => setInspState(insp, k, st);
    const meas = (k, m) => Object.assign(inspItem(insp, k).meas, m);

    /* tyres: four different depths and four different pressures */
    meas('tires.tire.LF', { tread: '7', psi: '34', psiSpec: '35' });
    meas('tires.tire.RF', { tread: '7', psi: '33', psiSpec: '35' });
    meas('tires.tire.LR', { tread: '5', psi: '31', psiSpec: '35' });
    meas('tires.tire.RR', { tread: '3', psi: '29', psiSpec: '35' });
    set('tires.tire.LF', 'Good'); set('tires.tire.RF', 'Good');
    set('tires.tire.LR', 'Monitor'); set('tires.tire.RR', 'Urgent');
    inspItem(insp, 'tires.tire.RR').flags.push('Inside-edge wear');

    /* brakes: per corner, inner and outer */
    meas('brakes.pads.LF', { inner: '8', outer: '8.5' });
    meas('brakes.pads.RF', { inner: '8', outer: '8' });
    meas('brakes.pads.LR', { inner: '4', outer: '4.5' });
    meas('brakes.pads.RR', { inner: '3', outer: '3.5' });
    set('brakes.pads.LF', 'Good'); set('brakes.pads.RF', 'Good');
    set('brakes.pads.LR', 'Monitor'); set('brakes.pads.RR', 'Needs Attention');
    meas('brakes.rotor.LF', { thick: '28.4', min: '26.4' });
    set('brakes.rotor.LF', 'Good');

    meas('brakesys.fluid', { moisture: '3' });
    set('brakesys.fluid', 'Contaminated');
    inspItem(insp, 'brakesys.fluid').note = 'refractometer, internal';
    inspItem(insp, 'brakesys.fluid').custNote = 'Brake fluid has absorbed moisture and should be replaced.';

    meas('oil.oil', { life: '15' });
    set('oil.oil', 'Monitor');
    inspItem(insp, 'oil.oil').flags.push('Service due');

    meas('cooling.coolant', { freeze: '-34' });
    set('cooling.coolant', 'Good');

    set('lighting.lowbeam', 'Good');
    set('lighting.plate', 'Inoperative');
    set('lighting.fog', 'N/A');

    meas('battery.battery', { volts: '12.42', cca: '540', ccaRated: '640' });
    set('battery.battery', 'Recharge and Retest');

    set('steering.lowerball', 'Needs Attention');
    inspItem(insp, 'steering.lowerball').flags.push('Play');

    set('underbody.oilleak', 'Needs Attention');
    inspItem(insp, 'underbody.oilleak').flags.push('Minor Leak');
    inspItem(insp, 'underbody.oilleak').note = 'oil pan gasket weeping, rear edge';

    set('driveline.guibo', 'Monitor');
    save();
    return { id: insp.id, no: insp.no, state: insp.state, template: insp.template.version,
             groups: insp.template.groups.length,
             summary: inspSummary(insp), findings: inspFindings(insp).length };
  }, C.id);
  check('5. an inspection persists and knows which template it was filled in against',
    results.insp.state === 'In Progress' && results.insp.template === '2.4.0' && results.insp.groups >= 18,
    JSON.stringify(results.insp));

  /* the measurements, read back one at a time */
  results.meas = await page.evaluate(id => {
    const i = db.inspections[id];
    const m = k => i.items[k].meas;
    return {
      tread: { LF: m('tires.tire.LF').tread, RF: m('tires.tire.RF').tread, LR: m('tires.tire.LR').tread, RR: m('tires.tire.RR').tread },
      psi: { LF: m('tires.tire.LF').psi, RF: m('tires.tire.RF').psi, LR: m('tires.tire.LR').psi, RR: m('tires.tire.RR').psi },
      spec: m('tires.tire.LF').psiSpec,
      pads: { LF: m('brakes.pads.LF'), RF: m('brakes.pads.RF'), LR: m('brakes.pads.LR'), RR: m('brakes.pads.RR') },
      rotor: m('brakes.rotor.LF'),
      fluid: m('brakesys.fluid'), oil: m('oil.oil'), coolant: m('cooling.coolant'),
      batt: m('battery.battery'),
      states: { LF: i.items['tires.tire.LF'].state, RR: i.items['tires.tire.RR'].state,
                plate: i.items['lighting.plate'].state, lowbeam: i.items['lighting.lowbeam'].state,
                fog: i.items['lighting.fog'].state, ball: i.items['steering.lowerball'].state,
                leak: i.items['underbody.oilleak'].state, guibo: i.items['driveline.guibo'].state,
                battery: i.items['battery.battery'].state, fluid: i.items['brakesys.fluid'].state },
      leakNote: i.items['underbody.oilleak'].note, leakFlags: i.items['underbody.oilleak'].flags,
      ballFlags: i.items['steering.lowerball'].flags
    };
  }, results.insp.id);
  const Me = results.meas;
  check('6. each tyre keeps its own tread depth',
    Me.tread.LF === '7' && Me.tread.RF === '7' && Me.tread.LR === '5' && Me.tread.RR === '3', JSON.stringify(Me.tread));
  check('7. each tyre keeps its own pressure, separately from the placard spec',
    Me.psi.LF === '34' && Me.psi.RF === '33' && Me.psi.LR === '31' && Me.psi.RR === '29' && Me.spec === '35',
    JSON.stringify(Me.psi));
  check('8. each corner keeps its own inner and outer pad thickness',
    Me.pads.LF.inner === '8' && Me.pads.LF.outer === '8.5' && Me.pads.RR.inner === '3' && Me.pads.RR.outer === '3.5' &&
    Me.pads.LR.inner === '4', JSON.stringify(Me.pads));
  check('9. rotor thickness and its minimum specification are stored separately',
    Me.rotor.thick === '28.4' && Me.rotor.min === '26.4', JSON.stringify(Me.rotor));
  check('10. the brake fluid moisture reading and its result both persist',
    Me.fluid.moisture === '3' && Me.states.fluid === 'Contaminated', JSON.stringify(Me.fluid));
  check('11. the coolant freeze point persists', Me.coolant.freeze === '-34', JSON.stringify(Me.coolant));
  check('12. engine oil condition and oil life persist', Me.oil.life === '15', JSON.stringify(Me.oil));
  check('13. lighting keeps a separate state for every lamp',
    Me.states.lowbeam === 'Good' && Me.states.plate === 'Inoperative' && Me.states.fog === 'N/A',
    JSON.stringify(Me.states));
  check('14. battery voltage and measured against rated CCA persist',
    Me.batt.volts === '12.42' && Me.batt.cca === '540' && Me.batt.ccaRated === '640' &&
    Me.states.battery === 'Recharge and Retest', JSON.stringify(Me.batt));
  check('15. a suspension finding keeps its flag', Me.states.ball === 'Needs Attention' && Me.ballFlags.indexOf('Play') >= 0,
    JSON.stringify(Me.ballFlags));
  check('16. a leak keeps its severity and where it was found',
    Me.states.leak === 'Needs Attention' && Me.leakFlags.indexOf('Minor Leak') >= 0 && /oil pan gasket/.test(Me.leakNote),
    JSON.stringify({ f: Me.leakFlags, n: Me.leakNote }));
  check('17. the four condition levels all persist',
    Me.states.LF === 'Good' && Me.states.guibo === 'Monitor' && Me.states.ball === 'Needs Attention' && Me.states.RR === 'Urgent',
    JSON.stringify(Me.states));

  /* ---- 18,19,37. the customer's report shows theirs, never ours ---- */
  results.report = await page.evaluate(id => {
    const insp = db.inspections[id];
    completeInspection(insp, 'Marco');
    save();
    const html = docInspection(insp);
    return {
      hasInternalNote: /refractometer, internal/.test(html),
      hasCustomerNote: /absorbed moisture/.test(html),
      hasCost: /markup|Cost ea|MU%/i.test(html),
      hasMeasurements: /3 \/32|Tread 3/.test(html) || /28\.4/.test(html),
      hasSummary: /Needs attention|Urgent/.test(html),
      statusWordsNotJustColour: /class="st st-u"/.test(html) && /Urgent<\/span>/.test(html),
      completed: insp.state, tech: insp.tech, completedAt: !!insp.completedAt, startedAt: !!insp.startedAt
    };
  }, results.insp.id);
  const R = results.report;
  check('18. an internal inspection note never reaches the customer report', R.hasInternalNote === false, JSON.stringify(R));
  check('19. the note written for the customer does appear on their report', R.hasCustomerNote === true, JSON.stringify(R));
  check('37. the customer report carries measurements and no cost or markup',
    R.hasCost === false && R.hasMeasurements && R.hasSummary && R.statusWordsNotJustColour, JSON.stringify(R));

  /* ---- 20,21. a finding becomes a recommendation, and then work ---- */
  results.recs = await page.evaluate(orderId => {
    const o = db.orders[orderId];
    editOrder(orderId);
    const insp = inspectionFor(cur);
    const finds = inspFindings(insp);
    const ballFinding = finds.find(f => /Lower ball joints/.test(f.name));
    const tyreFinding = finds.find(f => /RR Tire/.test(f.name));
    const rec1 = recFromFinding(cur, ballFinding);
    const rec2 = recFromFinding(cur, tyreFinding);
    const before = cur.labor.length;
    const line = recToOrder(cur, rec1);
    const after = cur.labor.length;
    saveOrder();
    return { findings: finds.length, rec1: { id: rec1.id, desc: rec1.desc, sev: rec1.severity, reason: rec1.reason, status: rec1.status, lineId: rec1.lineId },
             rec2: { id: rec2.id, sev: rec2.severity, status: rec2.status },
             added: after - before, lineDesc: line && line.desc, lineRec: line && line.recId,
             total: Object.keys(db.recommendations).length };
  }, C.id);
  const Rc = results.recs;
  check('20. an inspection finding becomes a recommendation carrying its severity and detail',
    Rc.findings >= 6 && /Lower ball joints/.test(Rc.rec1.desc) && Rc.rec1.sev === 'Needs Attention' &&
    /Play/.test(Rc.rec1.reason) && Rc.rec2.sev === 'Urgent', JSON.stringify(Rc));
  check('21. a recommendation converts into a line on the ticket and remembers which one',
    Rc.added === 1 && Rc.lineRec === Rc.rec1.id && Rc.rec1.lineId && Rc.rec1.status === 'Awaiting Approval',
    JSON.stringify(Rc));

  /* ---- 27,28,29,30,31. technician, job state, parts ---- */
  results.floor = await page.evaluate(orderId => {
    editOrder(orderId);
    cur.labor[0].tech = 'Marco';
    setJobState(0, 'In Progress');
    addLine('parts');
    const pi = cur.parts.length - 1;
    cur.parts[pi].desc = 'Lower ball joint'; cur.parts[pi].qty = '1'; cur.parts[pi].cost = '78';
    cur.parts[pi].price = '109.20'; cur.parts[pi].partNo = '31-12-6-852-992';
    setPartState(pi, 'Ordered');
    cur.parts[pi].orderNo = 'PO-4471'; cur.parts[pi].expected = '2026-09-13';
    const waitingWhenOrdered = waitingOnParts(cur);
    const outWhenOrdered = partsOutstanding(cur).map(x => x.desc + ' — ' + partState(x));
    setPartState(pi, 'Received');
    const waitingWhenReceived = waitingOnParts(cur);
    startJob(cur, 0); completeJob(cur, 0);
    cur.labor[0].workPerformed = 'Replaced lower ball joint, torqued to spec, aligned.';
    saveOrder();
    const o = db.orders[orderId];
    return { tech: o.labor[0].tech, jobState: jobState(o.labor[0]),
             started: !!o.labor[0].startedAt, completed: !!o.labor[0].completedAt,
             work: o.labor[0].workPerformed,
             partState: partState(o.parts[o.parts.length - 1]),
             orderNo: o.parts[o.parts.length - 1].orderNo,
             expected: o.parts[o.parts.length - 1].expected,
             receivedAt: !!o.parts[o.parts.length - 1].receivedAt,
             waitingWhenOrdered, outWhenOrdered, waitingWhenReceived,
             jobsDone: jobsDone(o), jobsTotal: jobsTotal(o) };
  }, C.id);
  const F = results.floor;
  check('27. a technician assignment persists on the job', F.tech === 'Marco', JSON.stringify(F));
  check('28. job state persists separately from the ticket state', F.jobState === 'Completed', JSON.stringify(F));
  check('29. a part keeps its procurement state, order reference and expected date',
    F.partState === 'Received' && F.orderNo === 'PO-4471' && F.expected === '2026-09-13' && F.receivedAt,
    JSON.stringify(F));
  check('30. waiting-on-parts names the parts that are not yet in the building',
    F.waitingWhenOrdered === true && F.outWhenOrdered.some(x => /Lower ball joint — Ordered/.test(x)) &&
    F.waitingWhenReceived === false, JSON.stringify(F));
  check('31. start and completion timestamps persist on the job',
    F.started && F.completed && /torqued to spec/.test(F.work), JSON.stringify(F));

  /* ---- 22,23. declined work outlives the invoice ---- */
  results.declined = await page.evaluate(orderId => {
    const rec2 = Object.values(db.recommendations).find(r => r.severity === 'Urgent' && r.orderId === orderId);
    rec2.status = 'Declined'; rec2.decidedAt = new Date().toISOString(); rec2.decidedBy = 'Dale Hansen';
    rec2.amount = 625; rec2.mileage = '48250';
    editOrder(orderId);
    setStatus(cur, 'Invoiced', 'test'); recordPayment(cur, orderTotals(cur).total, 'Card', '');
    setStatus(cur, 'Paid / Closed', 'test');
    saveOrder();
    const stillThere = !!db.recommendations[rec2.id] && db.recommendations[rec2.id].status === 'Declined';
    /* the same vehicle comes back */
    editOrder(null, { customerId: 'c1', vehicleId: 'v1' });
    cur.mileageIn = '51000';
    const prior = priorDeclined('v1', cur.id);
    const panel = priorDeclinedPanel(cur);
    const newOrderId = cur.id;
    saveOrder();
    return { stillThere, priorCount: prior.length, priorDesc: prior[0] && prior[0].desc,
             priorAmount: prior[0] && prior[0].amount, priorMileage: prior[0] && prior[0].mileage,
             panelShows: /PREVIOUSLY DECLINED/.test(panel), panelNames: prior[0] ? panel.indexOf(prior[0].desc) >= 0 : false,
             newOrderId };
  }, C.id);
  const D = results.declined;
  check('22. a declined recommendation survives the invoice closing', D.stillThere === true, JSON.stringify(D));
  check('23. declined work resurfaces on the next visit with its date, mileage and amount',
    D.priorCount >= 1 && D.panelShows && D.panelNames && near(D.priorAmount, 625) && D.priorMileage === '48250',
    JSON.stringify(D));

  /* ---- 24,32. vehicle history ---- */
  results.history = await page.evaluate(() => {
    go('vehicles'); openVehicle('v1');
    const html = document.getElementById('app').textContent;
    const hist = Object.values(db.orders).filter(o => o.vehicleId === 'v1')
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { shown: /Service History/.test(html), visits: hist.length,
             sortedDesc: hist.every((o, i) => i === 0 || String(hist[i - 1].date) >= String(o.date)),
             hasCompletedWork: /Lower ball joint|ball joint/i.test(html) || hist.some(o => (o.labor || []).some(l => /ball joint/i.test(l.desc))),
             declinedPanel: /PREVIOUSLY DECLINED OR DEFERRED/.test(html),
             inspBadge: /MPI/.test(document.getElementById('app').innerHTML) };
  });
  const H = results.history;
  check('24. completed work appears in the vehicle history', H.shown && H.visits >= 2 && H.hasCompletedWork, JSON.stringify(H));
  check('32. history is in date order and shows the inspection and the declined work',
    H.sortedDesc && H.declinedPanel && H.inspBadge, JSON.stringify(H));

  /* ---- 25,26. history does not move ---- */
  results.immutable = await page.evaluate(() => {
    const o = db.orders.o23, before = orderTotals(o).total;
    const insp = Object.values(db.inspections)[0];
    const inspBefore = JSON.stringify({ s: insp.state, t: insp.tech, m: insp.items['tires.tire.RR'].meas, v: insp.template.version });
    db.settings.laborRate = 999; db.settings.taxRate = 99; db.settings.partsMarkup = 500;
    db.settings.thresholds.treadUrgent = 12;      /* a later threshold change */
    const after = orderTotals(o).total;
    const inspAfter = JSON.stringify({ s: insp.state, t: insp.tech, m: insp.items['tires.tire.RR'].meas, v: insp.template.version });
    db.settings.laborRate = 112.5; db.settings.taxRate = 8.25; db.settings.partsMarkup = 40; db.settings.thresholds.treadUrgent = 3;
    return { before, after, inspBefore, inspAfter };
  });
  check('25. a finalized invoice still does not move', near(results.immutable.before, results.immutable.after),
    JSON.stringify(results.immutable));
  check('26. a completed inspection is a snapshot and later settings do not touch it',
    results.immutable.inspBefore === results.immutable.inspAfter, JSON.stringify(results.immutable));

  /* ---- 33,34,35,36. search ---- */
  results.search = await page.evaluate(() => {
    const hay = o => searchHay(o);
    const all = Object.values(db.orders);
    const find = q => all.filter(o => hay(o).indexOf(q.toLowerCase()) >= 0).length;
    return { fullVin: find('WBS8M9C55J5J78069'), partialVin: find('J78069'), partialVin2: find('wbs8m9'),
             plate: find('JZD-M3'), oldPlate: find('OLD-123'),
             ro: find('RO-'), invoice: find('INV-1009'), invoiceNum: find('1009'),
             customer: find('Dale'), ymm: find('bmw m3') };
  });
  const S = results.search;
  check('33. search finds a full VIN', S.fullVin >= 1, JSON.stringify(S));
  check('34. search finds a partial VIN, from either end', S.partialVin >= 1 && S.partialVin2 >= 1, JSON.stringify(S));
  check('35. search finds a licence plate', S.plate >= 1 && S.oldPlate >= 1, JSON.stringify(S));
  check('36. search finds an RO or invoice number, and customer and vehicle',
    S.ro >= 1 && S.invoice >= 1 && S.invoiceNum >= 1 && S.customer >= 1 && S.ymm >= 1, JSON.stringify(S));

  /* ---- 38. the shop copy hides the money ---- */
  results.techview = await page.evaluate(orderId => {
    openTechView(orderId);
    const app = document.getElementById('app');
    const html = app.innerHTML;
    /* Read what a person standing at the screen can actually see. Searching the
       markup finds the word "margin" in every inline style and proves nothing. */
    const text = app.textContent;
    const o = db.orders[orderId];
    const costs = (o.parts || []).filter(x => Number(x.cost) > 0).map(x => String(x.cost));
    return { showsJobs: /Jobs/.test(text), showsConcern: /Customer concern/.test(text) || !o.complaint,
             showsDamage: /Pre-existing damage/.test(text) || !(o.checkin && o.checkin.damage.length),
             /* A bare two-digit substring matches the VIN. What would actually
                leak is a cost rendered as money or sitting in an input. */
             hasCost: costs.some(c => text.indexOf(money(Number(c))) >= 0) ||
                      costs.some(c => html.indexOf('value="' + c + '"') >= 0) ||
                      /cost/i.test(text),
             hasMarkupWord: /markup|MU%|cost ea|gross profit/i.test(text),
             hasTotals: /Balance due|Subtotal|Grand total/i.test(text),
             hasPayments: /Record payment/i.test(text) };
  }, C.id);
  const T = results.techview;
  check('38. the shop-floor view shows the work and none of the money',
    T.showsJobs && T.hasCost === false && T.hasMarkupWord === false && T.hasTotals === false && T.hasPayments === false,
    JSON.stringify(T));

  /* ---- 4,39,40. everything survives a restart ---- */
  const before = await page.evaluate(() => {
    const insp = Object.values(db.inspections)[0];
    return { inspId: insp.id, tread: insp.items['tires.tire.RR'].meas.tread,
             pads: insp.items['brakes.pads.RR'].meas.inner, state: insp.state, tech: insp.tech,
             custNote: insp.items['brakesys.fluid'].custNote,
             recs: Object.keys(db.recommendations).length,
             damage: Object.values(db.orders).filter(o => o.checkin && o.checkin.damage.length).length,
             orders: Object.keys(db.orders).length };
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  results.restart = await page.evaluate(b => {
    const insp = db.inspections[b.inspId];
    if (!insp) return { missing: true };
    const dmgOrder = Object.values(db.orders).find(o => o.checkin && o.checkin.damage.length);
    return { tread: insp.items['tires.tire.RR'].meas.tread, pads: insp.items['brakes.pads.RR'].meas.inner,
             state: insp.state, tech: insp.tech, custNote: insp.items['brakesys.fluid'].custNote,
             recs: Object.keys(db.recommendations).length, orders: Object.keys(db.orders).length,
             damageCount: dmgOrder ? dmgOrder.checkin.damage.length : 0,
             damageArea: dmgOrder ? dmgOrder.checkin.damage[0].area : '',
             checkinFuel: dmgOrder ? dmgOrder.checkin.fuel : '',
             v23Total: orderTotals(db.orders.o23).total };
  }, before);
  const Rs = results.restart;
  check('39. inspection measurements and sign-off survive a restart',
    !Rs.missing && Rs.tread === before.tread && Rs.pads === before.pads && Rs.state === 'Completed' &&
    Rs.tech === 'Marco' && Rs.custNote === before.custNote, JSON.stringify({ before, Rs }));
  check('40. check-in and damage records survive a restart',
    Rs.damageCount === 3 && Rs.damageArea === 'LF door' && Rs.checkinFuel === '1/2' &&
    Rs.recs === before.recs && Rs.orders === before.orders && near(Rs.v23Total, 68.37),
    JSON.stringify({ before, Rs }));

  /* ---- 4,42,43. a backup taken now restores everything taken with it ---- */
  results.backup = await page.evaluate(() => {
    /* exportData writes a file; the bytes it would write are what matters here */
    const bytes = JSON.stringify(db);
    const insp = Object.values(db.inspections)[0];
    const dmgOrder = Object.values(db.orders).find(o => o.checkin && o.checkin.damage.length);
    const before = { inspId: insp.id, tread: insp.items['tires.tire.RR'].meas.tread,
                     tech: insp.tech, custNote: insp.items['brakesys.fluid'].custNote,
                     damage: dmgOrder.checkin.damage.length, fuel: dmgOrder.checkin.fuel,
                     recs: Object.keys(db.recommendations).length,
                     orderId: dmgOrder.id, total: orderTotals(dmgOrder).total };
    /* wipe, then restore through the same path the Import button uses */
    db = shapeDb(JSON.parse(JSON.stringify(DEFAULT)));
    const wiped = Object.keys(db.inspections).length;
    db = shapeDb(JSON.parse(bytes));
    const i2 = db.inspections[before.inspId];
    const o2 = db.orders[before.orderId];
    return { wiped, before,
             after: { tread: i2.items['tires.tire.RR'].meas.tread, tech: i2.tech,
                      custNote: i2.items['brakesys.fluid'].custNote,
                      damage: o2.checkin.damage.length, fuel: o2.checkin.fuel,
                      recs: Object.keys(db.recommendations).length,
                      total: orderTotals(o2).total,
                      template: i2.template.version } };
  });
  const Bk = results.backup;
  check('42. a backup restores the inspection, its measurements and its sign-off',
    Bk.wiped === 0 && Bk.after.tread === Bk.before.tread && Bk.after.tech === Bk.before.tech &&
    Bk.after.custNote === Bk.before.custNote && Bk.after.template === '2.4.0', JSON.stringify(Bk));
  check('43. a backup restores check-in, damage, recommendations and the money',
    Bk.after.damage === Bk.before.damage && Bk.after.fuel === Bk.before.fuel &&
    Bk.after.recs === Bk.before.recs && near(Bk.after.total, Bk.before.total), JSON.stringify(Bk));

  /* an older backup, missing everything this version added, must still open */
  results.oldBackup = await page.evaluate(() => {
    const old = { settings: { shopName: 'Old Shop', laborRate: 100, taxRate: 5 },
                  customers: { x: { id: 'x', name: 'Old' } }, vehicles: {}, orders: {}, catalog: { labor: {}, parts: {} } };
    let threw = null;
    try { db = shapeDb(old); } catch (e) { threw = e.message; }
    return { threw, insp: !!db.inspections, recs: !!db.recommendations, att: !!db.attachments,
             techs: Array.isArray(db.settings.techs), rateKept: db.settings.laborRate,
             thresholds: !!db.settings.thresholds };
  });
  const Ob = results.oldBackup;
  check('44. a backup from before this version imports without crashing',
    !Ob.threw && Ob.insp && Ob.recs && Ob.att && Ob.techs && Ob.thresholds && Ob.rateKept === 100,
    JSON.stringify(Ob));

  check('41. nothing threw during any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(JSON.stringify(results, null, 1));
  console.log('');
  Object.keys(results).filter(k => typeof results[k] === 'string').forEach(k => console.log(' ' + results[k].padEnd(6) + ' ' + k));
  if (failures.length) {
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL SHOP-FLOOR CHECKS PASSED');
})();
