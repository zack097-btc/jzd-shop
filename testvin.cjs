/* The VIN, matching and pricing suite.

   These are the checks that stand between a service writer and a wrong number
   on a customer's invoice. The expensive mistakes in a shop program are not
   crashes — they are a $30 tire repair quoted at $120 because a menu price got
   multiplied by the door rate, an E46 labor time billed on an E9x, or a
   catalog time nudged by somebody nobody can name afterwards. Every test below
   exists because one of those is possible if the code is wrong.

   The network is never touched: window.fetch is replaced per test, so the
   suite is deterministic and runs with the internet off. */
const { chromium } = require('playwright');

const VIN_F80 = 'WBS8M9C55J5J78069';   /* 2018 BMW M3 (F80, S55) */
const VIN_F250 = '1FT7W2BT5KEC12345';  /* shaped like a 2019 F-250 diesel */

/* What vPIC actually returns, trimmed to the fields the app reads. */
const DECODE_F80 = {
  VIN: VIN_F80, ModelYear: '2018', Make: 'BMW', Model: 'M3', Series: '3-Series',
  BodyClass: 'Sedan/Saloon', Manufacturer: 'BMW M GMBH', EngineCylinders: '6',
  DisplacementL: '3', FuelTypePrimary: 'Gasoline', VehicleType: 'PASSENGER CAR',
  GVWR: 'Class 1: 6,000 lb or less (2,722 kg or less)', PlantCountry: 'GERMANY',
  ErrorCode: '1', ErrorText: '1 - Check Digit (9th position) does not calculate properly'
};
const DECODE_F250 = {
  VIN: VIN_F250, ModelYear: '2019', Make: 'FORD', Model: 'F-250', Series: 'Super Duty',
  BodyClass: 'Pickup', EngineCylinders: '8', DisplacementL: '6.7',
  FuelTypePrimary: 'Diesel', DriveType: '4WD/4-Wheel Drive/4x4', VehicleType: 'TRUCK',
  GVWR: 'Class 3: 10,001 - 14,000 lb (4,536 - 6,350 kg)', ErrorCode: '0', ErrorText: '0 - VIN decoded clean. Check Digit (9th position) is correct'
};

const results = {};
const failures = [];
function check(name, cond, detail) {
  results[name] = cond ? 'PASS' : ('FAIL' + (detail ? ' — ' + detail : ''));
  if (!cond) failures.push(name + (detail ? ': ' + detail : ''));
}

/* Replace fetch inside the page. mode: 'ok' answers, 'fail' rejects,
   'hang' never settles so the abort timeout is the thing under test. */
