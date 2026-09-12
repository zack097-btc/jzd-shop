/* The Data Provider Hub.

   What is under test, in order of how much it matters:
     * every result keeps its source, and a source is never dressed up as another;
     * sandbox data can never reach a customer document;
     * no credential ever lands in the book or a backup;
     * the shop keeps working with every external source down;
     * NHTSA's datasets are indexed, searched, and replaced only whole.

   NHTSA is served from fixtures shaped exactly like its live answers (captured
   during the build), and its flat files are real ZIP archives built here. The
   licensed APIs are exercised against fixtures shaped from their published
   Swagger documents. No request leaves this machine. */
const { chromium } = require('playwright');
const zlib = require('zlib');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const LS_KEY = 'jzd.shop.db';
const SECRET = 'SUPERSECRET-9f3a-DO-NOT-LEAK';

/* ---------- a real ZIP, built by hand ---------- */
const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return t; })();
function crc32(buf){ let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(name, text){
  const data = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(data), crc = crc32(data), nm = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + nm.length + comp.length, cdSize = 46 + nm.length;
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10);
  eo.writeUInt32LE(cdSize, 12); eo.writeUInt32LE(cdOff, 16);
  return Buffer.concat([lh, nm, comp, cd, nm, eo]);
}
/* NHTSA's manufacturer communications flat file: 14 tab-separated fields, one
   row per communication per model year per component. */
const tsv = rows => rows.map(r => r.join('\t')).join('\r\n') + '\r\n';
const MC_V1 = tsv([
  ['11011501', '', '20250310', 'SIB-11-07-25', '20250301', '', 'Service Bulletin/Repair Instructions', 'BMW', 'M3', '2018', 'ENGINE AND ENGINE COOLING', 'Engine', 'Cooling', 'Coolant loss at electric water pump; replace water pump and bleed cooling system with the ISTA routine.'],
  ['11011501', '', '20250310', 'SIB-11-07-25', '20250301', '', 'Service Bulletin/Repair Instructions', 'BMW', 'M3', '2018', 'ENGINE', 'Engine', 'Cooling', 'Coolant loss at electric water pump; replace water pump and bleed cooling system with the ISTA routine.'],
  ['11011501', '', '20250310', 'SIB-11-07-25', '20250301', '', 'Service Bulletin/Repair Instructions', 'BMW', 'M4', '2018', 'ENGINE AND ENGINE COOLING', 'Engine', 'Cooling', 'Coolant loss at electric water pump; replace water pump and bleed cooling system with the ISTA routine.'],
  ['11011522', '', '20250412', 'SIB-12-02-25', '20250405', 'P0597-SW', 'Over The Air', 'BMW', 'M3', '2018', 'ELECTRICAL SYSTEM', 'Electrical', 'DME', 'DME software update for fault P0597 thermostat heating circuit.'],
  ['11011600', '', '20250520', 'TSB-24-001', '20250515', '', 'Warranty Program / Extension', 'FORD', 'F-150', '2019', 'ENGINE', '', '', 'Extended coverage for cam phaser noise.']
]);
const MC_V2 = tsv([
  ['11019999', '', '20260102', 'SIB-11-99-26', '20251220', '', 'Service Bulletin/Repair Instructions', 'BMW', 'M3', '2018', 'ENGINE AND ENGINE COOLING', 'Engine', 'Cooling', 'Revised water pump part number supersedes earlier pump.']
]);
const INV = tsv([
  ['PE24001', 'BMW', 'M3', '2018', 'ENGINE AND ENGINE COOLING', 'BMW OF NORTH AMERICA, LLC', '20240115', '', '', 'Loss of coolant', 'NHTSA opened a preliminary evaluation into coolant loss reports.'],
  ['PE24001', 'BMW', 'M4', '2018', 'ENGINE AND ENGINE COOLING', 'BMW OF NORTH AMERICA, LLC', '20240115', '', '', 'Loss of coolant', 'NHTSA opened a preliminary evaluation into coolant loss reports.'],
  ['RQ19002', 'BMW', 'M3', '2018', 'STEERING', 'BMW OF NORTH AMERICA, LLC', '20190301', '20200110', '20V111000', 'Steering column', 'Closed with a recall.']
]);

/* ---------- live NHTSA answers, trimmed ---------- */
const RECALLS = { Count: 2, Message: 'Results returned successfully', results: [
  { Manufacturer: 'BMW of North America, LLC', NHTSACampaignNumber: '19V123000', parkIt: false, parkOutSide: false, overTheAirUpdate: false,
    ReportReceivedDate: '21/02/2019', Component: 'ENGINE AND ENGINE COOLING', Summary: 'Certain 2018 M3 vehicles may have a water pump that can fail.',
    Consequence: 'Engine overheating increases the risk of a crash.', Remedy: 'Dealers will replace the water pump, free of charge.', Notes: 'Owners may contact BMW.' },
  { Manufacturer: 'BMW of North America, LLC', NHTSACampaignNumber: '20V111000', parkIt: true, parkOutSide: false, overTheAirUpdate: false,
    ReportReceivedDate: '10/01/2020', Component: 'STEERING', Summary: 'Steering column bolt may loosen.', Consequence: 'Loss of steering.', Remedy: 'Inspect and tighten.', Notes: '' }
] };
const COMPLAINTS = { count: 3, message: 'Results returned successfully', results: [
  { odiNumber: 11759039, manufacturer: 'BMW of North America, LLC', crash: false, fire: false, numberOfInjuries: 0, numberOfDeaths: 0, dateOfIncident: '08/05/2026', dateComplaintFiled: '08/24/2026', vin: 'WBS8M9C53J5', components: 'ENGINE AND ENGINE COOLING', summary: 'Coolant warning then overheating on the highway.' },
  { odiNumber: 11700001, manufacturer: 'BMW of North America, LLC', crash: false, fire: true, numberOfInjuries: 0, numberOfDeaths: 0, dateOfIncident: '01/02/2025', dateComplaintFiled: '01/05/2025', vin: 'WBS8M9C50J5', components: 'ELECTRICAL SYSTEM,ENGINE AND ENGINE COOLING', summary: 'Smoke from engine bay.' },
  { odiNumber: 11600002, manufacturer: 'BMW of North America, LLC', crash: true, fire: false, numberOfInjuries: 1, numberOfDeaths: 0, dateOfIncident: '03/03/2024', dateComplaintFiled: '03/09/2024', vin: 'WBS8M9C51J5', components: 'STEERING', summary: 'Steering felt loose.' }
] };
const RATINGS = { Count: 1, Message: 'Results returned successfully', Results: [{ VehicleDescription: '2018 BMW M3 4 DR RWD', VehicleId: 12518 }] };
const RATING_12518 = { Count: 1, Results: [{ VehicleId: 12518, OverallRating: 'Not Rated', OverallFrontCrashRating: 'Not Rated', OverallSideCrashRating: '5', RolloverRating: '5' }] };
const VPIC = { Count: 1, Results: [{ ModelYear: '2018', Make: 'BMW', Model: 'M3', Series: 'M3', Trim: 'Base', BodyClass: 'Sedan/Saloon', EngineCylinders: '6', DisplacementL: '3.0', FuelTypePrimary: 'Gasoline', DriveType: 'RWD', TransmissionStyle: 'Manual', TransmissionSpeeds: '6', ErrorCode: '0', ErrorText: '' }] };

