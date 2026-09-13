/* OEM maintenance schedules (2.8.3).

   What is under test, in order of how much it matters:
     * an interval is never guessed: no licensed or verified source, no schedule;
     * a service is never assumed done: no history, no "not due";
     * MOTOR sandbox data is a DTO test only and never a recommendation;
     * every schedule keeps where it came from, and the shop's own intervals
       are never shown as the manufacturer's;
     * mileage, time, whichever-first, first-then-repeat, maintenance minder,
       condition-based, normal and severe are each calculated as stated;
     * the inspection shows what is due without changing a single result;
     * ADD TO ESTIMATE keeps the source and does not authorize anything.

   MOTOR answers from a fixture laid out exactly as its Details/Of/
   MaintenanceSchedules response (field names as the live sandbox returns
   them); no request leaves this machine. */
const { chromium } = require('playwright');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const results = {};
const failures = [];
function check(name, cond, detail){
  results[name] = cond ? 'PASS' : 'FAIL';
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 700)));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const item = (o) => Object.assign({ Documents: [], FrequencyCode: 'E', FrequencyDescription: 'Every', Indicator: '', IntervalKilometer: 0, IntervalMile: 0,
  IntervalMonth: 0, IntervalOperatingHours: 0, IsActive: true, Notes: [], SevereServiceDescription: 'No', MaintenanceScheduleID: 1 }, o);
const app = (id, literal, action, items) => ({ ApplicationID: id, IsActive: true, EstimatedWorkTimes: [], IncludedWorkTimes: [], AttributeMappings: [],
  Category: { Article: 'Scheduled Maintenance Times', ID: 23 }, ContentSilos: [], Qualifiers: [], Links: [],
  Taxonomy: { Action: action, LiteralName: literal, GroupName: 'Engine', SystemName: 'Powertrain' }, Items: items });
