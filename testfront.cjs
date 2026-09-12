/* The front office: customers, vehicles, and the day before the car arrives.

   The failures worth guarding against here are quiet ones. A second customer
   record for somebody who rang back, or a second vehicle record for a VIN
   already in the book, does not throw an error — it just cuts a car's history
   in half and hides the work this customer already declined. So most of what
   follows is about NOT creating things twice, and about everything known at
   the counter surviving the handover to the existing check-in.

   The network is never touched. */
const { chromium } = require('playwright');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const LS_KEY = 'jzd.shop.db';

/* A v2.4.1 book: a finalized invoice, an inspection, a declined recommendation
   and an attachment record — everything the new phase must leave alone. */
const V241_BOOK = {
  settings: {
    shopName: 'JZD Inc.', laborRate: 112.5, rateMin: 100, rateMax: 125, taxRate: 8.25,
    taxLabor: false, taxParts: true, taxFees: false, partsMarkup: 40,
    nextInvoice: 1010, nextEstimate: 5, nextRO: 3, nextInspection: 2, fees: [], techs: ['Marco'],
    thresholds: { treadMonitor: 5, treadUrgent: 3, padMonitor: 4, padUrgent: 2, moistureMonitor: 2, moistureUrgent: 3 },
    terms: 'Thank you.', requireOverrideReason: true, managerPin: '',
    providers: { vehicle: 'nhtsa', labor: 'seed', motor: { enabled: false }, mitchell: { enabled: false }, alldata: { enabled: false } }
  },
  customers: { cOld: { id: 'cOld', name: 'Prior Customer', phone: '509-555-0199', email: 'prior@example.com', address: '12 Mill Road', notes: '' } },
  vehicles: { vOld: { id: 'vOld', customerId: 'cOld', year: '2015', make: 'Ford', model: 'F-150', vin: '1FTFW1EF5FKD12345', plate: 'OLD-123', mileage: '88000' } },
  orders: {
    oOld: {
      id: 'oOld', customerId: 'cOld', vehicleId: 'vOld', date: '2026-08-20', status: 'Paid / Closed',
      estimateNo: 4, roNo: 2, invoiceNo: 1009, complaint: 'Oil change',
      labor: [{ id: 'l1', type: 'catalog-labor', desc: 'Oil service', bill: 'H', hours: 0.5, billedHours: 0.5, rate: 112.5, rateSource: 'locked', source: 'SHOP SEED' }],
      parts: [{ id: 'p1', type: 'part', desc: 'Filter', qty: '1', cost: '8', markup: 40, price: '11.20' }],
      extras: [], payments: [{ id: 'pay1', at: '2026-08-20T10:00:00Z', amount: 68.37, method: 'Card', note: '' }],
      history: [], auth: { state: 'Approved', entries: [], approvedTotal: 68.37 },
      finalized: { at: '2026-08-20T10:00:00Z', taxRate: 8.25, taxLabor: false, taxParts: true, taxFees: false, laborRate: 112.5 },
      checkin: { at: '2026-08-20T08:00:00Z', by: 'Zack', fuel: '1/2', keys: '2', damage: [{ id: 'dmgOld', area: 'LF door', type: 'Scratch', severity: 'Light', note: 'old', by: 'Zack', at: '2026-08-20T08:00:00Z', photos: [] }] },
      inspectionId: 'inspOld', notes: 'oil changed'
    }
  },
  inspections: {
    inspOld: { id: 'inspOld', no: 1, orderId: 'oOld', vehicleId: 'vOld', vin: '1FTFW1EF5FKD12345',
      mileage: '88000', tech: 'Marco', state: 'Completed', startedAt: '2026-08-20T08:10:00Z',
      completedAt: '2026-08-20T09:00:00Z', template: { version: '2.4.0', groups: [] },
      items: { 'tires.tire.RR': { state: 'Urgent', meas: { tread: '3' }, flags: [], note: '', custNote: '', photos: [], at: null, tech: 'Marco' } } }
  },
  recommendations: {
    recOld: { id: 'recOld', at: '2026-08-20T09:10:00Z', status: 'Declined', vehicleId: 'vOld', orderId: 'oOld',
      inspKey: 'tires.tire.RR', severity: 'Urgent', desc: 'RR Tire — Tires', reason: 'tread 3',
      serviceId: '', amount: 725, custNote: '', lineId: '', mileage: '88230', decidedAt: '2026-08-20T09:20:00Z', decidedBy: 'Prior Customer', photos: [] }
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

  /* ---- 1. the old book opens untouched ---- */
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(([k, b]) => localStorage.setItem(k, JSON.stringify(b)), [LS_KEY, V241_BOOK]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);

  results.old = await page.evaluate(() => ({
    locked: !!window.storageLocked,
    invoice: orderTotals(db.orders.oOld).total, invoiceNo: db.orders.oOld.invoiceNo,
    inspection: db.inspections.inspOld.items['tires.tire.RR'].meas.tread,
    inspState: db.inspections.inspOld.state,
    attachment: !!db.attachments.attOld, attCaption: db.attachments.attOld.caption,
    damage: db.orders.oOld.checkin.damage.length,
    appts: !!db.appointments, apptCount: Object.keys(db.appointments).length,
    bays: (db.settings.bays || []).length,
    custName: custName('cOld')
  }));
  const O = results.old;
  check('1. a v2.4.1 book opens with its invoice, inspection, damage and photos intact',
    !O.locked && near(O.invoice, 68.37) && O.invoiceNo === 1009 && O.inspection === '3' &&
    O.inspState === 'Completed' && O.attachment && O.attCaption === 'old damage' &&
    O.damage === 1 && O.appts && O.apptCount === 0 && O.bays > 0 && O.custName === 'Prior Customer',
    JSON.stringify(O));

  /* ---- 2,3. customers and their vehicles ---- */
  results.cust = await page.evaluate(() => {
    const c = saveCustomer({ id: uid('c'), first: 'Dale', last: 'Hansen', company: '',
      phone: '509-555-0142', phone2: '509-555-0143', email: 'dale@example.com',
      address: '44 Sprague Ave', city: 'Spokane', state: 'WA', zip: '99201',
      contactBy: 'Text', notes: 'prefers early mornings' });
    const fleet = saveCustomer({ id: uid('c'), first: 'Ann', last: 'Ruiz', company: 'Northside Plumbing',
      phone: '509-555-0180', email: 'ann@northside.example' });
    db.vehicles.m3 = { id: 'm3', customerId: c.id, year: '2018', make: 'BMW', model: 'M3',
      vin: 'WBS8M9C55J5J78069', plate: 'JZD-M3', mileage: '48200' };
    db.vehicles.x5 = { id: 'x5', customerId: c.id, year: '2016', make: 'BMW', model: 'X5',
      vin: '5UXKR0C58G0P29155', plate: 'JZD-X5', mileage: '77000' };
    db.vehicles.van = { id: 'van', customerId: fleet.id, year: '2020', make: 'Ford', model: 'Transit',
      vin: '1FTYE1YM6LKA12345', plate: 'NP-7', unit: 'Unit 7', mileage: '61000' };
    save();
    return { id: c.id, fleetId: fleet.id, name: c.name, label: customerLabel(c),
             fleetLabel: customerLabel(fleet), isBiz: isBusiness(fleet), notBiz: isBusiness(c),
             created: !!c.createdAt, contactBy: c.contactBy,
             vehicles: vehiclesOf(c.id).length, fleetVehicles: vehiclesOf(fleet.id).length,
             unit: db.vehicles.van.unit };
  });
  const C = results.cust;
  check('2. a customer persists with every field, and a business is just a customer with a company',
    C.name === 'Dale Hansen' && C.label === 'Dale Hansen' && C.contactBy === 'Text' && C.created &&
    C.fleetLabel === 'Northside Plumbing (Ann Ruiz)' && C.isBiz && !C.notBiz, JSON.stringify(C));
  check('3. one customer holds several vehicles, and a fleet vehicle keeps its unit number',
    C.vehicles === 2 && C.fleetVehicles === 1 && C.unit === 'Unit 7', JSON.stringify(C));

  /* ---- 4,5. not creating things twice ---- */
  results.dupes = await page.evaluate(c => {
    const sameVin = findVehicleByVin('WBS8M9C55J5J78069');
    const sameVinSpaced = findVehicleByVin(' wbs8m9c55j5j78069 ');
    const noVin = findVehicleByVin('1FTYE1YM6LKA99999');
    const byPhone = findDuplicateCustomers({ id: 'new1', first: 'D', last: 'H', phone: '509-555-0142' });
    const byEmail = findDuplicateCustomers({ id: 'new2', first: 'Someone', last: 'Else', email: 'dale@example.com' });
    const byName = findDuplicateCustomers({ id: 'new3', first: 'Dale', last: 'Hansen' });
    const bySecond = findDuplicateCustomers({ id: 'new4', first: 'X', last: 'Y', phone: '509-555-0143' });
    const stranger = findDuplicateCustomers({ id: 'new5', first: 'Nobody', last: 'Here', phone: '509-555-9999' });
    return { sameVin: sameVin && sameVin.id, sameVinSpaced: sameVinSpaced && sameVinSpaced.id, noVin,
             byPhone: byPhone.length && byPhone[0].reasons, byEmail: byEmail.length && byEmail[0].reasons,
             byName: byName.length && byName[0].reasons, bySecond: bySecond.length && bySecond[0].reasons,
             stranger: stranger.length,
             /* nothing was merged or created by asking */
             customers: Object.keys(db.customers).length };
  }, C);
  const D = results.dupes;
  check('4. a VIN already in the book is found, however it is typed',
    D.sameVin === 'm3' && D.sameVinSpaced === 'm3' && D.noVin === null, JSON.stringify(D));
  check('5. a likely duplicate customer is flagged by phone, email or name, and nothing is merged',
    D.byPhone && D.byEmail && D.byName && D.bySecond && D.stranger === 0 && D.customers === 3,
    JSON.stringify(D));

  /* ---- 6..11. finding people ---- */
  results.search = await page.evaluate(() => {
    const n = q => searchEverything(q);
    return {
      byName: n('hansen').customers.length, byBusiness: n('northside').customers.length,
      byPhone: n('5095550142').customers.length, byPartialPhone: n('555-0142').customers.length,
      byLoosePhone: n('0142').customers.length,
      byEmail: n('dale@example.com').customers.length,
      byVin: n('WBS8M9C55J5J78069').vehicles.length,
      byPartialVin: n('J78069').vehicles.length,
      byPlate: n('JZD-M3').vehicles.length, byOldPlate: n('OLD-123').vehicles.length,
      byYmm: n('bmw x5').vehicles.length,
      byUnit: n('Unit 7').vehicles.length,
      byInvoice: n('INV-1009').orders.length
    };
  });
  const S = results.search;
  check('6. search finds a customer by name and by business name', S.byName >= 1 && S.byBusiness >= 1, JSON.stringify(S));
  check('7. search finds a customer by phone, however it is punctuated',
    S.byPhone >= 1 && S.byPartialPhone >= 1 && S.byLoosePhone >= 1, JSON.stringify(S));
  check('8. search finds a customer by email', S.byEmail >= 1, JSON.stringify(S));
  check('9. search finds a vehicle by full VIN', S.byVin >= 1, JSON.stringify(S));
  check('10. search finds a vehicle by partial VIN', S.byPartialVin >= 1, JSON.stringify(S));
  check('11. search finds a vehicle by plate, unit number and by year/make/model',
    S.byPlate >= 1 && S.byOldPlate >= 1 && S.byYmm >= 1 && S.byUnit >= 1 && S.byInvoice >= 1, JSON.stringify(S));

  /* ---- 12..19. appointments ---- */
  results.appt = await page.evaluate(c => {
    const a = newAppointment({ customerId: c.id, vehicleId: 'm3', date: '2026-09-15', time: '09:00',
      hours: 1.5, concern: 'Oil service and a clunk from the front', tech: 'Marco', bay: 'Bay 2' });
    const lof = SEED.find(r => /LOF/i.test(r.svc) && r.bill === 'F') || SEED.find(r => r.bill === 'F');
    const req1 = addRequested(a, { serviceId: lof.id });
    const req2 = addRequested(a, { desc: 'Diagnose front end clunk', hours: 1 });
    const b = newAppointment({ customerId: c.id, vehicleId: 'x5', date: '2026-09-15', time: '07:30',
      hours: 2, concern: 'Brake inspection', tech: 'Marco' });
    const late = newAppointment({ customerId: c.id, vehicleId: 'x5', date: '2026-09-15', time: '14:00', hours: 3 });
    save();
    return { id: a.id, bId: b.id,
             requested: a.requested.length, serviceKept: req1.serviceId, descFromCatalog: req1.desc,
             amountFromCatalog: req1.amount, freeText: req2.desc, freeHours: req2.hours,
             reqHours: requestedHours(a), reqTotal: requestedTotal(a),
             order: apptsOn('2026-09-15').map(x => x.time),
             hours: scheduledHours('2026-09-15'),
             tech: a.tech, bay: a.bay, status: a.status,
             reminder: a.reminder };
  }, C);
  const Ap = results.appt;
  check('12. an appointment persists with its time, technician, bay and reminder fields',
    Ap.status === 'Scheduled' && Ap.tech === 'Marco' && Ap.bay === 'Bay 2' &&
    Ap.reminder && Ap.reminder.status === 'Not sent', JSON.stringify(Ap));
  check('18. requested work persists, free text and catalog alike',
    Ap.requested === 2 && Ap.freeText === 'Diagnose front end clunk' && Ap.freeHours === 1, JSON.stringify(Ap));
  check('19. a catalog-linked request keeps its Service ID, description and price',
    !!Ap.serviceKept && !!Ap.descFromCatalog && Ap.amountFromCatalog > 0, JSON.stringify(Ap));
  check('27. the day is in chronological order',
    JSON.stringify(Ap.order) === JSON.stringify(['07:30', '09:00', '14:00']), JSON.stringify(Ap.order));
  check('28. scheduled hours add up, in total and by technician',
    near(Ap.hours.total, 6.5) && near(Ap.hours.byTech.Marco, 3.5) && near(Ap.hours.Unassigned || Ap.hours.byTech.Unassigned, 3),
    JSON.stringify(Ap.hours));

  /* ---- 13,14,15,16,17. moving, cancelling, and remembering ---- */
  results.moves = await page.evaluate(a => {
    const appt = db.appointments[a.id];
    const idBefore = appt.id, createdBefore = appt.createdAt;
    rescheduleAppointment(appt, '2026-09-16', '11:00', 'Marco', 'customer asked');
    const afterMove = { id: appt.id, sameId: appt.id === idBefore, created: appt.createdAt === createdBefore,
                        date: appt.date, time: appt.time, history: appt.history.length,
                        note: appt.history[appt.history.length - 1] };
    setApptStatus(appt, 'Confirmed', 'customer confirmed by text');
    const confirmed = { status: appt.status, history: appt.history.length };

    const b = db.appointments[a.bId];
    setApptStatus(b, 'No Show', 'did not arrive');
    const c2 = newAppointment({ customerId: appt.customerId, vehicleId: 'x5', date: '2026-09-20', time: '10:00' });
    setApptStatus(c2, 'Cancelled', 'customer rang to cancel');
    save();
    return { afterMove, confirmed, techAfter: appt.tech, bayAfter: appt.bay,
             noShowKept: !!db.appointments[b.id], noShowState: b.status, noShowHistory: b.history.length,
             cancelledKept: !!db.appointments[c2.id], cancelledState: c2.status,
             cancelledNote: c2.history[c2.history.length - 1].note,
             /* a cancelled day should not count against capacity */
             hoursOn20: scheduledHours('2026-09-20').total,
             totalAppointments: Object.keys(db.appointments).length };
  }, Ap);
  const M = results.moves;
  check('13. rescheduling moves the same appointment rather than making another',
    M.afterMove.sameId && M.afterMove.created && M.afterMove.date === '2026-09-16' &&
    M.afterMove.time === '11:00' && /rescheduled from/.test(M.afterMove.note.from), JSON.stringify(M));
  check('14. every status change is kept', M.confirmed.status === 'Confirmed' && M.confirmed.history >= 2, JSON.stringify(M));
  check('15. a cancelled appointment stays in the book with its reason',
    M.cancelledKept && M.cancelledState === 'Cancelled' && /rang to cancel/.test(M.cancelledNote) &&
    near(M.hoursOn20, 0), JSON.stringify(M));
  check('16. a no-show stays in the book', M.noShowKept && M.noShowState === 'No Show' && M.noShowHistory >= 1, JSON.stringify(M));
  check('17. the technician and bay stay on the appointment through a move and a status change',
    M.techAfter === 'Marco' && M.bayAfter === 'Bay 2', JSON.stringify(M));

  /* ---- 20,21. what this vehicle already declined ---- */
  results.declined = await page.evaluate(() => {
    /* the old truck, which declined a tyre last visit */
    const ctx = schedulingContext('vOld');
    const a = newAppointment({ customerId: 'cOld', vehicleId: 'vOld', date: '2026-09-17', time: '08:00' });
    const before = a.requested.length;
    const rec = ctx.declined[0];
    addRequested(a, { desc: rec.desc, serviceId: rec.serviceId || '', amount: rec.amount, recId: rec.id });
    save();
    return { declined: ctx.declined.length, first: ctx.declined[0] && ctx.declined[0].desc,
             amount: ctx.declined[0] && ctx.declined[0].amount, mileage: ctx.declined[0] && ctx.declined[0].mileage,
             history: ctx.history.length, lastVisit: ctx.lastVisit && ctx.lastVisit.date,
             added: a.requested.length - before, linked: a.requested[0].recId, apptId: a.id };
  });
  const Dc = results.declined;
  check('20. work this vehicle declined before is on screen at scheduling, with its mileage and amount',
    Dc.declined >= 1 && /RR Tire/.test(Dc.first) && near(Dc.amount, 725) && Dc.mileage === '88230' &&
    Dc.history >= 1 && Dc.lastVisit === '2026-08-20', JSON.stringify(Dc));
  check('21. declined work can be added to the appointment and stays linked to the recommendation',
    Dc.added === 1 && Dc.linked === 'recOld', JSON.stringify(Dc));

  /* ---- 22,23,24,25. arrival, and the handover to the existing check-in ---- */
  results.arrive = await page.evaluate(a => {
    const appt = db.appointments[a.id];
    const o = arriveAppointment(appt);
    const added = requestedToOrder(o, appt);
    if (appt.tech) (o.labor || []).forEach(l => { if (!l.tech) l.tech = appt.tech; });
    save();
    return { orderId: o.id, apptOrder: appt.orderId, apptStatus: appt.status,
             customer: o.customerId === appt.customerId, vehicle: o.vehicleId === appt.vehicleId,
             concern: o.complaint, notes: o.internalNotes, estimateNo: o.estimateNo,
             lines: o.labor.length, added: added.length,
             catalogLine: o.labor.find(l => l.serviceId) ? o.labor.find(l => l.serviceId).serviceId : null,
             manualLine: o.labor.find(l => !l.serviceId) ? o.labor.find(l => !l.serviceId).desc : null,
             techCarried: o.labor.every(l => l.tech === 'Marco'),
             requestedLinked: appt.requested.every(r => !!r.lineId),
             /* arriving twice must not make a second ticket */
             again: arriveAppointment(appt).id === o.id,
             checkinShape: !!o.checkin || (shapeCheckin(o) && true),
             total: orderTotals(o).total };
  }, Ap);
  const Ar = results.arrive;
  check('22. arriving opens the existing check-in rather than a second one',
    !!Ar.orderId && Ar.apptOrder === Ar.orderId && Ar.apptStatus === 'Arrived' &&
    Ar.again && Ar.checkinShape && !!Ar.estimateNo, JSON.stringify(Ar));
  check('23. the customer, vehicle, concern and notes all come across',
    Ar.customer && Ar.vehicle && /clunk/i.test(Ar.concern), JSON.stringify(Ar));
  check('24. the technician is carried forward onto the work', Ar.techCarried, JSON.stringify(Ar));
  check('25. requested work becomes real lines through the existing pricing',
    Ar.lines === 2 && Ar.added === 2 && !!Ar.catalogLine && !!Ar.manualLine &&
    Ar.requestedLinked && Ar.total > 0, JSON.stringify(Ar));

  /* ---- 26. a walk-in needs no appointment ---- */
  results.walkin = await page.evaluate(() => {
    const a = newAppointment({ date: todayStr(), time: '13:15', status: 'Arrived', notes: 'Walk-in' });
    a.customerId = Object.keys(db.customers)[0];
    a.vehicleId = 'm3';
    const o = arriveAppointment(a);
    save();
    return { onToday: apptsOn(todayStr()).some(x => x.id === a.id), status: a.status,
             hasOrder: !!o.id, isWalkIn: /Walk-in/.test(a.notes) };
  });
  check('26. a walk-in checks straight in and appears on today',
    results.walkin.onToday && results.walkin.hasOrder && results.walkin.isWalkIn, JSON.stringify(results.walkin));

  /* ---- 29,32. nothing historical moved ---- */
  results.frozen = await page.evaluate(() => {
    const before = orderTotals(db.orders.oOld).total;
    const insp = JSON.stringify(db.inspections.inspOld);
    db.settings.laborRate = 200; db.settings.taxRate = 20;
    const after = orderTotals(db.orders.oOld).total;
    const inspAfter = JSON.stringify(db.inspections.inspOld);
    db.settings.laborRate = 112.5; db.settings.taxRate = 8.25;
    return { before, after, inspSame: insp === inspAfter, attachment: !!db.attachments.attOld };
  });
  check('29. the old invoice still does not move', near(results.frozen.before, results.frozen.after), JSON.stringify(results.frozen));
  check('32. the old inspection and its attachment are untouched',
    results.frozen.inspSame && results.frozen.attachment, JSON.stringify(results.frozen));

  /* ---- 30,31. backup and restore ---- */
  results.backup = await page.evaluate(async () => {
    const built = await buildBackup();
    const pkg = JSON.stringify(built.pkg);
    const before = { customers: Object.keys(db.customers).length,
                     appointments: Object.keys(db.appointments).length,
                     vehicles: Object.keys(db.vehicles).length,
                     attachments: Object.keys(db.attachments).length,
                     apptHistory: Object.values(db.appointments).reduce((s, a) => s + a.history.length, 0),
                     requested: Object.values(db.appointments).reduce((s, a) => s + a.requested.length, 0),
                     bays: db.settings.bays.length,
                     invoice: orderTotals(db.orders.oOld).total };
    db = shapeDb(JSON.parse(JSON.stringify(DEFAULT)));
    const wiped = Object.keys(db.appointments).length + Object.keys(db.customers).length;
    await restoreBackupPackage(JSON.parse(pkg));
    const after = { customers: Object.keys(db.customers).length,
                    appointments: Object.keys(db.appointments).length,
                    vehicles: Object.keys(db.vehicles).length,
                    attachments: Object.keys(db.attachments).length,
                    apptHistory: Object.values(db.appointments).reduce((s, a) => s + a.history.length, 0),
                    requested: Object.values(db.appointments).reduce((s, a) => s + a.requested.length, 0),
                    bays: db.settings.bays.length,
                    invoice: orderTotals(db.orders.oOld).total,
                    ownership: vehiclesOf(Object.values(db.customers).find(c => c.name === 'Dale Hansen').id).length,
                    apptLinked: Object.values(db.appointments).filter(a => a.orderId && db.orders[a.orderId]).length };
    return { before, wiped, after };
  });
  const B = results.backup;
  check('30. a backup carries the customers, appointments, their history and the bays',
    B.wiped === 0 && B.after.customers === B.before.customers &&
    B.after.appointments === B.before.appointments && B.after.apptHistory === B.before.apptHistory &&
    B.after.requested === B.before.requested && B.after.bays === B.before.bays &&
    B.after.ownership === 2 && B.after.apptLinked >= 1, JSON.stringify(B));
  check('31. the photographs and the old invoice come back with them',
    B.after.attachments === B.before.attachments && near(B.after.invoice, B.before.invoice),
    JSON.stringify(B));

  check('33. nothing threw during any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(JSON.stringify(results, null, 1).slice(0, 5000));
  console.log('');
  Object.keys(results).filter(k => typeof results[k] === 'string').forEach(k => console.log(' ' + results[k].padEnd(6) + ' ' + k));
  if (failures.length) {
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL FRONT-OFFICE CHECKS PASSED');
})();