/* ---------- licensed API fixtures, shaped from their published Swagger ---------- */
const MOTOR_VIN = { Header: { Status: 'OK', StatusCode: 200, Messages: [] }, Body: { SearchType: 'VIN', Vehicles: [
  { BaseVehicleID: 141, EngineID: 22, VehicleID: 5001, Year: 2018, MakeName: 'BMW', ModelName: 'M3', SubModelName: 'Base', EngineDescription: '3.0L L6 Twin Turbo', MakeID: 1, ModelID: 2 }] } };
const MOTOR_EWT = { Header: { Status: 'OK', StatusCode: 200 }, Body: { Applications: [
  { ApplicationID: 777, DisplayName: 'Water Pump - R&R', Qualifiers: [{ Description: 'S55 engine', QualifierID: 3 }], Position: { Name: '' },
    Items: [{ EstimatedWorkTimeID: 88001, BaseLaborTime: 5.8, BaseWarrantyLaborTime: 4.9, AdditionalLaborTime: 0.4, AdditionalLaborTimeDescription: 'w/ A/C', AllLaborTime: 6.2, ServiceType: 'Mechanical', Notes: [] }],
    AdditionalWorkTimes: [{ ApplicationID: 778, DisplayName: 'Coolant Flush', Items: [{ BaseLaborTime: 0.5 }] }],
    OptionalWorkTimes: [] }] } };
const TEC_BODIES = [{ QualColId: 5, QualColText: 'Saloon' }];
const TEC_WORKLIST = [{ MainGroupId: 1, MainGroupName: 'Engine', SubGroups: [{ SubGroupId: 11, SubGroupName: 'Cooling', ItemMps: [{ ItemMpId: 101, ItemMpText: 'Water pump', KorId: 7, KorText: 'remove and install' }] }] }];
const TEC_STEPS = [{ WorkPosNo: '11-100', WorkId: 9001, WorkText: 'Water pump - remove and install', QualColText: 'S55 engine', ItemMpText: 'Water pump', KorText: 'remove and install',
  WorkTime: 6.2, IsOnlyForReference: false, IsTecRmiTime: true, IsCompositeTime: false, ItemMpId: 101, KorId: 7,
  OptionalExclusivePositions: [{ WorkPositionNo: '11-101', WorkId: 9002, WorkText: 'Thermostat - remove and install (with water pump)', WorkTime: 0.3, IsTecRmiTime: true }] }];
const DATAONE = { decoder_messages: { service_provider: 'DataOne Software' }, query_responses: { 'JZD-1': { query_error: { error_code: '', error_message: '' },
  us_market_data: { common_us_data: { basic_data: { year: '2018', make: 'BMW', model: 'M3' } },
    us_styles: [{ style_id: 400123, vehicle_id: 55, basic_data: { year: '2018', make: 'BMW', model: 'M3', trim: 'Base' },
      engines: [{ name: '3.0L I6 Twin Turbo', installed_flag: 'Y' }, { name: 'optional engine', installed_flag: 'N' }],
      transmissions: [{ name: '6-speed manual', installed_flag: 'Y' }], installed_equipment: [{ name: 'Adaptive M suspension' }] }] } } } };