const MOTOR_MS = { Header: { Date: 'Sun, 13 Sep 2026 19:02:29 GMT', Messages: [], Status: 'OK', StatusCode: 200 }, Body: { MaintenanceSchedules: [
  app(101, 'Engine Air Filter Element R&R', 'R&R', [
    item({ FrequencyCode: 'E', IntervalMile: 15000, IntervalKilometer: 24000, SevereServiceDescription: 'Yes', MaintenanceScheduleID: 402, Notes: [{ Text: 'Applies If the vehicle is driven primarily in dusty conditions' }] }),
    item({ FrequencyCode: 'I', FrequencyDescription: 'Indicator Light Or Interval', Indicator: 'Service 2', MaintenanceScheduleID: 649 })]),
  app(102, 'Brake Hydraulic System Drain, Refill & Bleed', 'Drain, Refill & Bleed', [
    item({ IntervalMonth: 36, MaintenanceScheduleID: 477 }),
    item({ FrequencyCode: 'N', FrequencyDescription: "OEM Doesn't Specify", SevereServiceDescription: 'Yes', MaintenanceScheduleID: 1921 })]),
  app(103, 'Engine Oil Drain & Refill', 'Drain & Refill', [
    item({ FrequencyCode: 'I', FrequencyDescription: 'Indicator Light Or Interval', Indicator: 'Service A', IntervalMonth: 12, MaintenanceScheduleID: 2386,
      Notes: [{ Text: 'If the "Service Due Now" message does not appear more than 12 months after the display is reset, change engine oil every year.' }] })]),
  app(104, 'Water Pump Inspect', 'Inspect', [item({ FrequencyCode: 'N', FrequencyDescription: "OEM Doesn't Specify", MaintenanceScheduleID: 1831 })]),
  app(105, 'Coolant Replace', 'Replace', [item({ IntervalMile: 30000, IntervalMonth: 24, MaintenanceScheduleID: 900 })]),
  app(106, 'Timing Belt R&R', 'R&R', [item({ FrequencyCode: 'Q', FrequencyDescription: 'Some future frequency', IntervalMile: 105000, MaintenanceScheduleID: 950 })]),
  app(107, 'Tire Rotate', 'Rotate', [item({ IntervalMile: 7500, MaintenanceScheduleID: 2451 })]),
  app(108, 'Fuel Filter R&R', 'R&R', [item({ IsActive: false, IntervalMile: 1, MaintenanceScheduleID: 999 })])
] } };
const MOTOR_VIN = { Header: { StatusCode: 200, Messages: [] }, Body: { Vehicles: [{ VehicleID: 'v-22124', BaseVehicleID: 22124, EngineID: 2913, SubModelID: 20,
  Year: 2019, MakeName: 'Honda', ModelName: 'Civic', SubModelName: 'LX', EngineDescription: '2.0L L4' }] } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.type() === 'confirm' ? d.dismiss() : d.accept(); });
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await wait(300);

  await page.evaluate(({ MOTOR_MS, MOTOR_VIN }) => {
    window.__hubTestSecretStore = {};
    window.__motorLog = [];
    window.__hubTestProviderFetch = async (id, req) => {
      if (id === 'motor_daas'){
        window.__motorLog.push(req.url);
        if (/Search\/ByVIN/.test(req.url)) return { status: 200, text: JSON.stringify(MOTOR_VIN) };
        if (/Details\/Of\/MaintenanceSchedules/.test(req.url)) return { status: 200, text: JSON.stringify(MOTOR_MS) };
      }
      return { status: 404, text: '' };
    };
    saveCustomer({ id: 'c1', first: 'Dana', last: 'Reyes', phone: '509-555-0100' });
    db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2019', make: 'Honda', model: 'Civic', vin: '19XFC2F59KE000001', mileage: '64000' };
    db.vehicles.v2 = { id: 'v2', customerId: 'c1', year: '2020', make: 'Toyota', model: 'Camry', vin: '4T1B11HK5LU000002', mileage: '3000' };
    save();
  }, { MOTOR_MS, MOTOR_VIN });

  /* ================= 1. nothing licensed: no schedule, nothing guessed ================= */
  const none = await page.evaluate(async () => {
    const r = await oemFetchSchedule('v1');
    detailVeh = 'v1'; go('vehDetail');
    await new Promise(res => setTimeout(res, 300));
    const text = document.getElementById('oemMaint').innerText;
    return { schedule: r.schedule, tried: r.tried.map(t => t.id + ': ' + t.readiness), text, rows: document.querySelectorAll('#oemMaint [data-oemop]').length,
      shopPanel: /Maintenance — SHOP RECOMMENDATION/.test(document.getElementById('app').innerText),
      seedBlank: db.settings.maintItems.every(m => m.miles == null && m.months == null), noneFor: oemScheduleFor('v1') };
  });
  check('1a. with no licensed source: OEM MAINTENANCE SCHEDULE UNAVAILABLE and NO VERIFIED INTERVAL — DO NOT GUESS',
    none.schedule === null && none.noneFor === null && /OEM MAINTENANCE SCHEDULE UNAVAILABLE/.test(none.text) && /NO VERIFIED INTERVAL — DO NOT GUESS/.test(none.text) && none.rows === 0, none.text);
  check('1b. each source says exactly why it was not used (MOTOR production not licensed, DataOne, TecRMI, Autodata ready for licence)',
    /motor_daas: PRODUCTION NOT LICENSED/.test(none.tried.join('\n')) && /dataone: READY FOR CREDENTIALS \/ LICENSE/.test(none.tried.join('\n')) &&
    /tecrmi: READY FOR LICENSE \/ CREDENTIALS/.test(none.tried.join('\n')) && /autodata: READY FOR LICENSE \/ API KEY/.test(none.tried.join('\n')) &&
    /NO VERIFIED OEM SCHEDULE/.test(none.text), none.tried.join(' | '));
  check('1c. the shop\'s own intervals are labelled SHOP RECOMMENDATION and the seed has no intervals at all', none.shopPanel && none.seedBlank);

  /* ================= 2. MOTOR sandbox: DTO test only ================= */
  const sb = await page.evaluate(async () => {
    await HubSecrets.set('motor_daas', 'publicKey', 'pub'); await HubSecrets.set('motor_daas', 'privateKey', 'priv');
    const m = providerConfig('motor_daas'); m.environment = 'sandbox'; m.enabled = true; m.cacheAllowedByContract = true; save();
    const fetched = await oemFetchSchedule('v1');
    const dto = await oemSandboxDtoTest('v1');
    let addErr = ''; try { oemAddToEstimate('v1', 'motor_daas:105:900'); } catch (e){ addErr = e.message; }
    render(); await new Promise(res => setTimeout(res, 200));
    return { schedule: fetched.schedule, tried: fetched.tried.map(t => t.id + ': ' + t.readiness).join(' | '), dto, kept: Object.keys(db.oemMaint.schedules).length,
      session: oemSessionSchedules.size, forV1: oemScheduleFor('v1'), addErr, text: document.getElementById('oemMaint').innerText };
  });
  check('2a. MOTOR sandbox keys are never used for this vehicle\'s schedule (SANDBOX — DTO TEST ONLY, NEVER A RECOMMENDATION)',
    sb.schedule === null && sb.forV1 === null && /SANDBOX CONNECTED — DTO TEST ONLY, NEVER A RECOMMENDATION/.test(sb.tried) && /OEM MAINTENANCE SCHEDULE UNAVAILABLE/.test(sb.text), sb.tried);
  check('2b. the sandbox DTO test normalizes the real field layout and stores nothing', sb.dto.operations === 9 && sb.dto.severe === 2 &&
    sb.dto.byRule.unspecified === 2 && sb.dto.byRule.indicator === 2 && sb.dto.byRule['whichever-first'] === 1 && sb.dto.byRule.unknown === 1 &&
    sb.kept === 0 && sb.session === 0, JSON.stringify(sb.dto));
  check('2c. sandbox data cannot be added to an estimate', /not on this vehicle's schedule|SANDBOX/.test(sb.addErr), sb.addErr);

  /* ================= 3. MOTOR production, licensed ================= */
  const prod = await page.evaluate(async () => {
    const m = providerConfig('motor_daas'); m.environment = 'production'; m.productionLicenseConfirmed = true; m.cacheAllowedByContract = false; m.lastTest = null; save();
    window.__motorLog = [];
    const r = await oemFetchSchedule('v1');
    const s = r.schedule;
    const sessionOnly = Object.keys(db.oemMaint.schedules).length === 0 && oemSessionSchedules.has('v1');
    oemSessionSchedules.clear();
    providerConfig('motor_daas').cacheAllowedByContract = true;
    const r2 = await oemFetchSchedule('v1');
    return { label: s && s.label, env: s && s.environment, production: s && s.production, sandbox: s && s.sandbox, vin: s && s.vin, pvid: s && s.providerVehicleId,
      retrieved: s && s.retrievedAt, version: s && s.dataVersion, resolved: s && s.resolvedVehicle, ops: s && s.operations.length, urls: window.__motorLog,
      sessionOnly, dbg: [Object.keys(db.oemMaint.schedules), r2.schedule && r2.schedule.kept, cachePolicyOf(PROVIDER_BY_ID.motor_daas)], kept: !!db.oemMaint.schedules.v1 && r2.schedule.kept === true,
      byKey: Object.fromEntries((s ? s.operations : []).map(o => [o.key, { type: o.rule.type, miles: o.rule.miles, months: o.rule.months, cond: o.condition, action: o.action, code: o.rule.frequencyCode, ind: o.rule.indicator, sched: o.scheduleId, op: o.operationId, words: o.oemWording }])) };
  });
  check('3a. MOTOR production supplies the schedule, labelled OEM SCHEDULE — MOTOR with its provenance',
    prod.label === 'OEM SCHEDULE — MOTOR' && prod.env === 'production' && prod.production === true && prod.sandbox === false && prod.vin === '19XFC2F59KE000001' &&
    prod.pvid === '22124' && !!prod.retrieved && prod.version === 'Sun, 13 Sep 2026 19:02:29 GMT' && /Honda Civic/.test(prod.resolved) && prod.ops === 9, JSON.stringify(prod).slice(0, 600));
  check('3b. it asks MOTOR\'s documented Details/Of/MaintenanceSchedules for all severities, by the VIN\'s base vehicle',
    prod.urls.some(u => /Search\/ByVIN\?VIN=19XFC2F59KE000001/.test(u)) &&
    prod.urls.some(u => /BaseVehicleID\/22124\/Content\/Details\/Of\/MaintenanceSchedules\?Severity=All&EN=2913&SM=20/.test(u)), prod.urls.join(' | '));
  check('3c. a licensed schedule is kept in the book only when the contract allows it; otherwise this session only', prod.sessionOnly && prod.kept, JSON.stringify([prod.sessionOnly, prod.kept, prod.dbg]));
  const K = prod.byKey;
  check('3d. MOTOR codes normalize as stated: E miles+months = whichever first, E months = time, I = maintenance minder (with its 12-month backstop), N = not specified, an unknown code = not calculated',
    K['motor_daas:105:900'].type === 'whichever-first' && K['motor_daas:105:900'].miles === 30000 && K['motor_daas:105:900'].months === 24 &&
    K['motor_daas:102:477'].type === 'time' && K['motor_daas:103:2386'].type === 'indicator' && K['motor_daas:103:2386'].ind === 'Service A' && K['motor_daas:103:2386'].months === 12 &&
    K['motor_daas:104:1831'].type === 'unspecified' && K['motor_daas:106:950'].type === 'unknown' && K['motor_daas:106:950'].code === 'Q' &&
    K['motor_daas:101:402'].cond === 'severe' && K['motor_daas:101:649'].cond === 'normal' && !K['motor_daas:108:999'] &&
    K['motor_daas:104:1831'].action === 'INSPECT' && K['motor_daas:105:900'].action === 'REPLACE' && K['motor_daas:107:2451'].action === 'ROTATE', JSON.stringify(K));
  check('3e. provenance per operation: operation id, schedule id and the OEM wording', K['motor_daas:101:402'].op === '101' && K['motor_daas:101:402'].sched === '402' &&
    /Engine Air Filter Element R&R · Every · 15000 mi · 24000 km/.test(K['motor_daas:101:402'].words), K['motor_daas:101:402'].words);

  /* ================= 4. usage profile ================= */
  const prof = await page.evaluate(() => {
    const keys = p => oemTimeline('v1', { profile: p }).rows.map(r => r.op.key).sort();
    const t = oemTimeline('v1');
    return { unknown: keys('UNKNOWN'), normal: keys('NORMAL'), severe: keys('SEVERE'), dusty: keys('DUSTY'), def: t.profile, diff: t.difference,
      dependent: t.rows.filter(r => r.op.profileDependent).map(r => r.op.key).sort() };
  });
  check('4a. the usage profile starts UNKNOWN and then both normal and severe items are shown, marked', prof.def === 'UNKNOWN' &&
    prof.unknown.includes('motor_daas:101:402') && prof.unknown.includes('motor_daas:101:649') && prof.dependent.join() === 'motor_daas:101:402,motor_daas:101:649,motor_daas:102:1921,motor_daas:102:477', JSON.stringify(prof));
  check('4b. NORMAL uses the minder for the air filter; SEVERE (and dusty) uses every 15,000 mi; brake fluid under severe: not specified',
    prof.normal.includes('motor_daas:101:649') && !prof.normal.includes('motor_daas:101:402') && prof.severe.includes('motor_daas:101:402') && !prof.severe.includes('motor_daas:101:649') &&
    prof.dusty.join() === prof.severe.join() && prof.severe.includes('motor_daas:102:1921') && !prof.severe.includes('motor_daas:102:477'), JSON.stringify(prof));
  check('4c. the screen can say how much the profile changes (2 operations)', prof.diff.changed === 2 && prof.diff.names.sort().join() === 'Brake Hydraulic System Drain, Refill & Bleed,Engine Air Filter Element R&R', JSON.stringify(prof.diff));

  /* ================= 5. no history: nothing assumed ================= */
  const nohist = await page.evaluate(() => {
    const op = k => oemScheduleFor('v1').operations.find(o => o.key === k);
    const st = (k, o) => { const r = oemDue('v1', op(k), Object.assign({ today: '2026-09-13' }, o)); return { s: r.status, d: r.detail, due: r.dueMileage }; };
    return {
      rotate64k: st('motor_daas:107:2451', { mileage: 64000 }), rotate3k: st('motor_daas:107:2451', { mileage: 3000 }),
      coolant64k: st('motor_daas:105:900', { mileage: 64000 }), coolant9k: st('motor_daas:105:900', { mileage: 9000 }),
      brake: st('motor_daas:102:477', { mileage: 64000 }), oil: st('motor_daas:103:2386', { mileage: 64000 }),
      pump: st('motor_daas:104:1831', { mileage: 64000 }), belt: st('motor_daas:106:950', { mileage: 64000 })
    };
  });
  check('5a. mileage-only, no history, past the first interval: DUE BY SCHEDULE + LAST SERVICE UNKNOWN (status UNKNOWN, never NOT YET DUE)',
    nohist.rotate64k.s === 'UNKNOWN' && /DUE BY SCHEDULE \+ LAST SERVICE UNKNOWN/.test(nohist.rotate64k.d) && /SERVICE HISTORY REQUIRED/.test(nohist.rotate64k.d), JSON.stringify(nohist.rotate64k));
  check('5b. before the first scheduled point it is simply NOT YET DUE (due at 7,500 mi)', nohist.rotate3k.s === 'NOT YET DUE' && nohist.rotate3k.due === 7500, JSON.stringify(nohist.rotate3k));
  check('5c. whichever-first with no history is UNKNOWN even when the mileage is low - time since service is unknown',
    nohist.coolant9k.s === 'UNKNOWN' && /time since last service unknown/.test(nohist.coolant9k.d) && nohist.coolant64k.s === 'UNKNOWN' && /DUE BY SCHEDULE/.test(nohist.coolant64k.d), JSON.stringify([nohist.coolant9k, nohist.coolant64k]));
  check('5d. time-only, minder, not-specified and unknown-code items with no history are UNKNOWN / NO VERIFIED SCHEDULE, never guessed',
    nohist.brake.s === 'UNKNOWN' && /LAST SERVICE UNKNOWN/.test(nohist.brake.d) && nohist.oil.s === 'UNKNOWN' && /MAINTENANCE MINDER — due when the vehicle shows Service A/.test(nohist.oil.d) &&
    nohist.pump.s === 'NO VERIFIED SCHEDULE' && /NO VERIFIED INTERVAL — DO NOT GUESS/.test(nohist.pump.d) && nohist.belt.s === 'NO VERIFIED SCHEDULE', JSON.stringify(nohist));

  /* ================= 6. history known ================= */
  const hist = await page.evaluate(() => {
    const op = k => oemScheduleFor('v1').operations.find(o => o.key === k);
    const errs = [];
    for (const bad of [{ mileage: '55000', date: '2025-01-10', source: '' }, { mileage: '', date: '', source: 'Receipt' }, { mileage: 'abc', source: 'Receipt' }, { date: '10/01/2025', source: 'Receipt' }]){
      try { oemMarkCompleted('v1', op('motor_daas:107:2451'), bad); errs.push('accepted'); } catch (e){ errs.push(e.message); }
    }
    oemMarkCompleted('v1', op('motor_daas:107:2451'), { mileage: '55000', date: '2025-01-10', source: 'Receipt', detail: 'Les Schwab #4411' });
    const st = (k, o) => { const r = oemDue('v1', op(k), Object.assign({ today: '2026-09-13' }, o)); return { s: r.status, due: r.dueMileage, date: r.dueDate, d: r.detail, last: r.last && r.last.source }; };
    const rot = { at60k: st('motor_daas:107:2451', { mileage: 60000 }), at61800: st('motor_daas:107:2451', { mileage: 61800 }), at62500: st('motor_daas:107:2451', { mileage: 62500 }),
      at63600: st('motor_daas:107:2451', { mileage: 63600 }) };
    oemMarkCompleted('v1', op('motor_daas:102:477'), { date: '2023-01-10', source: 'Service sticker' });
    const brakeOver = st('motor_daas:102:477', { mileage: 64000 });
    oemMarkCompleted('v1', op('motor_daas:102:477'), { date: '2023-09-01', source: 'Customer states' });
    const brakeNow = st('motor_daas:102:477', { mileage: 64000 });
    const brakeSoon = st('motor_daas:102:477', { mileage: 64000, today: '2026-08-10' });
    const brakeLater = st('motor_daas:102:477', { mileage: 64000, today: '2026-01-10' });
    oemMarkCompleted('v1', op('motor_daas:105:900'), { mileage: '50000', date: '2024-01-15', source: 'External record' });
    const coolantTime = st('motor_daas:105:900', { mileage: 60000 });
    const coolantMiles = st('motor_daas:105:900', { mileage: 81500, today: '2025-06-01' });
    const coolantBoth = st('motor_daas:105:900', { mileage: 60000, today: '2025-06-01' });
    oemMarkCompleted('v1', op('motor_daas:103:2386'), { mileage: '58000', date: '2025-12-01', source: 'Shop history' });
    const oil = st('motor_daas:103:2386', { mileage: 64000 });
    return { errs, rot, brakeOver, brakeNow, brakeSoon, brakeLater, coolantTime, coolantMiles, coolantBoth, oil, stored: db.oemMaint.history.length,
      inBook: JSON.parse(JSON.stringify(db)).oemMaint.history.some(h => h.detail === 'Les Schwab #4411') };
  });
  check('6a. MARK PREVIOUSLY COMPLETED needs a source, and a mileage or date in a usable form', hist.errs.every(e => e !== 'accepted') && /Choose where/.test(hist.errs[0]) &&
    /mileage, the date, or both/.test(hist.errs[1]) && /number/.test(hist.errs[2]) && /YYYY-MM-DD/.test(hist.errs[3]), JSON.stringify(hist.errs));
  check('6b. mileage: last 55,000 + 7,500 = due 62,500 → NOT YET DUE, DUE SOON, DUE NOW, OVERDUE at the shop\'s 1,000-mile window',
    hist.rot.at60k.s === 'NOT YET DUE' && hist.rot.at60k.due === 62500 && hist.rot.at61800.s === 'DUE SOON' && hist.rot.at62500.s === 'DUE NOW' && hist.rot.at63600.s === 'OVERDUE' &&
    hist.rot.at60k.last === 'Receipt', JSON.stringify(hist.rot));
  check('6c. time: 36 months from the recorded date → OVERDUE, DUE NOW, DUE SOON, NOT YET DUE; the newest record counts',
    hist.brakeOver.s === 'OVERDUE' && hist.brakeNow.s === 'DUE NOW' && hist.brakeNow.date === '2026-09-01' && hist.brakeSoon.s === 'DUE SOON' && hist.brakeLater.s === 'NOT YET DUE', JSON.stringify([hist.brakeOver, hist.brakeNow, hist.brakeSoon, hist.brakeLater]));
  check('6d. whichever first: time can make it due before mileage does, and mileage before time',
    hist.coolantTime.s === 'OVERDUE' && hist.coolantTime.due === 80000 && hist.coolantMiles.s === 'OVERDUE' && hist.coolantBoth.s === 'NOT YET DUE', JSON.stringify([hist.coolantTime, hist.coolantMiles, hist.coolantBoth]));
  check('6e. maintenance minder with a time backstop: due by the 12 months unless the vehicle asks sooner', hist.oil.s === 'NOT YET DUE' && hist.oil.date === '2026-12-01' &&
    /or sooner if the vehicle shows Service A/.test(hist.oil.d), JSON.stringify(hist.oil));
  check('6f. service history is shop data in the book (it syncs)', hist.inBook && hist.stored === 5);

  /* ================= 7. a person's verified OEM items ================= */
  const man = await page.evaluate(() => {
    const errs = [];
    for (const bad of [{ name: 'Oil', type: 'mileage', miles: 5000, verifiedBy: 'Zack' }, { name: 'Oil', type: 'mileage', miles: 5000, document: 'OM p.1' }, { name: 'Oil', type: 'mileage', document: 'OM p.1', verifiedBy: 'Z' },
      { name: 'Oil', type: 'guess', miles: 5000, document: 'OM p.1', verifiedBy: 'Z' }]){
      try { oemAddManual('v2', bad); errs.push('accepted'); } catch (e){ errs.push(e.message); }
    }
    const first = oemAddManual('v2', { name: 'Engine oil and filter', action: 'REPLACE', type: 'initial-then-repeat', initialMiles: 5000, miles: 10000, document: "Owner's warranty & maintenance guide p. 12", verifiedBy: 'Zack' });
    const once = oemAddManual('v2', { name: 'Break-in oil change', type: 'initial-then-repeat', initialMiles: 1200, document: 'OM p. 3', verifiedBy: 'Zack' });
    const cond = oemAddManual('v2', { name: 'Brake pads', action: 'INSPECT', type: 'condition', document: 'OM p. 14', verifiedBy: 'Zack' });
    const s = oemScheduleFor('v2');
    const st = (op, o) => { const r = oemDue('v2', op, Object.assign({ today: '2026-09-13' }, o)); return { s: r.status, due: r.dueMileage, d: r.detail }; };
    const a = st(first, { mileage: 3000 }), b = st(first, { mileage: 7000 });
    oemMarkCompleted('v2', first, { mileage: '5100', source: 'Shop history' });
    const c = st(first, { mileage: 7000 });
    const onceBefore = st(once, { mileage: 100 });
    oemMarkCompleted('v2', once, { mileage: '1250', source: 'Receipt' });
    const onceAfter = st(once, { mileage: 3000 });
    return { errs, label: s.label, env: s.environment, a, b, c, cond: st(cond, { mileage: 3000 }), onceBefore, onceAfter, verified: first.verified,
      v1Primary: oemScheduleFor('v1').label };
  });
  check('7a. a verified OEM item needs the manufacturer document, who verified it, and the interval as stated', man.errs.every(e => e !== 'accepted') &&
    /document/.test(man.errs[0]) && /who verified/.test(man.errs[1]) && /miles/.test(man.errs[2]) && /how the interval/.test(man.errs[3]), JSON.stringify(man.errs));
  check('7b. it is labelled MANUALLY VERIFIED OEM and keeps its document', man.label === 'MANUALLY VERIFIED OEM' && man.env === 'manual' && /warranty & maintenance guide/.test(man.verified.document) && man.verified.by === 'Zack');
  check('7c. first-then-repeat: NOT YET DUE before 5,000; UNKNOWN (by schedule, history unknown) after; from a record at 5,100 the next is 15,100',
    man.a.s === 'NOT YET DUE' && man.a.due === 5000 && man.b.s === 'UNKNOWN' && /DUE BY SCHEDULE \+ LAST SERVICE UNKNOWN/.test(man.b.d) && man.c.s === 'NOT YET DUE' && man.c.due === 15100, JSON.stringify([man.a, man.b, man.c]));
  check('7d. a one-time item is COMPLETED once recorded; a condition-based item is UNKNOWN and says so',
    man.onceBefore.s === 'NOT YET DUE' && man.onceAfter.s === 'COMPLETED' && man.cond.s === 'UNKNOWN' && /CONDITION-BASED/.test(man.cond.d), JSON.stringify([man.onceBefore, man.onceAfter, man.cond]));
  check('7e. a licensed provider\'s schedule outranks a hand-verified one', man.v1Primary === 'OEM SCHEDULE — MOTOR');

  /* ================= 8. on screen ================= */
  await page.evaluate(() => { oemSetProfile('v1', 'NORMAL'); detailVeh = 'v1'; go('vehDetail'); });
  await wait(300);
  const scr = await page.evaluate(() => {
    const box = document.getElementById('oemMaint');
    return { text: box.innerText, label: box.querySelector('[data-oemlabel]').textContent, rows: box.querySelectorAll('[data-oemop]').length,
      statuses: Array.from(box.querySelectorAll('[data-oemstatus]')).map(e => e.textContent), profile: document.getElementById('oemProfile').value,
      profRec: db.oemMaint.profiles.v1 };
  });
  check('8a. the vehicle shows MAINTENANCE — OEM schedule with its label, provenance and statuses', scr.label === 'OEM SCHEDULE — MOTOR' &&
    /PRODUCTION/.test(scr.text) && /VIN 19XFC2F59KE000001/.test(scr.text) && /provider vehicle 22124/.test(scr.text) && scr.rows >= 7 &&
    scr.statuses.includes('NO VERIFIED SCHEDULE') && /LAST SERVICE UNKNOWN/.test(scr.text), scr.text.slice(0, 900));
  check('8b. the usage profile is chosen on screen, kept with who and when, and the screen says it changes the schedule',
    scr.profile === 'NORMAL' && scr.profRec.profile === 'NORMAL' && scr.profRec.previous === 'UNKNOWN' && /Changing the profile changes 2 operation/.test(scr.text), JSON.stringify(scr.profRec));

  /* mark previously completed through the form */
  const tireKey = 'motor_daas:107:2451';
  await page.click(`[data-oemop="${tireKey}"] >> text=MARK PREVIOUSLY COMPLETED…`);
  await page.fill('#oh_mi', '63000'); await page.fill('#oh_date', '2026-08-20'); await page.selectOption('#oh_src', 'Service sticker'); await page.fill('#oh_detail', 'windshield sticker');
  await page.click('#oh_save');
  await wait(200);
  const formRec = await page.evaluate(k => ({ rec: db.oemMaint.history.find(h => h.detail === 'windshield sticker'), status: document.querySelector(`[data-oemop="${k}"] [data-oemstatus]`).textContent,
    row: document.querySelector(`[data-oemop="${k}"]`).innerText }), tireKey);
  check('8c. MARK PREVIOUSLY COMPLETED on screen records mileage, date and source, and the row recalculates', !!formRec.rec && formRec.rec.source === 'Service sticker' &&
    formRec.rec.mileage === '63000' && /63,000 mi/.test(formRec.row) && /Service sticker/.test(formRec.row) && formRec.status === 'NOT YET DUE', JSON.stringify(formRec));

  /* ================= 9. ADD TO ESTIMATE ================= */
  const est = await page.evaluate(() => {
    const before = Object.keys(db.orders).length;
    const r = oemAddToEstimate('v1', 'motor_daas:105:900');
    const o = db.orders[r.orderId];
    const l = r.line;
    return { created: Object.keys(db.orders).length === before + 1, status: o.status, ticket: ticketNo(o), approved: lineApproved(o, l), auth: o.auth.state,
      desc: l.desc, source: l.source, hours: l.hours, maint: l.maint, type: l.type, provLicensed: !!l.provenance };
  });
  check('9a. ADD TO ESTIMATE puts the OEM operation on an estimate, keeping operation, provider, reason, due and source',
    est.created && est.status === 'Estimate' && /^EST-/.test(est.ticket) && est.desc === 'Coolant Replace' && est.maint.providerId === 'motor_daas' &&
    est.maint.operationId === '105' && est.maint.scheduleId === '900' && est.maint.label === 'OEM SCHEDULE — MOTOR' && /^(OVERDUE|DUE NOW|DUE SOON|UNKNOWN|NOT YET DUE)/.test(est.maint.reason) &&
    est.maint.environment === 'production' && est.maint.lastService && est.maint.lastService.source === 'External record', JSON.stringify(est).slice(0, 700));
  check('9b. it is not authorized, and the labor is not labelled MOTOR (no time was set from MOTOR)', est.approved === false && est.auth === 'Not Requested' &&
    est.source === 'MANUAL' && est.hours === '' && !est.provLicensed && /labor time is not from that source/.test(est.maint.note), JSON.stringify(est));

  /* ================= 10. the inspection ================= */
  const mpi = await page.evaluate(async () => {
    db.orders.o9 = shapeOrder({ id: 'o9', customerId: 'c1', vehicleId: 'v1', date: '2026-09-13', status: 'In Progress', estimateNo: 99, mileageIn: '64000', labor: [], parts: [], extras: [], payments: [], history: [] });
    const insp = newInspection('o9', 'v1'); insp.mileage = '64000';
    Object.assign(inspItem(insp, 'tires.tire.LF').meas, { tread: '7' }); setInspState(insp, 'tires.tire.LF', 'Good');
    save();
    const before = JSON.stringify(insp);
    openInspection('o9');
    await new Promise(r => setTimeout(r, 200));
    renderInspection();
    const el = document.getElementById('oemMpiDue');
    const text = el && el.textContent;
    el.click();
    await new Promise(r => setTimeout(r, 100));
    const overlay = document.getElementById('recSheet').innerText;
    closeRec();
    return { text, overlay, same: JSON.stringify(db.inspections[insp.id]) === before, states: inspSummary(db.inspections[insp.id]) };
  });
  check('10a. the inspection shows a quiet OEM MAINTENANCE DUE indicator with what is due', /^OEM MAINTENANCE DUE: \d+$/.test(mpi.text || '') && /OEM MAINTENANCE DUE/.test(mpi.overlay) &&
    /does not change any inspection result/.test(mpi.overlay), JSON.stringify(mpi).slice(0, 500));
  check('10b. nothing on the inspection changes because of it - no item added, no result marked', mpi.same && mpi.states.Urgent === 0 && mpi.states['Needs Attention'] === 0, JSON.stringify(mpi.states));

  /* ================= 11. a v2.8.2 book, credentials ================= */
  const book = await page.evaluate(() => {
    const old = JSON.parse(JSON.stringify(db)); delete old.oemMaint;
    const shaped = shapeDb ? shapeDb(old) : null;
    return { shaped: shaped && shaped.oemMaint, secrets: JSON.stringify(db).indexOf('priv') >= 0 && /"priv"/.test(JSON.stringify(db)) };
  }).catch(e => ({ err: String(e) }));
  check('11a. a book without OEM maintenance (v2.8.2) opens with an empty, valid section', book.shaped && Array.isArray(book.shaped.history) && !!book.shaped.profiles && !!book.shaped.manual, JSON.stringify(book));
  check('11b. no provider credential is in the book', book.secrets === false, JSON.stringify(book));
  check('12. no script errors', errs.length === 0, errs.join(' | '));

  await browser.close();
  if (failures.length){ console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('\nALL OEM MAINTENANCE CHECKS PASSED');
  process.exit(0);
})();