async function stubFetch(page, mode, payload) {
  await page.evaluate(([mode, payload]) => {
    window.__fetchCalls = 0;
    window.fetch = (url, opt) => {
      window.__fetchCalls++;
      if (mode === 'fail') return Promise.reject(new Error('net down'));
      if (mode === 'hang') return new Promise((_, rej) => {
        if (opt && opt.signal) opt.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        });
      });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ Results: [payload] }) });
    };
  }, [mode, payload || {}]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('PAGEERR: ' + e.message));
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

  await page.goto('file://' + process.cwd().replace(/\\/g, '/') + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(400);

  /* ---- 1. a VIN is normalized and validated before anything is looked up ---- */
  results.vinNormalization = await page.evaluate(() => {
    const r = {};
    r.lowercasePadded = normalizeVin(' wbs8m9c55j5j78069 ').vin;
    r.acceptsValid = normalizeVin('WBS8M9C55J5J78069').ok;
    r.rejectsShort = !normalizeVin('ABC123').ok;
    r.rejectsLetterO = !normalizeVin('WBS8M9C55J5J7O069').ok;
    r.rejectsSymbols = !normalizeVin('WBS8M9C55J5J780*9').ok;
    r.rejectsEmpty = !normalizeVin('').ok;
    /* A bad check digit is REPORTED, never a rejection: not every market
       applies the rule, and the car is in the bay either way. */
    r.badCheckDigitStillAccepted = normalizeVin('WBS8M9C55J5J78069').ok;
    r.checkDigitReported = normalizeVin('WBS8M9C55J5J78069').check.matches === false;
    return r;
  });
  check('1. VIN normalization and validation',
    results.vinNormalization.lowercasePadded === VIN_F80 &&
    results.vinNormalization.acceptsValid && results.vinNormalization.rejectsShort &&
    results.vinNormalization.rejectsLetterO && results.vinNormalization.rejectsSymbols &&
    results.vinNormalization.rejectsEmpty && results.vinNormalization.badCheckDigitStillAccepted &&
    results.vinNormalization.checkDigitReported,
    JSON.stringify(results.vinNormalization));

  /* ---- 2. a decode becomes a normalized vehicle ---- */
  await stubFetch(page, 'ok', DECODE_F80);
  results.decode = await page.evaluate(async v => {
    const d = await decodeVin(v);
    return { year: d.year, make: d.make, model: d.model, cylinders: d.cylinders,
             fuel: d.fuelType, provider: d.provider, hasRaw: !!d.raw && Object.keys(d.raw).length > 0,
             decodedAt: !!d.decodedAt, warnings: d.warnings.length };
  }, VIN_F80);
  check('2. vPIC decode becomes a normalized vehicle',
    results.decode.year === '2018' && results.decode.make === 'BMW' && results.decode.model === 'M3' &&
    results.decode.cylinders === '6' && results.decode.provider === 'NHTSA vPIC' &&
    results.decode.hasRaw && results.decode.decodedAt && results.decode.warnings >= 1,
    JSON.stringify(results.decode));

  /* ---- 4. the same VIN is not looked up twice ---- */
  results.cache = await page.evaluate(async v => {
    const before = window.__fetchCalls;
    const d = await decodeVin(v);
    return { extraCalls: window.__fetchCalls - before, stillDecoded: d.make === 'BMW', inBook: !!db.vinCache[v] };
  }, VIN_F80);
  check('4. a repeated VIN decode uses the cached identity',
    results.cache.extraCalls === 0 && results.cache.stillDecoded && results.cache.inBook,
    JSON.stringify(results.cache));

  /* ---- 3. the network failing is not a crash, and never a wrong answer ---- */
  await stubFetch(page, 'fail');
  results.netFail = await page.evaluate(async () => {
    try { await decodeVin('1FTFW1ET5DFA12345'); return { threw: false }; }
    catch (e) { return { threw: true, msg: e.message, cached: !!db.vinCache['1FTFW1ET5DFA12345'] }; }
  });
  check('3a. a failed decode raises and caches nothing',
    results.netFail.threw && results.netFail.cached === false, JSON.stringify(results.netFail));

  await stubFetch(page, 'hang');
  const t0 = Date.now();
  results.netTimeout = await page.evaluate(async () => {
    try { await vpicDecode('1FTFW1ET5DFA12345', { timeout: 250, tries: 2 }); return { threw: false }; }
    catch (e) { return { threw: true, msg: e.message }; }
  });
  results.netTimeout.elapsedMs = Date.now() - t0;
  check('3b. a hung request times out and gives the manual path',
    results.netTimeout.threw && results.netTimeout.elapsedMs < 4000, JSON.stringify(results.netTimeout));

  /* the manual path still works with no VIN at all */
  results.manualFallback = await page.evaluate(() => {
    db.vehicles.mv = { id: 'mv', customerId: '', year: '2012', make: 'Toyota', model: 'Camry', vin: '' };
    const p = vehicleProfile(db.vehicles.mv);
    return { year: p.year, make: p.make, decoded: p.decoded, jobs: searchCatalog(p, '').length };
  });
  check('3c. a hand-typed vehicle with no VIN still finds jobs',
    results.manualFallback.year === 2012 && results.manualFallback.decoded === false &&
    results.manualFallback.jobs > 0, JSON.stringify(results.manualFallback));

  /* ---- 5. every catalog row survives, exactly once ---- */
  results.catalogImport = await page.evaluate(() => {
    const ids = SEED.map(r => r.id);
    const sections = {}; SEED.forEach(r => sections[r.sec] = (sections[r.sec] || 0) + 1);
    const priced = SEED.filter(r => (r.bill === 'H' && r.hrs != null) || (r.bill === 'F' && r.fix != null)).length;
    /* Idempotent by construction: the catalog is the shipped seed, and looking
       it up twice cannot produce a second copy. */
    const twice = Object.keys(SEED_BY_ID).length;
    return { rows: SEED.length, unique: new Set(ids).size, sections, priced, twice,
             byIdResolves: SEED.every(r => SEED_BY_ID[r.id] === r) };
  });
  check('5. every catalog row is present, unique and priced',
    results.catalogImport.rows === 245 && results.catalogImport.unique === 245 &&
    results.catalogImport.priced === 245 && results.catalogImport.twice === 245 &&
    results.catalogImport.byIdResolves, JSON.stringify(results.catalogImport));

  /* ---- 6 + 8. the pricing rule that costs real money ---- */
  results.pricing = await page.evaluate(() => {
    db.settings.laborRate = 112.50;
    const hourly = SEED.find(r => r.bill === 'H' && r.hrs === 1);
    const fixed = SEED_BY_ID['MENU-TIRE-001'];
    return {
      rate: shopRate(),
      hourlyId: hourly.id, hourlyHours: hourly.hrs, hourlyCharge: seedCharge(hourly),
      fixedId: fixed.id, fixedPrice: fixed.fix, fixedCharge: seedCharge(fixed),
      fixedAt200: (() => { db.settings.laborRate = 200; const c = seedCharge(fixed); db.settings.laborRate = 112.50; return c; })()
    };
  });
  check('6. an hourly job bills hours x the shop rate',
    Math.abs(results.pricing.hourlyCharge - results.pricing.hourlyHours * 112.5) < 0.005,
    JSON.stringify(results.pricing));
  check('8. a menu price is never multiplied by the door rate',
    results.pricing.fixedCharge === results.pricing.fixedPrice &&
    results.pricing.fixedAt200 === results.pricing.fixedPrice,
    'menu stayed at ' + results.pricing.fixedCharge + ' and at a $200 rate ' + results.pricing.fixedAt200);

  /* ---- 9. an E46 time must never land on an E9x ---- */
  results.m3 = await page.evaluate(() => {
    const mk = (year, cyl) => vehicleProfile({ id: 'x', year: String(year), make: 'BMW', model: 'M3',
      vin: '', decoded: { year: String(year), make: 'BMW', model: 'M3', cylinders: String(cyl) } });
    const gens = {};
    [[1990, 4, 'E30'], [1997, 6, 'E36'], [2004, 6, 'E46'], [2011, 8, 'E90/E92/E93'], [2018, 6, 'F80'], [2023, 6, 'G80/G81']]
      .forEach(([y, c, want]) => {
        const p = mk(y, c);
        const hits = searchCatalog(p, '');
        const m3rows = hits.filter(h => h.row.sec === 'BMW M3');
        gens[want] = {
          detected: p.m3 && p.m3.key,
          engine: p.m3 && p.m3.engine,
          ownGenRows: m3rows.filter(h => h.row.scope.indexOf(want) >= 0).length,
          foreignGenRows: m3rows.filter(h => h.row.scope.indexOf(want) < 0).length,
          allExact: m3rows.every(h => h.cls === 'EXACT_SEED_MATCH' || h.cls === 'NEEDS_CONFIGURATION'),
          topIsM3: hits.length > 0 && hits[0].row.sec === 'BMW M3'
        };
      });
    /* a BMW that is not an M3 gets no M3 rows at all */
    const notM3 = vehicleProfile({ id: 'y', year: '2018', make: 'BMW', model: '330i', vin: '',
      decoded: { year: '2018', make: 'BMW', model: '330i', cylinders: '4' } });
    gens.non_m3_bmw_rows = searchCatalog(notM3, '').filter(h => h.row.sec === 'BMW M3').length;
    return gens;
  });
  const m3ok = ['E30', 'E36', 'E46', 'E90/E92/E93', 'F80', 'G80/G81'].every(k =>
    results.m3[k].detected === k && results.m3[k].ownGenRows > 0 &&
    results.m3[k].foreignGenRows === 0 && results.m3[k].topIsM3);
  check('9. each M3 generation gets its own jobs and no other generation\'s',
    m3ok && results.m3.non_m3_bmw_rows === 0, JSON.stringify(results.m3));

  /* ---- 10. trucks ---- */
  await stubFetch(page, 'ok', DECODE_F250);
  results.truck = await page.evaluate(async v => {
    const d = await decodeVin(v);
    db.vehicles.tv = { id: 'tv', customerId: '', year: d.year, make: d.make, model: d.model, vin: v };
    const p = vehicleProfile(db.vehicles.tv);
    const hits = searchCatalog(p, '');
    const tf = hits.filter(h => h.row.sec === 'Truck & Fleet');
    return {
      isTruck: !!p.truck, hd: p.truck && p.truck.hd, diesel: p.diesel, fourWd: p.fourWd,
      truckRows: tf.length, truckClassMatches: tf.filter(h => h.cls === 'TRUCK_CLASS_MATCH').length,
      dieselRows: tf.filter(h => /diesel/i.test(h.row.scope)).length,
      halfTonRowsShown: tf.filter(h => /1\/2-ton/.test(h.row.scope)).length,
      m3RowsShown: hits.filter(h => h.row.sec === 'BMW M3').length,
      topSection: hits[0] && hits[0].row.sec
    };
  }, VIN_F250);
  check('10. a 3/4-ton diesel 4WD gets truck jobs, and not half-ton or M3 ones',
    results.truck.isTruck && results.truck.hd && results.truck.diesel && results.truck.fourWd &&
    results.truck.truckRows > 0 && results.truck.dieselRows > 0 &&
    results.truck.halfTonRowsShown === 0 && results.truck.m3RowsShown === 0,
    JSON.stringify(results.truck));

  /* ---- 11. the everyday work never disappears behind the specific work ---- */
  results.universal = await page.evaluate(() => {
    const m3 = vehicleProfile({ id: 'z', year: '2018', make: 'BMW', model: 'M3', vin: '',
      decoded: { year: '2018', make: 'BMW', model: 'M3', cylinders: '6' } });
    const all = searchCatalog(m3, '');
    const truck = vehicleProfile(db.vehicles.tv);
    const truckAll = searchCatalog(truck, '');
    return {
      m3SeesFlatRepair: all.some(h => h.row.id === 'MENU-TIRE-001'),
      m3SeesAlignment: all.some(h => /alignment/i.test(h.row.svc)),
      m3MenuRows: all.filter(h => h.row.sec === 'Market Menu').length,
      truckSeesMenu: truckAll.filter(h => h.row.sec === 'Market Menu').length,
      lofByAlias: searchCatalog(m3, 'LOF').length,
      plugsByAlias: searchCatalog(m3, 'plugs').length,
      byServiceId: searchCatalog(m3, 'MENU-TIRE-001').length,
      serpByAlias: searchCatalog(truck, 'serp belt').length
    };
  });
  check('11. menu and universal jobs stay reachable, including by the words a writer types',
    results.universal.m3SeesFlatRepair && results.universal.m3MenuRows > 0 &&
    results.universal.truckSeesMenu > 0 && results.universal.lofByAlias > 0 &&
    results.universal.plugsByAlias > 0 && results.universal.byServiceId > 0 &&
    results.universal.serpByAlias > 0, JSON.stringify(results.universal));

  /* ---- 12. the verification warning actually appears ---- */
  results.verify = await page.evaluate(() => {
    const flagged = SEED.filter(r => r.ver === 1);
    const row = flagged[0];
    db.customers.c9 = { id: 'c9', name: 'Test Owner' };
    db.vehicles.v9 = { id: 'v9', customerId: 'c9', year: '2018', make: 'BMW', model: 'M3', vin: '' };
    editOrder(null, { customerId: 'c9', vehicleId: 'v9' });
    addJob(row.id);
    const line = cur.labor[cur.labor.length - 1];
    const banner = document.getElementById('verifyBanner').textContent;
    const meta = document.getElementById('laborRows').textContent;
    return { flaggedCount: flagged.length, lineVerify: line.verify,
             bannerShown: /Verify before you quote/i.test(banner),
             bannerNamesJob: banner.indexOf(row.svc) >= 0,
             badgeShown: /VERIFY/.test(meta) };
  });
  check('12. a job flagged for verification warns before it can be quoted',
    results.verify.flaggedCount === 37 && results.verify.lineVerify === true &&
    results.verify.bannerShown && results.verify.bannerNamesJob && results.verify.badgeShown,
    JSON.stringify(results.verify));

  /* ---- 15. where the number came from survives onto the order ---- */
  results.provenance = await page.evaluate(() => {
    const line = cur.labor[cur.labor.length - 1];
    return { source: line.source, serviceId: line.serviceId, cls: line.cls,
             provider: line.provenance && line.provenance.provider,
             sourceHours: line.provenance && line.provenance.sourceHours,
             fetchedAt: !!(line.provenance && line.provenance.fetchedAt),
             neverClaimsALicensedGuide: !/motor|mitchell|alldata|oem/i.test(JSON.stringify(line.provenance)) };
  });
  check('15. the source and provenance ride along onto the work order line',
    results.provenance.source === 'SHOP SEED' && !!results.provenance.serviceId &&
    !!results.provenance.cls && results.provenance.provider === 'Shop seed catalog' &&
    results.provenance.sourceHours != null && results.provenance.fetchedAt &&
    results.provenance.neverClaimsALicensedGuide, JSON.stringify(results.provenance));

  /* ---- 7. the rate moves a draft, never an invoice ---- */
  results.rateChange = await page.evaluate(() => {
    db.settings.laborRate = 112.50;
    const hourly = SEED.find(r => r.bill === 'H' && r.hrs >= 1);
    db.customers.c8 = { id: 'c8', name: 'Rate Test' };
    db.vehicles.v8 = { id: 'v8', customerId: 'c8', year: '2015', make: 'Ford', model: 'F-150', vin: '' };

    editOrder(null, { customerId: 'c8', vehicleId: 'v8' });
    addJob(hourly.id);
    const draft = JSON.parse(JSON.stringify(cur));
    const draftBefore = orderTotals(draft).labor;

    /* the same order, once it has become an invoice */
    const invoice = JSON.parse(JSON.stringify(cur));
    invoice.status = 'Invoiced';
    freezeIfFinal(invoice);
    const invoiceBefore = orderTotals(invoice).labor;

    /* a line the shop typed a rate into by hand */
    const manual = JSON.parse(JSON.stringify(cur));
    manual.labor[0].rateSource = 'manual';
    manual.labor[0].rate = 90;
    const manualBefore = orderTotals(manual).labor;

    /* a line written by an older version of the program, with no rateSource */
    const legacy = { status: 'Estimate', labor: [{ desc: 'old line', hours: '2', rate: 120 }], parts: [] };
    const legacyBefore = orderTotals(legacy).labor;

    db.settings.laborRate = 125;
    const after = { draft: orderTotals(draft).labor, invoice: orderTotals(invoice).labor,
                    manual: orderTotals(manual).labor, legacy: orderTotals(legacy).labor };
    db.settings.laborRate = 112.50;
    return { hours: hourly.hrs, draftBefore, invoiceBefore, manualBefore, legacyBefore, after };
  });
  check('7. a rate change moves a draft and leaves an invoice, a hand rate and old lines alone',
    Math.abs(results.rateChange.draftBefore - results.rateChange.hours * 112.5) < 0.005 &&
    Math.abs(results.rateChange.after.draft - results.rateChange.hours * 125) < 0.005 &&
    Math.abs(results.rateChange.after.invoice - results.rateChange.invoiceBefore) < 0.005 &&
    Math.abs(results.rateChange.after.manual - results.rateChange.manualBefore) < 0.005 &&
    Math.abs(results.rateChange.after.legacy - 240) < 0.005,
    JSON.stringify(results.rateChange));

  /* ---- 13 + 16. an override is allowed, but never anonymous ---- */
  results.override = await page.evaluate(() => {
    const row = SEED.find(r => r.bill === 'H' && r.hrs > 0);
    const seedHoursBefore = row.hrs;
    db.settings.requireOverrideReason = true;
    db.settings.managerPin = '';

    /* refusing to give a reason changes nothing */
    const realPrompt = window.prompt;
    window.prompt = q => /reason/i.test(q) ? null : (/hours|price/i.test(q) ? '9' : 'Zack');
    overrideSeed(row.id);
    const afterRefusal = !!db.catalog.overrides[row.id];

    /* giving a name and a reason records both */
    window.prompt = q => /reason/i.test(q) ? 'Customer supplied their own parts' : (/who/i.test(q) ? 'Zack' : '9');
    overrideSeed(row.id);
    const ov = db.catalog.overrides[row.id];
    const entry = db.audit[db.audit.length - 1];

    /* the wrong PIN is refused outright */
    db.settings.managerPin = '4242';
    window.prompt = q => /PIN/i.test(q) ? '0000' : (/reason/i.test(q) ? 'sneaky' : (/who/i.test(q) ? 'Nobody' : '1'));
    const row2 = SEED.filter(r => r.bill === 'H' && r.id !== row.id)[0];
    overrideSeed(row2.id);
    const blockedByPin = !db.catalog.overrides[row2.id];

    /* the right PIN goes through */
    window.prompt = q => /PIN/i.test(q) ? '4242' : (/reason/i.test(q) ? 'approved by manager' : (/who/i.test(q) ? 'Zack' : '1'));
    overrideSeed(row2.id);
    const allowedWithPin = !!db.catalog.overrides[row2.id];

    window.prompt = realPrompt;
    db.settings.managerPin = '';
    return {
      afterRefusal, blockedByPin, allowedWithPin,
      hours: ov && ov.hours, who: ov && ov.who, reason: ov && ov.reason, at: !!(ov && ov.at),
      seedUntouched: SEED_BY_ID[row.id].hrs === seedHoursBefore,
      effectiveUsesOverride: effectiveSeed(row).hours === 9,
      effectiveSource: effectiveSeed(row).source,
      auditAction: entry && entry.action, auditWho: entry && entry.who, auditFrom: entry && entry.from, auditTo: entry && entry.to,
      restores: (() => { delete db.catalog.overrides[row.id]; return effectiveSeed(row).hours === seedHoursBefore; })()
    };
  });
  check('13. an override records who and why, and never edits the catalog itself',
    results.override.afterRefusal === false && results.override.hours === 9 &&
    results.override.who === 'Zack' && /own parts/.test(results.override.reason || '') &&
    results.override.at && results.override.seedUntouched &&
    results.override.effectiveUsesOverride && results.override.effectiveSource === 'SHOP OVERRIDE' &&
    results.override.auditAction === 'catalog-override' && results.override.restores,
    JSON.stringify(results.override));
  check('16. a manager PIN keeps unauthorized hands off labor pricing',
    results.override.blockedByPin && results.override.allowedWithPin, JSON.stringify(results.override));

  /* ---- 14. no licensed provider configured is a normal, working state ---- */
  results.providers = await page.evaluate(async () => {
    const r = { motorActive: Providers.motor.active, mitchellActive: Providers.mitchell.active,
                alldataActive: Providers.alldata.active,
                vehicleActive: Providers.vehicle.active, laborActive: Providers.labor.active };
    try { await Providers.motor.searchOperations({}, 'brakes'); r.motorThrew = false; }
    catch (e) { r.motorThrew = true; r.motorMsg = e.message; }
    r.appStillWorks = searchCatalog(vehicleProfile(db.vehicles.v9), 'brakes').length > 0;
    /* enabling one must not silently change what the seed rows claim to be */
    db.settings.providers.motor.enabled = true;
    r.enablesCleanly = Providers.motor.active === true;
    db.settings.providers.motor.enabled = false;
    r.disablesCleanly = Providers.motor.active === false;
    const badge = effectiveSeed(SEED[0]).source;
    r.seedNeverClaimsAGuide = badge === 'SHOP SEED' || badge === 'SHOP OVERRIDE';
    return r;
  });
  check('14. with no licensed guide connected the app is fully usable and honest about it',
    results.providers.motorActive === false && results.providers.motorThrew &&
    results.providers.vehicleActive && results.providers.laborActive &&
    results.providers.appStillWorks && results.providers.enablesCleanly &&
    results.providers.disablesCleanly && results.providers.seedNeverClaimsAGuide,
    JSON.stringify(results.providers));

  /* ---- the seed data must never wear another company's name ---- */
  results.labelling = await page.evaluate(() => {
    const hay = SEED.map(r => r.sec + ' ' + r.svc + ' ' + r.note).join(' ');
    return {
      seedMentionsGuides: /\b(mitchell|alldata|motor data|prodemand|truspeed|oem warranty)\b/i.test(hay),
      sourceConstants: [SRC_SEED, SRC_OVERRIDE, SRC_MANUAL, SRC_VEHICLE]
    };
  });
  check('17. no catalog row is labelled as a licensed guide',
    results.labelling.seedMentionsGuides === false &&
    results.labelling.sourceConstants.join('|') === 'SHOP SEED|SHOP OVERRIDE|MANUAL|NHTSA VEHICLE ID',
    JSON.stringify(results.labelling));

  check('18. nothing threw while all of that happened', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();

  console.log(JSON.stringify(results, null, 1));
  console.log('');
  Object.keys(results).filter(k => typeof results[k] === 'string').forEach(k => console.log(' ' + results[k].padEnd(6) + ' ' + k));
  if (failures.length) {
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL VIN / LABOR / PRICING CHECKS PASSED');
})();