const results = {};
const failures = [];
function check(name, cond, detail){
  results[name] = cond ? 'PASS' : ('FAIL' + (detail ? ' — ' + detail : ''));
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('PAGEERR: ' + e.message));
  page.on('dialog', d => d.accept());

  /* ---- the network, as NHTSA answers it ---- */
  let nhtsaDown = false, mcVersion = 1, mcBroken = false;
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.route('https://vpic.nhtsa.dot.gov/**', r => nhtsaDown ? r.abort('internetdisconnected') : r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(VPIC) }));
  await page.route('https://api.nhtsa.gov/**', r => {
    if (nhtsaDown) return r.abort('internetdisconnected');
    const u = r.request().url();
    if (/recallsByVehicle/.test(u)){
      if (/model=M3/i.test(u)) return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(RECALLS) });
      return r.fulfill({ status: 400, headers: cors, contentType: 'application/json', body: JSON.stringify({ Count: 0, Message: 'Results returned successfully', results: [] }) });
    }
    if (/complaintsByVehicle/.test(u)) return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(COMPLAINTS) });
    if (/SafetyRatings\/VehicleId\/12518/.test(u)) return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(RATING_12518) });
    if (/SafetyRatings\/modelyear/.test(u)) return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(RATINGS) });
    return r.fulfill({ status: 404, headers: cors, body: '' });
  });
  await page.route('https://static.nhtsa.gov/**', r => {
    if (nhtsaDown) return r.abort('internetdisconnected');
    const u = r.request().url();
    const year = new Date().getFullYear();
    if (new RegExp('TSBS_RECEIVED_2025-' + year + '\\.zip$').test(u)){
      if (mcBroken) return r.fulfill({ status: 200, headers: cors, contentType: 'application/zip', body: Buffer.from('this is not a zip archive at all') });
      return r.fulfill({ status: 200, headers: cors, contentType: 'application/zip', body: makeZip('TSBS_RECEIVED_2025-' + year + '.txt', mcVersion === 1 ? MC_V1 : MC_V2) });
    }
    if (/FLAT_INV\.zip$/.test(u)) return r.fulfill({ status: 200, headers: cors, contentType: 'application/zip', body: makeZip('FLAT_INV.txt', INV) });
    return r.fulfill({ status: 404, headers: cors, body: '' });
  });

  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);

  /* the shop: a BMW with history and an invoiced visit */
  const S = await page.evaluate(() => {
    saveCustomer({ id: 'c1', first: 'Dale', last: 'Hansen', phone: '509-555-0142' });
    db.vehicles.m3 = { id: 'm3', customerId: 'c1', year: '2018', make: 'BMW', model: 'M3', vin: 'WBS8M9C55J5J78069', plate: 'JZD-M3', mileage: '89116' };
    db.vehicles.old = { id: 'old', customerId: 'c1', year: '1999', make: 'Plymouth', model: 'Breeze', vin: '', mileage: '201000' };
    db.orders.inv = shapeOrder({ id: 'inv', customerId: 'c1', vehicleId: 'm3', date: '2026-08-01', status: 'Paid / Closed', estimateNo: 1, roNo: 1, invoiceNo: 1001,
      complaint: 'Oil service', labor: [{ id: 'l1', type: 'manual-labor', desc: 'Oil service', hours: 0.5, billedHours: 0.5, rate: 112.5, rateSource: 'locked', bill: 'H', source: SRC_MANUAL }],
      parts: [], extras: [], payments: [{ id: 'p', at: '2026-08-01T10:00:00Z', amount: 56.25, method: 'Card' }], history: [],
      finalized: { at: '2026-08-01T10:00:00Z', taxRate: 8.25, taxLabor: false, taxParts: true, taxFees: false, laborRate: 112.5 } });
    save();
    return { invoice: orderTotals(db.orders.inv).total, invJson: JSON.stringify(db.orders.inv) };
  });

  /* ---------------------------------------------------------------- free sources */
  results.vin = await page.evaluate(async () => {
    delete db.vinCache['WBS8M9C55J5J78069'];
    const d = await decodeVin('WBS8M9C55J5J78069');
    const r = await lookupCapability('VIN_IDENTIFICATION', db.vehicles.m3, {});
    const a = r.answers.find(x => x.providerId === 'nhtsa_vpic');
    return { make: d.make, model: d.model, answered: !!a, prov: a && a.results[0].prov, label: a && provenanceLabel(a.results[0].prov) };
  });
  check('1. NHTSA vPIC still decodes, and now reports its source', results.vin.make === 'BMW' && results.vin.model === 'M3' && results.vin.answered &&
    results.vin.prov.providerId === 'nhtsa_vpic' && results.vin.prov.applicability === 'VIN' && /Public data/.test(results.vin.label), JSON.stringify(results.vin));

  results.recalls = await page.evaluate(async () => {
    const r = await lookupCapability('RECALLS', db.vehicles.m3, {});
    const list = r.answers[0].results;
    techVehicleId = 'm3'; techTab = 'SAFETY / RECALLS'; techResults[techKey('m3', 'RECALLS')] = r; go('techdata');
    const text = document.getElementById('app').innerText;
    const empty = await lookupCapability('RECALLS', db.vehicles.old, {});
    return { n: list.length, first: list[0], applic: list.map(x => x.prov.applicability), warnings: list.map(x => x.prov.applicabilityWarning),
      text, emptyN: (empty.answers[0] || { results: [] }).results.length, emptyFail: empty.failures.length };
  });
  const Rc = results.recalls;
  check('2. NHTSA recall lookup returns campaign, component, summary, consequence, remedy, date and notes',
    Rc.n === 2 && Rc.first.campaign === '19V123000' && Rc.first.component === 'ENGINE AND ENGINE COOLING' && /water pump/.test(Rc.first.summary) &&
    /overheating/.test(Rc.first.consequence) && /replace/.test(Rc.first.remedy) && Rc.first.reportReceivedDate === '2019-02-21' && /contact BMW/.test(Rc.first.notes) &&
    Rc.emptyN === 0 && Rc.emptyFail === 0, JSON.stringify(Rc).slice(0, 800));
  check('3. recall results are labelled as year/make/model matches — POTENTIALLY APPLICABLE',
    Rc.applic.every(a => a === 'YMM') && Rc.warnings.every(w => /POTENTIALLY APPLICABLE/.test(w)) && /POTENTIALLY APPLICABLE RECALLS/.test(Rc.text), JSON.stringify(Rc.warnings));
  check('4. no recall is presented as open on this VIN',
    !Rc.applic.some(a => a === 'VIN') && Rc.warnings.every(w => /Not verified as open/.test(w)) && !/\bOPEN RECALL\b/i.test(Rc.text) &&
    /not confirmed as open/i.test(Rc.text), Rc.text.slice(0, 600));

  results.complaints = await page.evaluate(async () => {
    const before = { dx: Object.keys(db.diagnostics).length, recs: Object.keys(db.recommendations).length, orders: Object.keys(db.orders).length,
                     labor: Object.values(db.orders).reduce((s, o) => s + o.labor.length, 0) };
    const r = await lookupCapability('COMPLAINTS', db.vehicles.m3, {});
    techTab = 'DIAGNOSTIC INFORMATION'; techResults[techKey('m3', 'COMPLAINTS')] = r; go('techdata');
    const text = document.getElementById('app').innerText;
    const counts = complaintCountsByComponent(r.answers[0].results);
    const after = { dx: Object.keys(db.diagnostics).length, recs: Object.keys(db.recommendations).length, orders: Object.keys(db.orders).length,
                    labor: Object.values(db.orders).reduce((s, o) => s + o.labor.length, 0) };
    return { n: r.answers[0].results.length, counts, warn: r.answers[0].results[0].prov.applicabilityWarning, text, before, after };
  });
  const Cp = results.complaints;
  check('5. NHTSA complaint lookup lists complaints and counts them by component',
    Cp.n === 3 && Cp.counts[0].component === 'ENGINE AND ENGINE COOLING' && Cp.counts[0].count === 2 && /NHTSA CONSUMER COMPLAINTS/.test(Cp.text), JSON.stringify(Cp.counts));
  check('6. complaints are informational and create no diagnosis, recommendation or estimate line',
    JSON.stringify(Cp.before) === JSON.stringify(Cp.after) && /Informational only/.test(Cp.text) && /not a diagnosis/i.test(Cp.warn), JSON.stringify([Cp.before, Cp.after]));

  results.mc = await page.evaluate(async () => {
    hubSettings().mfrCommsFromYear = 2025;
    const meta = await refreshDataset('nhtsa_mfrcomms');
    const r = await adapterMfrComms(db.vehicles.m3, { query: 'water pump' });
    const all = await adapterMfrComms(db.vehicles.m3, {});
    const code = await adapterMfrComms(db.vehicles.m3, { query: 'P0597' });
    const broad = await adapterMfrComms(db.vehicles.m3, { query: 'water pump', broad: true });
    return { meta, n: r.results.length, first: r.results[0], all: all.results.map(x => x.nhtsaId), code: code.results.map(x => x.documentId),
      broadModels: broad.results[0] && Object.keys(broad.results[0].models), building: Object.keys(localStorage).filter(k => /building/.test(k)).length };
  });
  const Mc = results.mc;
  check('7. the Manufacturer Communications flat file is downloaded, unzipped and indexed',
    Mc.meta.records >= 3 && Mc.meta.files.length === 1 && /TSBS_RECEIVED_2025/.test(Mc.meta.files[0].file) && Mc.building === 0, JSON.stringify(Mc.meta));
  check('8. the bulletin index is searchable by repair, by code, and for the exact model',
    Mc.n === 1 && Mc.first.documentId === 'SIB-11-07-25' && Mc.first.type === 'Service Bulletin/Repair Instructions' && Mc.first.isRecall === false &&
    Mc.first.components.length === 2 && Mc.first.date === '2025-03-01' && Mc.first.documentUrl === 'https://static.nhtsa.gov/odi/tsbs/2025/MC-11011501-0001.pdf' &&
    Object.keys(Mc.first.models).sort().join() === 'M3,M4' && Mc.all.join() === '11011522,11011501' && Mc.code.join() === 'SIB-12-02-25' &&
    Mc.broadModels.sort().join() === 'M3,M4', JSON.stringify(Mc).slice(0, 900));

  results.atomic = await page.evaluate(async () => {
    const liveBefore = localStorage.getItem('jzd.ds.nhtsa_mfrcomms.live.BMW');
    return { liveBefore: !!liveBefore };
  });
  mcVersion = 2;
  results.atomic2 = await page.evaluate(async () => {
    const meta = await refreshDataset('nhtsa_mfrcomms');
    const all = await adapterMfrComms(db.vehicles.m3, {});
    return { meta, ids: all.results.map(x => x.nhtsaId), ford: localStorage.getItem('jzd.ds.nhtsa_mfrcomms.live.FORD'),
      building: Object.keys(localStorage).filter(k => /nhtsa_mfrcomms\.building/.test(k)).length };
  });
  check('9. a refresh replaces the whole index in one step', results.atomic.liveBefore && results.atomic2.ids.join() === '11019999' &&
    results.atomic2.ford === null && results.atomic2.building === 0 && results.atomic2.meta.records === 1, JSON.stringify(results.atomic2));

  mcBroken = true;
  results.failed = await page.evaluate(async () => {
    const metaBefore = localStorage.getItem('jzd.ds.nhtsa_mfrcomms.meta');
    let error = '';
    try { await refreshDataset('nhtsa_mfrcomms'); } catch (e){ error = e.message; }
    datasetShardCache.clear();
    const still = await adapterMfrComms(db.vehicles.m3, {});
    return { error, ids: still.results.map(x => x.nhtsaId), metaSame: localStorage.getItem('jzd.ds.nhtsa_mfrcomms.meta') === metaBefore,
      building: Object.keys(localStorage).filter(k => /nhtsa_mfrcomms\.building/.test(k)).length };
  });
  mcBroken = false;
  check('10. a failed refresh leaves the working index exactly as it was',
    /ZIP/i.test(results.failed.error) && results.failed.ids.join() === '11019999' && results.failed.metaSame && results.failed.building === 0, JSON.stringify(results.failed));

  results.inv = await page.evaluate(async () => {
    await refreshDataset('nhtsa_investigations');
    const r = await lookupCapability('INVESTIGATIONS', db.vehicles.m3, {});
    const list = r.answers[0].results;
    return { list: list.map(x => [x.number, x.status, x.type, x.recallCampaign, x.opened].join('|')), label: list[0].prov.applicabilityWarning };
  });
  check('11. NHTSA defect investigations are indexed and looked up, labelled as investigations not diagnoses',
    results.inv.list.join(';') === 'PE24001|Open|Preliminary Evaluation||2024-01-15;RQ19002|Closed|Recall Query|20V111000|2019-03-01' &&
    /NHTSA SAFETY DEFECT INVESTIGATION — not a repair diagnosis/.test(results.inv.label), JSON.stringify(results.inv));

  results.ratings = await page.evaluate(async () => {
    const r = await lookupCapability('SAFETY_RATINGS', db.vehicles.m3, {});
    const x = r.answers[0].results[0];
    return { desc: x.description, side: x.side, rollover: x.rollover, src: x.prov.providerId, id: x.prov.sourceRecordId };
  });
  check('12. NHTSA safety ratings are looked up for the matching variant', results.ratings.desc === '2018 BMW M3 4 DR RWD' &&
    results.ratings.side === '5' && results.ratings.src === 'nhtsa_ncap' && results.ratings.id === '12518', JSON.stringify(results.ratings));

  /* ---------------------------------------------------------------- outage */
  nhtsaDown = true;
  results.outage = await page.evaluate(async () => {
    const t0 = Date.now();
    db.vehicles.x5 = { id: 'x5', customerId: 'c1', year: '2019', make: 'BMW', model: 'X5', vin: '' };
    const fresh = await lookupCapability('RECALLS', db.vehicles.x5, {});
    const cached = await lookupCapability('RECALLS', db.vehicles.m3, {});
    editOrder(null, { customerId: 'c1', vehicleId: 'm3' });
    document.getElementById('o_complaint').value = 'Coolant leak';
    openJobs(); jobQuery = 'oil'; drawJobs();
    const firstRow = document.querySelector('.jobrow');
    if (firstRow) firstRow.click();
    saveOrder();
    const o = Object.values(db.orders).find(x => x.complaint === 'Coolant leak');
    return { ms: Date.now() - t0, freshFail: fresh.failures[0], freshAnswers: fresh.answers.length,
      cachedFromCache: cached.answers[0] && cached.answers[0].meta.fromCache, cachedN: cached.answers[0] && cached.answers[0].results.length,
      cachedProv: cached.answers[0] && cached.answers[0].results[0].prov, roSaved: !!o, roLines: o ? o.labor.length : 0, roNo: o && ticketNo(o) };
  });
  const Ou = results.outage;
  check('13. with NHTSA unreachable a repair order is still created, and the lookup says it is offline',
    Ou.roSaved && Ou.roLines === 1 && Ou.freshAnswers === 0 && Ou.freshFail && Ou.freshFail.offline === true, JSON.stringify(Ou).slice(0, 700));
  check('14. offline, the last NHTSA answer is served from the cache and says so',
    Ou.cachedFromCache === true && Ou.cachedN === 2 && Ou.cachedProv.fromCache === true && !!Ou.cachedProv.cachedAt, JSON.stringify(Ou).slice(0, 700));
  nhtsaDown = false;

  /* ---------------------------------------------------------------- providers, with credentials that never leave */
  const fetchLog = [];
  await page.exposeFunction('__recordProviderRequest', (id, req) => { fetchLog.push({ id, req }); });
  await page.evaluate(({ SECRET, MOTOR_VIN, MOTOR_EWT, TEC_BODIES, TEC_WORKLIST, TEC_STEPS, DATAONE }) => {
    window.__hubTestSecretStore = {};
    let tecSession = false;
    window.__hubTestProviderFetch = async (id, req) => {
      window.__recordProviderRequest(id, req);
      const store = window.__hubTestSecretStore;
      /* do what the desktop shell does: placeholders must name fields that exist */
      const text = JSON.stringify(req);
      for (const m of text.matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}|\[\[secret:([A-Za-z0-9_-]+)\]\]|\{\{hmac_sha256_b64(?:url)?:([A-Za-z0-9_-]+):/g)){
        const f = m[1] || m[2] || m[3];
        if (!store[id + '/' + f]) throw new Error('MISSING_CREDENTIAL:' + f);
      }
      const u = req.url;
      if (id === 'motor_daas'){
        if (/HelloWorld/.test(u)) return /scheme=shared/.test(u) ? { status: 200, text: '{"Header":{"StatusCode":200}}' } : { status: 401, text: '{"Header":{"Messages":[{"Code":"401.000051"}]}}' };
        if (/Search\/ByVIN/.test(u)) return { status: 200, text: JSON.stringify(MOTOR_VIN) };
        if (/EstimatedWorkTimes/.test(u)) return { status: 200, text: JSON.stringify(MOTOR_EWT) };
      }
      if (id === 'tecrmi'){
        if (/\/Auth\/Login$/.test(u)){ tecSession = req.capture_header === 'X-AuthToken'; return { status: 200, text: '' }; }
        if (!tecSession) throw new Error('MISSING_SESSION:X-AuthToken');
        if (/BodiesForTimes/.test(u)) return { status: 200, text: JSON.stringify(TEC_BODIES) };
        if (/WorkList/.test(u)) return { status: 200, text: JSON.stringify(TEC_WORKLIST) };
        if (/WorkSteps/.test(u)) return { status: 200, text: JSON.stringify(TEC_STEPS) };
      }
      if (id === 'dataone') return { status: 200, text: JSON.stringify(DATAONE) };
      if (id === 'autodata') return { status: 200, text: '{"expires_in":3600}' };
      return { status: 404, text: '' };
    };
    window.__hubOpened = [];
    window.__hubTestOpen = url => { window.__hubOpened.push(url); return url; };
  }, { SECRET, MOTOR_VIN, MOTOR_EWT, TEC_BODIES, TEC_WORKLIST, TEC_STEPS, DATAONE });

  results.ready = await page.evaluate(async () => {
    const st = async id => { const s = await providerUsable(id); return s.status + ' / ' + s.readiness; };
    return { motor: await st('motor_daas'), dataone: await st('dataone'), tecrmi: await st('tecrmi'), autodata: await st('autodata'),
      mitchellApi: await st('mitchell_api'), prodemand: await st('mitchell_prodemand'), alldata: await st('alldata_repair'), bmw: await st('bmw_techinfo'),
      partstech: await st('partstech') };
  });

  results.routing = await page.evaluate(async () => {
    const ids = async (cap, v) => (await routeFor(cap, v)).map(r => r.providerId);
    return { labor: await ids('LABOR_TIMES', db.vehicles.m3), vin: await ids('VIN_IDENTIFICATION', db.vehicles.m3), recalls: await ids('RECALLS', db.vehicles.m3),
      tsb: await ids('TSB', db.vehicles.m3), proc: await ids('REPAIR_PROCEDURES', db.vehicles.m3), parts: await ids('PARTS', db.vehicles.m3),
      oemFord: await ids('OEM_PORTAL', { make: 'Ford', model: 'F-150', year: '2019' }) };
  });
  const Rt = results.routing;
  check('16. each capability routes through its own preferred sources, in order',
    Rt.labor.join() === 'motor_daas,tecrmi,autodata,shop_seed,manual' && Rt.vin.join() === 'dataone,motor_daas,nhtsa_vpic,manual' &&
    Rt.recalls.join() === 'nhtsa_recalls' && Rt.tsb.join() === 'motor_daas,nhtsa_mfrcomms,bmw_techinfo' &&
    Rt.proc.indexOf('bmw_techinfo') === 3 && Rt.parts.join() === 'partstech,shop_parts,manual' && Rt.oemFord.join() === 'ford_motorcraft', JSON.stringify(Rt));

  results.disabled = await page.evaluate(async () => {
    providerConfig('nhtsa_recalls').enabled = false;
    const off = await lookupCapability('RECALLS', db.vehicles.m3, {});
    providerConfig('nhtsa_recalls').enabled = true;
    const on = await lookupCapability('RECALLS', db.vehicles.m3, {});
    return { offAnswers: off.answers.length, offFail: off.failures[0], onAnswers: on.answers.length };
  });
  check('17. a disabled provider is not asked, and says it is disabled', results.disabled.offAnswers === 0 && results.disabled.offFail &&
    results.disabled.offFail.message === 'DISABLED' && results.disabled.onAnswers === 1, JSON.stringify(results.disabled));

  /* credentials go in; the book never sees them */
  results.creds = await page.evaluate(async SECRET => {
    for (const [p, f] of [['motor_daas', 'publicKey'], ['motor_daas', 'privateKey'], ['tecrmi', 'company'], ['tecrmi', 'account'], ['tecrmi', 'password'], ['dataone', 'clientId'], ['dataone', 'authorizationCode']])
      await HubSecrets.set(p, f, SECRET + '-' + f);
    const m = providerConfig('motor_daas'); m.environment = 'sandbox'; m.enabled = true;
    const t = providerConfig('tecrmi'); t.enabled = true;
    save();
    await new Promise(r => setTimeout(r, 400));
    const test = await testProvider('motor_daas');
    return { bookHas: JSON.stringify(db).indexOf(SECRET) >= 0, lsHas: (localStorage.getItem('jzd.shop.db') || '').indexOf(SECRET) >= 0,
      configured: Object.keys(providerConfig('motor_daas').credentialsConfigured), test, variant: providerConfig('motor_daas').signingVariant };
  }, SECRET);
  check('25. credentials stored for a provider are absent from the book and from saved data',
    !results.creds.bookHas && !results.creds.lsHas && results.creds.configured.sort().join() === 'privateKey,publicKey', JSON.stringify(results.creds));

  /* ---------------------------------------------------------------- MOTOR, sandbox */
  results.motor = await page.evaluate(async () => {
    const hdr = motorSignedRequest('header', 'GET', '/HelloWorld', {});
    const qry = motorSignedRequest('queryLower', 'GET', '/Information/Vehicles/Search/ByVIN', { VIN: 'WBS8M9C55J5J78069' });
    const vin = await lookupCapability('VIN_IDENTIFICATION', db.vehicles.m3, {});
    const labor = await lookupCapability('LABOR_TIMES', db.vehicles.m3, { query: 'water pump' });
    const motorAns = labor.answers.find(a => a.providerId === 'motor_daas');
    const x = motorAns && motorAns.results[0];
    editOrder(null, { customerId: 'c1', vehicleId: 'm3' });
    let blocked = '';
    try { applyLaborResult(cur, x, {}); } catch (e){ blocked = e.message; }
    const linesAfterRefusal = cur.labor.length;
    cur.labor.push({ id: 'sbx', type: 'licensed-labor', desc: 'smuggled', hours: 5.8, billedHours: 5.8, bill: 'H', rate: 112.5, rateSource: 'shop', source: 'X', provenance: x.prov });
    const ordersBefore = Object.keys(db.orders).length;
    saveOrder();
    const savedSandbox = Object.keys(db.orders).length !== ordersBefore;
    let printed = true; const before = document.getElementById('printArea') ? document.getElementById('printArea').innerHTML : '';
    printDoc('Estimate');
    printed = document.getElementById('printArea') && document.getElementById('printArea').innerHTML !== before;
    closeWO();
    techVehicleId = 'm3'; techTab = 'LABOR'; techResults[techKey('m3', 'LABOR_TIMES')] = labor; go('techdata');
    const text = document.getElementById('app').innerText;
    return { hdr, qry, vinMotor: (vin.answers.find(a => a.providerId === 'motor_daas') || { results: [] }).results[0], x, blocked, linesAfterRefusal,
      savedSandbox, printed, text, label: x && provenanceLabel(x.prov), status: (await providerUsable('motor_daas')).status };
  });
  const Mo = results.motor;
  check('M1. MOTOR requests are signed on the desktop side: the page sends only placeholders',
    Mo.hdr.headers.some(h => h[0] === 'Authorization' && /^Shared \{\{secret:publicKey\}\}:\{\{hmac_sha256_b64:privateKey:\[\[secret:publicKey\]\]\[\[nl\]\]GET\[\[nl\]\]\d+\[\[nl\]\]\/v1\/HelloWorld\}\}$/.test(h[1])) &&
    Mo.hdr.headers.some(h => h[0] === 'XDate') && /^https:\/\/api\.motor\.com\/v1\/Information\/Vehicles\/Search\/ByVIN\?VIN=WBS8M9C55J5J78069&scheme=shared&apikey=\{\{secret:publicKey\}\}&xdate=\d+&sig=\{\{hmac_sha256_b64url:privateKey:.*\/v1\/information\/vehicles\/search\/byvin\}\}$/.test(Mo.qry.url),
    JSON.stringify([Mo.hdr, Mo.qry]));
  check('M2. the connection test tries each signing layout and keeps the one MOTOR accepts', results.creds.test.ok === true && results.creds.variant === 'query' &&
    results.creds.test.tried.length === 3, JSON.stringify(results.creds.test));
  check('M3. MOTOR vehicle identification is normalized with its source ids kept',
    Mo.vinMotor && Mo.vinMotor.baseVehicleId === 141 && Mo.vinMotor.engine === '3.0L L6 Twin Turbo' && Mo.vinMotor.prov.sourceRecordId === '5001' && Mo.vinMotor.prov.originalId === '141', JSON.stringify(Mo.vinMotor));
  check('M4. MOTOR estimated work times are normalized: base, warranty, additional, add-on and qualifier, with MOTOR ids',
    Mo.x && Mo.x.baseHours === 5.8 && Mo.x.warrantyHours === 4.9 && Mo.x.additionalHours === 0.4 && Mo.x.additionalDescription === 'w/ A/C' &&
    Mo.x.addOns[0].operationId === '778' && Mo.x.operationId === '777' && Mo.x.workTimeId === '88001' && Mo.x.qualifiers[0] === 'S55 engine' &&
    Mo.x.prov.sourceRecordId === '88001' && Mo.x.prov.originalId === '777', JSON.stringify(Mo.x).slice(0, 700));
  check('M5. sandbox results carry the watermark everywhere they appear',
    Mo.x.prov.sandbox === true && Mo.x.prov.licensed === false && Mo.label === 'MOTOR DaaS SANDBOX — TEST DATA — NOT FOR PRODUCTION' &&
    /MOTOR DaaS SANDBOX — TEST DATA — NOT FOR PRODUCTION/.test(Mo.text) && /SANDBOX — NOT FOR CUSTOMERS/.test(Mo.text) && Mo.status === 'SANDBOX', Mo.text.slice(0, 500));
  check('19. sandbox data cannot become a customer estimate — not by choosing it, saving it or printing it',
    /SANDBOX DATA CANNOT BE USED/.test(Mo.blocked) && Mo.linesAfterRefusal === 0 && Mo.savedSandbox === false && !Mo.printed, JSON.stringify([Mo.blocked, Mo.linesAfterRefusal, Mo.savedSandbox, Mo.printed]));

  /* ---------------------------------------------------------------- licensed labor from more than one source */
  results.multi = await page.evaluate(async () => {
    providerConfig('motor_daas').environment = 'production';
    db.vehicles.m3.externalIds = { tecrmiTypeId: '33012' };
    const labor = await lookupCapability('LABOR_TIMES', db.vehicles.m3, { query: 'water pump' });
    const by = id => (labor.answers.find(a => a.providerId === id) || { results: [] }).results;
    const motor = by('motor_daas')[0], tec = by('tecrmi')[0], tecOpt = by('tecrmi')[1];
    editOrder(null, { customerId: 'c1', vehicleId: 'm3' });
    document.getElementById('o_complaint').value = 'Water pump';
    window.__lastAlert = ''; const realAlert = window.alert; window.alert = m => { window.__lastAlert = m; };
    const line = applyLaborResult(cur, tec, { by: 'Zack' });
    saveOrder();
    window.alert = realAlert;
    const o = Object.values(db.orders).find(x => x.complaint === 'Water pump');

    return { providers: labor.answers.map(a => a.providerId), motor: motor && [motor.baseHours, motor.prov.licensed, motor.prov.sandbox],
      tec: tec && [tec.baseHours, tec.operationId, tec.prov.providerId], tecOpt: tecOpt && [tecOpt.baseHours, tecOpt.optional],
      autodataFail: labor.failures.find(f => f.providerId === 'autodata'), orderId: o.id, line: o.labor[0] };
  });
  const Mu = results.multi;
  check('20. more than one provider answers the same labor question', Mu.providers.indexOf('motor_daas') >= 0 && Mu.providers.indexOf('tecrmi') >= 0 &&
    Mu.autodataFail && /LICENSE|CREDENTIALS/.test(Mu.autodataFail.message), JSON.stringify(Mu).slice(0, 700));
  check('21. conflicting labor times stay separate, each with its own source (MOTOR 5.8, TecRMI 6.2)',
    Mu.motor[0] === 5.8 && Mu.motor[1] === true && Mu.motor[2] === false && Mu.tec[0] === 6.2 && Mu.tec[2] === 'tecrmi' && Mu.tecOpt[0] === 0.3 && Mu.tecOpt[1] === true, JSON.stringify(Mu));
  check('22. the chosen provider is recorded on the repair-order line',
    Mu.line.type === 'licensed-labor' && Mu.line.hours === 6.2 && Mu.line.provenance.providerId === 'tecrmi' && Mu.line.provenance.operationId === '9001' &&
    Mu.line.provenance.selectedBy === 'Zack' && /TECALLIANCE TECRMI — LICENSED LABOR GUIDE/.test(Mu.line.source) && Mu.line.provenance.vehicle.vin === 'WBS8M9C55J5J78069', JSON.stringify(Mu.line));

  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  results.persist = await page.evaluate(id => {
    const l = db.orders[id].labor[0];
    return { prov: l.provenance, source: l.source, hub: db.providerHub.motor_daas && { env: db.providerHub.motor_daas.environment, variant: db.providerHub.motor_daas.signingVariant } };
  }, Mu.orderId);
  check('15. provenance persists through a restart', results.persist.prov.providerId === 'tecrmi' && results.persist.prov.operationId === '9001' &&
    results.persist.prov.retrievedAt && results.persist.prov.licensed === true && results.persist.hub.variant === 'query', JSON.stringify(results.persist));

  /* the test hooks are gone after a reload, exactly like a fresh machine */
  results.fallback = await page.evaluate(async () => {
    window.__hubTestSecretStore = {};
    const labor = await lookupCapability('LABOR_TIMES', db.vehicles.m3, { query: 'oil' });
    const route = await routeFor('LABOR_TIMES', db.vehicles.m3);
    editOrder(null, { customerId: 'c1', vehicleId: 'm3' });
    document.getElementById('o_complaint').value = 'no providers';
    const seed = labor.answers.find(a => a.providerId === 'shop_seed');
    applyLaborResult(cur, seed.results[0], {});
    saveOrder();
    const o = Object.values(db.orders).find(x => x.complaint === 'no providers');
    return { answers: labor.answers.map(a => a.providerId), seedN: seed.results.length, seedLabel: provenanceLabel(seed.results[0].prov),
      motorReason: route.find(r => r.providerId === 'motor_daas').reason, line: o.labor[0] && [o.labor[0].source, o.labor[0].serviceId] };
  });
  check('23. with every licensed source unavailable the SHOP SEED catalog answers, labelled as such',
    results.fallback.answers.join() === 'shop_seed' && results.fallback.seedN > 0 && /SHOP SEED/.test(results.fallback.seedLabel) &&
    results.fallback.line[0] === 'SHOP SEED' && !!results.fallback.line[1], JSON.stringify(results.fallback));
  check('32. a provider that loses its credentials falls back gracefully and says why',
    results.fallback.motorReason === 'CREDENTIALS MUST BE RE-ENTERED', JSON.stringify(results.fallback));

  results.noExternal = await page.evaluate(() => {
    PROVIDER_REGISTRY.forEach(p => { if (p.kind !== 'local') providerConfig(p.id).enabled = false; });
    editOrder(null, { customerId: 'c1', vehicleId: 'm3' });
    document.getElementById('o_complaint').value = 'offline shop';
    addLine('labor'); cur.labor[0].desc = 'Inspect'; cur.labor[0].hours = 1;
    saveOrder();
    PROVIDER_REGISTRY.forEach(p => { if (p.kind === 'free') providerConfig(p.id).enabled = true; });
    save();
    return !!Object.values(db.orders).find(x => x.complaint === 'offline shop');
  });
  check('24. a repair order needs no external provider at all', results.noExternal === true, '');

  results.unavail = await page.evaluate(async () => {
    window.__hubTestSecretStore = { 'tecrmi/company': 'x', 'tecrmi/account': 'y', 'tecrmi/password': 'z' };
    const t = providerConfig('tecrmi'); t.enabled = true; t.lastTest = { at: new Date().toISOString(), ok: false, message: 'timeout' };
    const s = await providerUsable('tecrmi');
    const labor = await lookupCapability('LABOR_TIMES', db.vehicles.m3, { query: 'water pump' });
    t.lastTest = null;
    return { status: s.status, usable: s.usable, asked: labor.answers.some(a => a.providerId === 'tecrmi'), fail: labor.failures.find(f => f.providerId === 'tecrmi') };
  });
  check('18. an unavailable provider is skipped and reported, not asked', results.unavail.status === 'UNAVAILABLE' && !results.unavail.usable && !results.unavail.asked &&
    results.unavail.fail.message === 'LAST TEST FAILED', JSON.stringify(results.unavail));

  results.price = await page.evaluate(async () => {
    window.__hubTestSecretStore = {};
    const p = PROVIDER_BY_ID.motor_daas;
    const was = p.pricing.publicPriceText;
    p.pricing.publicPriceText = 'Free'; p.pricing.quoteRequired = false;
    providerConfig('motor_daas').priceText = '$0';
    providerConfig('motor_daas').enabled = true;
    const s = await providerUsable('motor_daas');
    p.pricing.publicPriceText = was; p.pricing.quoteRequired = true;
    return { usable: s.usable, readiness: s.readiness };
  });
  check('31. a price never grants entitlement — only credentials do', results.price.usable === false && /CREDENTIALS/.test(results.price.readiness), JSON.stringify(results.price));

  /* ---------------------------------------------------------------- portals */
  results.portals = await page.evaluate(async () => {
    window.__hubOpened = [];
    window.__hubTestOpen = url => { window.__hubOpened.push(url); return url; };
    await openProviderPortal('bmw_techinfo');
    await openProviderPortal('alldata_repair');
    await openProviderPortal('mitchell_prodemand');
    await openProviderPortal('partstech');
    let refused = false;
    const was = window.alert; window.alert = () => { refused = true; };
    await openOfficialUrl('https://evil.example/phish');
    window.alert = was;
    await openOfficialUrl('https://static.nhtsa.gov/odi/tsbs/2025/MC-11011501-0001.pdf');
    const v = db.vehicles.m3;
    return { opened: window.__hubOpened.slice(), refused, ctx: vehicleContextText(v),
      mini: PROVIDER_BY_ID.mini_techinfo.portalUrl, rr: PROVIDER_BY_ID.rollsroyce_techinfo.portalUrl,
      bmwPlans: PROVIDER_BY_ID.bmw_techinfo.plans.map(p => p.price).join(' '), toyotaPlans: PROVIDER_BY_ID.toyota_tis.plans.length,
      nissan: PROVIDER_BY_ID.nissan_techinfo.plans.map(p => p.price).join(' '),
      unverified: PROVIDER_REGISTRY.filter(p => ['ford_motorcraft', 'gm_acdelco_tds', 'mazda_serviceinfo', 'porsche_techinfo'].indexOf(p.id) >= 0).every(p => p.pricing.publicPriceText === 'PRICE NOT VERIFIED / CHECK OFFICIAL PORTAL'),
      noScraper: PROVIDER_REGISTRY.filter(p => p.kind === 'oem' || p.kind === 'portal').every(p => !ADAPTERS[p.id]) };
  });
  const Po = results.portals;
  check('29. a portal opens its own official address, and nothing unofficial can be opened',
    Po.opened[0] === 'https://bmwtechinfo.bmwgroup.com/' && Po.opened[1] === 'https://my.alldata.com/' && /prodemand\.com/.test(Po.opened[2]) &&
    Po.opened[3] === 'https://app.partstech.com/' && Po.refused && Po.opened.indexOf('https://evil.example/phish') < 0 &&
    Po.opened[4] === 'https://static.nhtsa.gov/odi/tsbs/2025/MC-11011501-0001.pdf' && Po.noScraper &&
    Po.mini === 'https://minitechinfo.bmwgroup.com/' && Po.rr === 'https://rollsroycetechinfo.bmwgroup.com/', JSON.stringify(Po));
  check('30. the vehicle context for a portal carries the VIN, year, make, model and mileage',
    /VIN WBS8M9C55J5J78069/.test(Po.ctx) && /2018 BMW M3/.test(Po.ctx) && /89116 mi/.test(Po.ctx), Po.ctx);

  check('P1. provider readiness is stated honestly for every kind of provider',
    /READY FOR SANDBOX KEYS/.test(results.ready.motor) && /CUSTOM QUOTE REQUIRED \/ READY FOR CREDENTIALS/.test(results.ready.dataone) &&
    /READY FOR LICENSE \/ CREDENTIALS/.test(results.ready.tecrmi) && /READY FOR LICENSE \/ CREDENTIALS/.test(results.ready.autodata) &&
    results.ready.mitchellApi === 'PARTNER APPROVAL REQUIRED / COMMERCIAL APPROVAL REQUIRED' && /SUBSCRIPTION REQUIRED \/ PORTAL LAUNCHER/.test(results.ready.prodemand) &&
    /SUBSCRIPTION REQUIRED/.test(results.ready.alldata) && /SUBSCRIPTION REQUIRED/.test(results.ready.bmw) && /FREE \/ FREE ACCOUNT/.test(results.ready.partstech), JSON.stringify(results.ready));
  check('P2. published subscription pricing is recorded with its date, and unverified portals say so',
    Po.bmwPlans === '$32 $270 $2,700' && Po.toyotaPlans === 7 && Po.nissan === '$35 $135 $390 $1,250' && Po.unverified, JSON.stringify(Po));

  results.adapters = await page.evaluate(async fx => {
    const d1 = dataoneRequest('WBS8M9C55J5J78069');
    const dn = normalizeDataone(fx, db.vehicles.m3)[0];
    const tl = tecrmiLoginRequest();
    const at = autodataTokenRequest();
    let adErr = '';
    try { await adapterAutodataLabor(db.vehicles.m3, {}); } catch (e){ adErr = e.message; }
    const mitchell = PROVIDER_BY_ID.mitchell_api;
    const before = providerConfig('mitchell_api').enabled;
    toggleProvider('mitchell_api');
    return { d1, dn: { trim: dn.trim, engine: dn.engine, trans: dn.transmission, style: dn.prov.sourceRecordId, env: dn.prov.environment },
      tl, at, adErr, mitchellNote: mitchell.note, mitchellPrice: mitchell.pricing.notes, mitchellStill: providerConfig('mitchell_api').enabled === before,
      prodemandKind: PROVIDER_BY_ID.mitchell_prodemand.kind };
  }, DATAONE);
  const Ad = results.adapters;
  check('D1. DataOne: decode request carries only placeholders and the result is normalized with installed engine and transmission',
    Ad.d1.method === 'POST' && /client_id=\{\{secret:clientId\}\}&authorization_code=\{\{secret:authorizationCode\}\}&decoder_query=/.test(Ad.d1.body) &&
    Ad.dn.trim === 'Base' && Ad.dn.engine === '3.0L I6 Twin Turbo' && Ad.dn.trans === '6-speed manual' && Ad.dn.style === '400123', JSON.stringify(Ad.dn));
  check('T1. TecRMI: login follows its published REST authentication and keeps the token on the desktop side',
    /\/Auth\/Login$/.test(Ad.tl.url) && Ad.tl.capture_header === 'X-AuthToken' && Ad.tl.body === '{"Company":"{{secret:company}}","Account":"{{secret:account}}","Password":"{{secret:password}}"}', JSON.stringify(Ad.tl));
  check('A1. Autodata: OAuth client-credentials request is prepared, and data mapping stops at an honest boundary',
    /grant_type=client_credentials&client_id=\{\{secret:clientId\}\}&client_secret=\{\{secret:clientSecret\}\}/.test(Ad.at.body) && Ad.at.capture_json === 'access_token' &&
    /supplied with the licence/.test(Ad.adErr), JSON.stringify([Ad.at, Ad.adErr]));
  check('MI1. Mitchell: the data API is disabled under its published policy and kept apart from the ProDemand portal',
    /does not approve data-licensing requests from individual repair facilities/.test(Ad.mitchellNote) && /SINGLE-SHOP USE NOT ELIGIBLE/.test(Ad.mitchellPrice) &&
    Ad.mitchellStill && Ad.prodemandKind === 'portal', JSON.stringify(Ad));

  check('S1. no request handed to a provider contains a credential value',
    fetchLog.length > 5 && fetchLog.every(f => JSON.stringify(f.req).indexOf(SECRET) < 0), fetchLog.length + ' requests');

  /* ---------------------------------------------------------------- backup and restore */
  results.backup = await page.evaluate(async SECRET => {
    window.__hubTestSecretStore = { 'motor_daas/publicKey': SECRET + '-pk', 'motor_daas/privateKey': SECRET + '-sk' };
    const b = providerConfig('bmw_techinfo'); b.subscription.status = 'active'; b.subscription.plan = 'month'; b.notes = 'shop login is Zack';
    const m = providerConfig('motor_daas'); m.environment = 'sandbox'; m.enabled = true;
    save();
    const built = await buildBackup();
    const text = JSON.stringify(built.pkg);
    const inv = orderTotals(db.orders.inv).total;
    db = shapeDb(JSON.parse(JSON.stringify(DEFAULT)));
    window.__hubTestSecretStore = {};              /* a different computer: no credentials */
    await restoreBackupPackage(JSON.parse(text));
    const ms = await providerUsable('motor_daas');
    const cs = await credentialState(PROVIDER_BY_ID.motor_daas);
    return { backupHasSecret: text.indexOf(SECRET) >= 0, bmw: db.providerHub.bmw_techinfo, motor: db.providerHub.motor_daas,
      motorStatus: ms.readiness, credState: cs.state, invBefore: inv, invAfter: orderTotals(db.orders.inv).total, invJson: JSON.stringify(db.orders.inv),
      bmwStatus: (await providerUsable('bmw_techinfo')).status };
  }, SECRET);
  const Bk = results.backup;
  check('26. a normal backup contains no credential', Bk.backupHasSecret === false, '');
  check('27. provider configuration survives backup and restore', Bk.bmw.subscription.status === 'active' && Bk.bmw.subscription.plan === 'month' &&
    Bk.bmw.notes === 'shop login is Zack' && Bk.motor.environment === 'sandbox' && Bk.motor.signingVariant === 'query' && Bk.bmwStatus === 'LIVE', JSON.stringify([Bk.bmw, Bk.motor]));
  check('28. after a restore without credentials the provider says CREDENTIALS MUST BE RE-ENTERED', Bk.credState === 'reenter' &&
    Bk.motorStatus === 'CREDENTIALS MUST BE RE-ENTERED', JSON.stringify(Bk));
  check('H1. the historical invoice is unchanged by all of it', Math.abs(Bk.invAfter - S.invoice) < 0.005 && Bk.invJson === S.invJson, JSON.stringify([Bk.invAfter, S.invoice]));

  results.screens = await page.evaluate(async () => {
    const seen = {};
    go('providers'); await new Promise(r => setTimeout(r, 300));
    seen.providers = document.getElementById('app').innerText;
    for (const id of ['motor_daas', 'mitchell_api', 'bmw_techinfo', 'dataone', 'tecrmi', 'autodata', 'partstech', 'nhtsa_mfrcomms']){
      if (!PROVIDER_BY_ID[id].blocked){ await configureProvider(id); seen['cfg_' + id] = document.getElementById('recSheet').innerText.length; closeRec(); }
    }
    for (const t of TECH_TABS){ techVehicleId = 'm3'; techTab = t; go('techdata'); await new Promise(r => setTimeout(r, 30)); seen[t] = document.getElementById('app').innerText.length; }
    const o = Object.values(db.orders).find(x => x.labor.length && !isFinal(x));
    editOrder(o.id); openJobTech(o.id, o.labor[0].id); seen.jobTech = document.getElementById('recSheet').innerText; closeRec(); closeWO();
    openVehicle('m3'); seen.vehicle = /Technical data/.test(document.getElementById('app').innerText);
    go('settings'); seen.settings = /Data Providers/.test(document.getElementById('app').innerText);
    go('dash');
    return seen;
  });
  const Sc = results.screens;
  check('UI. Data Providers, every technical-data tab, the job lookup and the entry points all draw',
    /MOTOR DaaS/.test(Sc.providers) && /COMMERCIAL APPROVAL REQUIRED/.test(Sc.providers) && /\$2,700/.test(Sc.providers) &&
    TECH_TABS_OK(Sc) && /LOOK UP LABOR/.test(Sc.jobTech) && /PROCEDURE · SPECS · TORQUE · WIRING/.test(Sc.jobTech) && Sc.vehicle && Sc.settings,
    JSON.stringify(Object.fromEntries(Object.entries(Sc).map(([k, v]) => [k, typeof v === 'string' ? v.length : v]))));

  check('E. nothing threw during any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log('');
  Object.keys(results).filter(k => typeof results[k] === 'string').forEach(k => console.log(' ' + results[k].slice(0, 200).padEnd(6) + ' ' + k));
  console.log('\n LIVE MOTOR SANDBOX CONTRACT CALL: not run by this suite. It needs the sandbox keys MOTOR publishes, entered by the shop owner in');
  console.log(' Settings → Data Providers → MOTOR DaaS → Configure, then Test sandbox. The fixture contract above is from MOTOR\'s published Swagger.');
  if (failures.length){
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL DATA PROVIDER HUB CHECKS PASSED');
})();

function TECH_TABS_OK(seen){
  const tabs = ['OVERVIEW', 'VEHICLE IDENTIFICATION', 'SAFETY / RECALLS', 'TSBs / MANUFACTURER COMMUNICATIONS', 'DIAGNOSTIC INFORMATION', 'LABOR',
    'REPAIR PROCEDURES', 'SPECIFICATIONS', 'FLUIDS', 'MAINTENANCE', 'WIRING', 'PARTS', 'OEM FACTORY INFORMATION'];
  return tabs.every(t => seen[t] > 80);
}
