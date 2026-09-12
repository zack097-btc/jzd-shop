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
   documentation — MOTOR's field layout as its live sandbox returns it, TecRMI's
   REST Swagger, Autodata's published code samples. No request leaves this
   machine; the live MOTOR sandbox call is made by the desktop shell's own code
   in CI (cargo test motor_sandbox_live) and by testmotorlive.cjs. */
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
    Items: [{ EstimatedWorkTimeID: 88001, BaseLaborTime: 5.8, BaseWarrantyLaborTime: 4.9, AdditionalLaborTime: 0.4, AdditionalLaborTimeDescription: 'w/ A/C', AllLaborTime: 6.2,
      LaborTimeInterval: 'Hours', ServiceType: 'Mechanical', RequiredSkill: { Code: 'g', Name: 'General' }, Notes: [] }],
    AdditionalWorkTimes: [{ ApplicationID: 778, DisplayName: 'Coolant Flush', Items: [{ BaseLaborTime: 0.5, LaborTimeInterval: 'Hours' }] }],
    OptionalWorkTimes: [] },
  { ApplicationID: 779, DisplayName: 'Coolant Level Inspect', Qualifiers: [], Items: [{ EstimatedWorkTimeID: 88002, BaseLaborTime: 6.0, LaborTimeInterval: 'Minutes', ServiceType: 'Inspect' }] }] } };
const MOTOR_SPEC_SUMMARY = { Header: { StatusCode: 200, PagingInfo: { TotalItemCount: 41 } }, Body: { Applications: [
  { ApplicationID: 9101, DisplayName: 'Water Pump Tightening Torque', IsActive: true, Category: { Article: 'Torque' }, Qualifiers: [], Taxonomy: { SystemName: 'Powertrain', GroupName: 'Engine' } }] } };
const MOTOR_SPEC_DETAIL = { Header: { StatusCode: 200 }, Body: { Specifications: [{ ApplicationID: 9101, Items: [
  { IsActive: true, Value: '', MinValue: '10', MaxValue: '10', UnitOfMeasure: 'Newton Meter', ExtendedParameters: [{ Name: 'Include_Filter', Value: 'Not applicable' }], Notes: [] }], Notes: [] }] } };
const MOTOR_DTC = { Header: { StatusCode: 200, PagingInfo: { TotalItemCount: 1 } }, Body: { Applications: [
  { ApplicationID: 9201, DisplayName: 'Thermostat Heater Control Circuit', IsActive: true, Item: { Code: 'P0597', DTCID: 1234 }, Qualifiers: [] }] } };
const MOTOR_TSB = { Header: { StatusCode: 200, PagingInfo: { TotalItemCount: 1 } }, Body: { Applications: [
  { ApplicationID: 9301, DisplayName: 'Coolant Loss at Electric Water Pump', IsActive: true, Item: { ManufacturerNumber: 'SIB-11-07-25', IssueDate: '2025-03-01T00:00:00', TSBID: 5678, Types: [{ Type: 'Service Bulletin' }] }, Qualifiers: [] }] } };
const TEC_BODIES = [{ QualColId: 5, QualColText: 'Saloon' }];
const TEC_WORKLIST = [{ MainGroupId: 1, MainGroupName: 'Engine', SubGroups: [{ SubGroupId: 11, SubGroupName: 'Cooling', ItemMps: [{ ItemMpId: 101, ItemMpText: 'Water pump', KorId: 7, KorText: 'remove and install' }] }] }];
const TEC_STEPS = [{ WorkPosNo: '11-100', WorkId: 9001, WorkText: 'Water pump - remove and install', QualColText: 'S55 engine', ItemMpText: 'Water pump', KorText: 'remove and install',
  WorkTime: 6.2, IsOnlyForReference: false, IsTecRmiTime: true, IsCompositeTime: false, ItemMpId: 101, KorId: 7,
  KindOfWorkTimeData: 0,
  OptionalExclusivePositions: [{ WorkPosNo: '11-101', WorkId: 9002, WorkText: 'Thermostat - remove and install (with water pump)', WorkTime: 0.3, KindOfWorkTimeData: 0, IsTecRmiTime: true }],
  ExclusiveWorkPositions: [{ WorkPosNo: '11-102', WorkId: 9003, WorkText: 'Water pump - replace (manufacturer units)', WorkTime: 62, KindOfWorkTimeData: 1 }] }];
const AUTODATA_SCHEDULES = { data: [{ service_schedule_id: 'SS-100', description: '12 month / 10,000 mile service' }] };
const AUTODATA_401 = { status: 403, message: 'Forbidden', code: 'M03140301', info: ['Account Inactive'] };
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
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag, Last-Modified' };
  const staticLog = [];
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
    const u = r.request().url(), method = r.request().method();
    const year = new Date().getFullYear();
    staticLog.push(method + ' ' + u.split('/').pop());
    if (new RegExp('TSBS_RECEIVED_2025-' + year + '\\.zip$').test(u)){
      const h = Object.assign({ ETag: '"mc-' + (mcBroken ? 'broken' : mcVersion) + '"', 'Last-Modified': 'Sat, 12 Sep 2026 10:05:42 GMT' }, cors);
      if (method === 'HEAD') return r.fulfill({ status: 200, headers: h, body: '' });
      if (mcBroken) return r.fulfill({ status: 200, headers: h, contentType: 'application/zip', body: Buffer.from('this is not a zip archive at all') });
      return r.fulfill({ status: 200, headers: h, contentType: 'application/zip', body: makeZip('TSBS_RECEIVED_2025-' + year + '.txt', mcVersion === 1 ? MC_V1 : MC_V2) });
    }
    if (/FLAT_INV\.zip$/.test(u)){
      const h = Object.assign({ ETag: '"inv-1"', 'Last-Modified': 'Sat, 12 Sep 2026 09:12:57 GMT' }, cors);
      return r.fulfill({ status: 200, headers: h, contentType: 'application/zip', body: method === 'HEAD' ? '' : makeZip('FLAT_INV.txt', INV) });
    }
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
    techVehicleId = 'm3'; techTab = 'RECALLS'; techResults[techKey('m3', 'RECALLS')] = r; go('techdata');
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
    techTab = 'COMPLAINTS'; techResults[techKey('m3', 'COMPLAINTS')] = r; go('techdata');
    const text = document.getElementById('app').innerText;
    const counts = complaintCountsByComponent(r.answers[0].results);
    const after = { dx: Object.keys(db.diagnostics).length, recs: Object.keys(db.recommendations).length, orders: Object.keys(db.orders).length,
                    labor: Object.values(db.orders).reduce((s, o) => s + o.labor.length, 0) };
    return { n: r.answers[0].results.length, counts, warn: r.answers[0].results[0].prov.applicabilityWarning, text, before, after };
  });
  const Cp = results.complaints;
  check('5. NHTSA complaint lookup lists complaints and counts them by component',
    Cp.n === 3 && Cp.counts[0].component === 'ENGINE AND ENGINE COOLING' && Cp.counts[0].count === 2 && /NHTSA CONSUMER COMPLAINTS — INFORMATIONAL/.test(Cp.text), JSON.stringify(Cp.counts));
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
  staticLog.length = 0;
  results.upToDate = await page.evaluate(async () => {
    const check = await checkDatasetUpdates('nhtsa_mfrcomms');
    const again = await updateDataset('nhtsa_mfrcomms');
    const st = await DatasetStore.status('nhtsa_mfrcomms'), meta = await DatasetStore.meta('nhtsa_mfrcomms');
    return { check, upToDate: !!again.upToDate, st, meta };
  });
  const Ud = results.upToDate, udGets = staticLog.filter(x => /^GET /.test(x));
  check('D2. CHECK FOR UPDATES asks NHTSA without downloading, and an unchanged file is not downloaded again',
    Ud.check.ok === true && Ud.check.updateAvailable === false && Ud.upToDate && udGets.length === 0 && staticLog.some(x => /^HEAD /.test(x)) &&
    Ud.st.lastResult.outcome === 'UP_TO_DATE', JSON.stringify([staticLog, Ud.check]));
  check('D3. the index records its source, files, NHTSA timestamps, build time, row count and last success',
    /NHTSA ODI Manufacturer Communications/.test(Ud.meta.source) && Ud.meta.files[0].entry === 'TSBS_RECEIVED_2025-' + new Date().getFullYear() + '.txt' &&
    Ud.meta.files[0].etag === '"mc-1"' && Ud.meta.files[0].lastModified === 'Sat, 12 Sep 2026 10:05:42 GMT' && !!Ud.meta.files[0].downloadedAt &&
    Ud.meta.nhtsaUpdatedAt === '2026-09-12T10:05:42.000Z' && !!Ud.meta.builtAt && Ud.meta.records === 3 && Ud.meta.rowsRead === 5 && Ud.meta.rowsRejected === 0 &&
    !!Ud.st.lastSuccessAt && !!Ud.st.lastCheckAt, JSON.stringify([Ud.meta, Ud.st]));
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
  results.failedStatus = await page.evaluate(() => DatasetStore.status('nhtsa_mfrcomms'));
  check('10. a failed refresh leaves the working index exactly as it was',
    /ZIP/i.test(results.failed.error) && results.failed.ids.join() === '11019999' && results.failed.metaSame && results.failed.building === 0, JSON.stringify(results.failed));
  check('D4. a failed update is recorded — time and error — beside the last successful one',
    results.failedStatus.lastFailure && /ZIP/i.test(results.failedStatus.lastFailure.error) && !!results.failedStatus.lastSuccessAt &&
    results.failedStatus.lastResult.outcome === 'FAILED', JSON.stringify(results.failedStatus));

  results.inv = await page.evaluate(async () => {
    await refreshDataset('nhtsa_investigations');
    const r = await lookupCapability('INVESTIGATIONS', db.vehicles.m3, {});
    const list = r.answers[0].results;
    return { list: list.map(x => [x.number, x.status, x.type, x.recallCampaign, x.opened].join('|')), label: list[0].prov.applicabilityWarning };
  });
  check('11. NHTSA defect investigations are indexed and looked up, labelled as investigations not diagnoses',
    results.inv.list.join(';') === 'PE24001|Open|Preliminary Evaluation||2024-01-15;RQ19002|Closed|Recall Query|20V111000|2019-03-01' &&
    /NHTSA DEFECT INVESTIGATION — not a recall, not a confirmed defect on this VIN, not a diagnosis and not a required repair/.test(results.inv.label), JSON.stringify(results.inv));

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
  const installHooks = () => page.evaluate(({ SECRET, MOTOR_VIN, MOTOR_EWT, MOTOR_SPEC_SUMMARY, MOTOR_SPEC_DETAIL, MOTOR_DTC, MOTOR_TSB, TEC_BODIES, TEC_WORKLIST, TEC_STEPS, DATAONE, AUTODATA_SCHEDULES, AUTODATA_401 }) => {
    window.__hubTestSecretStore = {};
    let tecSession = false;
    window.__hubTestProviderFetch = async (id, req) => {
      window.__recordProviderRequest(id, req);
      const store = window.__hubTestSecretStore;
      /* do what the desktop shell does: placeholders must name fields that exist,
         only MOTOR may ask for Shared signing, and signing headers belong to the shell */
      const text = JSON.stringify(req);
      if (/hmac_sha256|\[\[secret:/.test(text)) throw new Error('unknown placeholder');
      for (const m of text.matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g)){
        if (!store[id + '/' + m[1]]) throw new Error('MISSING_CREDENTIAL:' + m[1]);
      }
      if (req.auth && !(req.auth === 'motor_shared' && id === 'motor_daas')) throw new Error(id + ' has no signing scheme called ' + req.auth);
      const u = req.url;
      if (id === 'motor_daas'){
        if (req.auth !== 'motor_shared') return { status: 401, text: '{"Header":{"Messages":[{"Code":"401.000051","LongDescription":"Invalid authentication."}]}}' };
        const signed = (req.headers || []).find(h => /^(authorization|x-date|date)$/i.test(h[0]));
        if (signed) throw new Error('the ' + signed[0] + ' header is set by the signing step, not by the page');
        for (const f of ['publicKey', 'privateKey']) if (!store['motor_daas/' + f]) throw new Error('MISSING_CREDENTIAL:' + f);
        const mode = window.__motorMode || 'ok';
        if (mode === 'badkeys') return { status: 401, text: '{"Header":{"Messages":[{"Code":"401.000052","LongDescription":"Invalid authentication.","ShortDescription":"Invalid Authentication"}],"StatusCode":401}}' };
        if (mode === 'clock') return { status: 403, text: '{"Header":{"Messages":[{"Code":"403.000162","LongDescription":"Request time too skewed."}],"StatusCode":403}}' };
        if (mode === 'down') throw new Error('no response: Could not resolve host: api.motor.com');
        if (mode === 'timeout') throw new Error('no response: Operation timed out after 30000 milliseconds');
        if (mode === 'malformed') return { status: 200, text: '<html><body>Service temporarily unavailable</body></html>' };
        if (/HelloWorld/.test(u)) return { status: 200, text: '{"Body":{"Text":"HelloWorld!"},"Header":{"StatusCode":200,"Messages":[]}}' };
        if (/Search\/ByVIN/.test(u)) return { status: 200, text: JSON.stringify(MOTOR_VIN) };
        if (/EstimatedWorkTimes/.test(u)) return { status: 200, text: JSON.stringify(MOTOR_EWT) };
        if (/Details\/Of\/Specifications\/9101/.test(u)) return { status: 200, text: JSON.stringify(MOTOR_SPEC_DETAIL) };
        if (/Summaries\/Of\/Specifications/.test(u)) return { status: 200, text: JSON.stringify(MOTOR_SPEC_SUMMARY) };
        if (/Summaries\/Of\/DiagnosticTroubleCodes/.test(u)) return { status: 200, text: JSON.stringify(MOTOR_DTC) };
        if (/Summaries\/Of\/TechnicalServiceBulletins/.test(u)) return { status: 200, text: JSON.stringify(MOTOR_TSB) };
        return { status: 403, text: '{"Header":{"Messages":[{"Code":"403.000103","LongDescription":"Resource not allowed."}],"StatusCode":403}}' };
      }
      if (id === 'tecrmi'){
        if (/\/Auth\/Login$/.test(u)){ tecSession = req.capture_header === 'X-AuthToken'; return { status: 200, text: '' }; }
        if (!tecSession) throw new Error('MISSING_SESSION:X-AuthToken');
        if (/BodiesForTimes/.test(u)) return { status: 200, text: JSON.stringify(TEC_BODIES) };
        if (/WorkList/.test(u)) return { status: 200, text: JSON.stringify(TEC_WORKLIST) };
        if (/WorkSteps/.test(u)){ window.__lastTecSteps = u; return { status: 200, text: JSON.stringify(TEC_STEPS) }; }
      }
      if (id === 'dataone') return { status: 200, text: JSON.stringify(DATAONE) };
      if (id === 'autodata'){
        if (window.__autodataMode === 'inactive') return { status: 401, text: JSON.stringify(AUTODATA_401) };
        if (/\/v1\/manufacturers/.test(u)) return { status: 200, text: '{"data":[{"manufacturer_id":"AUD"},{"manufacturer_id":"BMW"}]}' };
        if (/service-schedules/.test(u)) return { status: 200, text: JSON.stringify(AUTODATA_SCHEDULES) };
      }
      return { status: 404, text: '' };
    };
    window.__hubOpened = [];
    window.__hubTestOpen = url => { window.__hubOpened.push(url); return url; };
  }, { SECRET, MOTOR_VIN, MOTOR_EWT, MOTOR_SPEC_SUMMARY, MOTOR_SPEC_DETAIL, MOTOR_DTC, MOTOR_TSB, TEC_BODIES, TEC_WORKLIST, TEC_STEPS, DATAONE, AUTODATA_SCHEDULES, AUTODATA_401 });
  await installHooks();

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
      configured: Object.keys(providerConfig('motor_daas').credentialsConfigured), test, variant: 'signingVariant' in providerConfig('motor_daas') };
  }, SECRET);
  check('25. credentials stored for a provider are absent from the book and from saved data',
    !results.creds.bookHas && !results.creds.lsHas && results.creds.configured.sort().join() === 'privateKey,publicKey', JSON.stringify(results.creds));

  /* ---------------------------------------------------------------- MOTOR, sandbox */
  results.motor = await page.evaluate(async () => {
    const hdr = motorRequest('/HelloWorld', {});
    const qry = motorRequest('/Information/Vehicles/Search/ByVIN', { VIN: 'WBS8M9C55J5J78069', EN: '' });
    const vin = await lookupCapability('VIN_IDENTIFICATION', db.vehicles.m3, {});
    const labor = await lookupCapability('LABOR_TIMES', db.vehicles.m3, { query: 'water pump' });
    const motorAns = labor.answers.find(a => a.providerId === 'motor_daas');
    const x = motorAns && motorAns.results[0];
    const minutes = motorAns && motorAns.results.find(r => r.operationId === '779');
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
    return { minutes, hdr, qry, vinMotor: (vin.answers.find(a => a.providerId === 'motor_daas') || { results: [] }).results[0], x, blocked, linesAfterRefusal,
      savedSandbox, printed, text, label: x && provenanceLabel(x.prov), status: (await providerUsable('motor_daas')).status };
  });
  const Mo = results.motor;
  results.motorGone = await page.evaluate(() => typeof MOTOR_SIGNING_VARIANTS === 'undefined' && typeof motorSignedRequest === 'undefined');
  check('M1. a MOTOR request from the page names MOTOR\'s documented Shared scheme and carries no key, signature, time stamp or placeholder',
    Mo.hdr.auth === 'motor_shared' && Mo.hdr.method === 'GET' && Mo.hdr.url === 'https://api.motor.com/v1/HelloWorld' &&
    JSON.stringify(Mo.hdr.headers) === '[["Accept","application/json"]]' && Mo.qry.url === 'https://api.motor.com/v1/Information/Vehicles/Search/ByVIN?VIN=WBS8M9C55J5J78069' &&
    !/\{\{|\[\[|Shared |X-Date|sig=|apikey|xdate|Authorization/i.test([Mo.hdr.url, Mo.qry.url].concat(Mo.hdr.headers.flat(), Mo.qry.headers.flat()).join(' ')), JSON.stringify([Mo.hdr, Mo.qry]));
  check('M2. the connection test makes one documented HelloWorld call and no guessed variants remain',
    results.creds.test.ok === true && /Shared signing/.test(results.creds.test.message) && results.creds.variant === false && results.motorGone === true, JSON.stringify([results.creds.test, results.motorGone]));
  check('M3. MOTOR vehicle identification is normalized with its source ids kept',
    Mo.vinMotor && Mo.vinMotor.baseVehicleId === 141 && Mo.vinMotor.engine === '3.0L L6 Twin Turbo' && Mo.vinMotor.prov.sourceRecordId === '5001' && Mo.vinMotor.prov.originalId === '141', JSON.stringify(Mo.vinMotor));
  check('M4. MOTOR estimated work times are normalized: base, warranty, additional, add-on and qualifier, with MOTOR ids',
    Mo.x && Mo.x.baseHours === 5.8 && Mo.x.warrantyHours === 4.9 && Mo.x.additionalHours === 0.4 && Mo.x.additionalDescription === 'w/ A/C' &&
    Mo.x.addOns[0].operationId === '778' && Mo.x.operationId === '777' && Mo.x.workTimeId === '88001' && Mo.x.qualifiers[0] === 'S55 engine' &&
    Mo.x.prov.sourceRecordId === '88001' && Mo.x.prov.originalId === '777' && Mo.x.originalUnit === 'Hours', JSON.stringify(Mo.x).slice(0, 700));
  check('M6. a MOTOR time given in minutes becomes hours (6 minutes → 0.1 h)',
    Mo.minutes && Mo.minutes.baseHours === 0.1 && Mo.minutes.originalUnit === 'Minutes', JSON.stringify(Mo.minutes));
  check('M5. sandbox results carry the watermark everywhere they appear',
    Mo.x.prov.sandbox === true && Mo.x.prov.licensed === false && Mo.label === 'MOTOR DaaS SANDBOX — TEST DATA — NOT FOR PRODUCTION' &&
    /MOTOR DaaS SANDBOX — TEST DATA — NOT FOR PRODUCTION/.test(Mo.text) && /SANDBOX — NOT FOR CUSTOMERS/.test(Mo.text) && Mo.status === 'SANDBOX', Mo.text.slice(0, 500));
  check('19. sandbox data cannot become a customer estimate — not by choosing it, saving it or printing it',
    /SANDBOX DATA CANNOT BE USED/.test(Mo.blocked) && Mo.linesAfterRefusal === 0 && Mo.savedSandbox === false && !Mo.printed, JSON.stringify([Mo.blocked, Mo.linesAfterRefusal, Mo.savedSandbox, Mo.printed]));

  results.motorContent = await page.evaluate(async () => {
    const spec = await lookupCapability('TORQUE_SPECIFICATIONS', db.vehicles.m3, {});
    const dtc = await lookupCapability('DTC', db.vehicles.m3, {});
    const tsb = await lookupCapability('TSB', db.vehicles.m3, {});
    const fl = await lookupCapability('FLUIDS', db.vehicles.m3, {});
    const first = r => { const a = r.answers.find(y => y.providerId === 'motor_daas'); return a && Object.assign({ total: a.meta.total }, a.results[0]); };
    techVehicleId = 'm3'; techTab = 'SPECIFICATIONS'; techResults[techKey('m3', 'TORQUE_SPECIFICATIONS')] = spec; go('techdata');
    const text = document.getElementById('app').innerText;
    return { spec: first(spec), dtc: first(dtc), tsb: first(tsb), fluidsFail: fl.failures.find(f => f.providerId === 'motor_daas'), text };
  });
  const Mc2 = results.motorContent;
  check('M7. MOTOR specifications, DTCs and TSBs are normalized with values, codes, bulletin numbers and MOTOR ids — and marked SANDBOX',
    Mc2.spec && Mc2.spec.title === 'Water Pump Tightening Torque' && Mc2.spec.detail.values[0].min === '10' && Mc2.spec.detail.values[0].unit === 'Newton Meter' &&
    Mc2.spec.total === 41 && Mc2.spec.prov.sourceRecordId === '9101' && Mc2.spec.prov.sandbox === true &&
    Mc2.dtc && Mc2.dtc.code === 'P0597' && Mc2.dtc.prov.originalId === '1234' && Mc2.tsb && Mc2.tsb.bulletinNumber === 'SIB-11-07-25' && Mc2.tsb.issued === '2025-03-01' &&
    /10 Newton Meter/.test(Mc2.text) && /MOTOR DaaS SANDBOX — TEST DATA — NOT FOR PRODUCTION/.test(Mc2.text), JSON.stringify(Mc2).slice(0, 900));
  check('M8. content the MOTOR account is not licensed for reports MOTOR\'s own code instead of an empty answer',
    Mc2.fluidsFail && /403\.000103/.test(Mc2.fluidsFail.message) && /not licensed for that content/.test(Mc2.fluidsFail.message), JSON.stringify(Mc2.fluidsFail));

  results.motorFail = await page.evaluate(async () => {
    const out = {};
    for (const mode of ['badkeys', 'clock', 'down', 'timeout', 'malformed']){
      window.__motorMode = mode;
      const test = await testProvider('motor_daas');
      providerConfig('motor_daas').lastTest = null;
      const labor = await lookupCapability('LABOR_TIMES', db.vehicles.m3, { query: 'oil' });
      editOrder(null, { customerId: 'c1', vehicleId: 'm3' });
      document.getElementById('o_complaint').value = 'motor ' + mode;
      addLine('labor'); cur.labor[0].desc = 'Inspect'; cur.labor[0].hours = 1;
      saveOrder();
      out[mode] = { test, fail: labor.failures.find(f => f.providerId === 'motor_daas'), seed: (labor.answers.find(a => a.providerId === 'shop_seed') || { results: [] }).results.length,
        ro: !!Object.values(db.orders).find(o => o.complaint === 'motor ' + mode) };
    }
    window.__motorMode = 'ok';
    providerConfig('motor_daas').lastTest = null;
    return out;
  });
  const Mf = results.motorFail;
  const allKeep = Object.values(Mf).every(x => x.seed > 0 && x.ro && x.fail && x.test.ok === false);
  check('F1. MOTOR credentials invalid: MOTOR\'s code 401.000052 is shown, and the shop keeps working',
    /401\.000052/.test(Mf.badkeys.test.message) && /did not accept these keys/.test(Mf.badkeys.test.message) && Mf.badkeys.test.code === '401.000052' && allKeep, JSON.stringify(Mf.badkeys));
  check('F2. a clock outside MOTOR\'s 15-minute window is explained (403.000162)', /403\.000162/.test(Mf.clock.test.message) && /clock/.test(Mf.clock.test.message), JSON.stringify(Mf.clock));
  check('F3. MOTOR sandbox unavailable, provider timeout and a malformed response each fail that one source only',
    /no response/.test(Mf.down.fail.message) && /timed out/.test(Mf.timeout.fail.message) && /not the documented JSON layout/.test(Mf.malformed.fail.message) && allKeep, JSON.stringify(Mf).slice(0, 900));

  /* ---------------------------------------------------------------- licensed labor from more than one source */
  results.multi = await page.evaluate(async () => {
    providerConfig('motor_daas').environment = 'production'; providerConfig('motor_daas').productionLicenseConfirmed = true;
    db.vehicles.m3.externalIds = { tecrmiTypeId: '33012' };
    const labor = await lookupCapability('LABOR_TIMES', db.vehicles.m3, { query: 'water pump' });
    const by = id => (labor.answers.find(a => a.providerId === id) || { results: [] }).results;
    const motor = by('motor_daas')[0], tec = by('tecrmi')[0], tecOpt = by('tecrmi')[1], units = by('tecrmi').find(r => r.relation === 'exclusive');
    let unitsRefused = ''; try { applyLaborResult(shapeOrder({ id: 'tmp', labor: [], parts: [], status: 'Estimate' }), units, {}); } catch (e){ unitsRefused = e.message; }
    techVehicleId = 'm3'; techTab = 'LABOR'; techResults[techKey('m3', 'LABOR_TIMES')] = labor; go('techdata');
    const screen = document.getElementById('app').innerText;
    editOrder(null, { customerId: 'c1', vehicleId: 'm3' });
    document.getElementById('o_complaint').value = 'Water pump';
    window.__lastAlert = ''; const realAlert = window.alert; window.alert = m => { window.__lastAlert = m; };
    const line = applyLaborResult(cur, tec, { by: 'Zack' });
    saveOrder();
    window.alert = realAlert;
    const o = Object.values(db.orders).find(x => x.complaint === 'Water pump');

    return { providers: labor.answers.map(a => a.providerId), motor: motor && [motor.baseHours, motor.prov.licensed, motor.prov.sandbox],
      tec: tec && [tec.baseHours, tec.operationId, tec.prov.providerId], tecOpt: tecOpt && [tecOpt.baseHours, tecOpt.optional],
      autodataFail: labor.failures.find(f => f.providerId === 'autodata'), orderId: o.id, line: o.labor[0], units, unitsRefused, screen, steps: window.__lastTecSteps };
  });
  const Mu = results.multi;
  check('20. more than one provider answers the same labor question', Mu.providers.indexOf('motor_daas') >= 0 && Mu.providers.indexOf('tecrmi') >= 0 &&
    Mu.autodataFail && /LICENSE|CREDENTIALS/.test(Mu.autodataFail.message), JSON.stringify(Mu).slice(0, 700));
  check('21. conflicting labor times stay separate, each with its own source (MOTOR 5.8, TecRMI 6.2, SHOP SEED)',
    Mu.motor[0] === 5.8 && Mu.motor[1] === true && Mu.motor[2] === false && Mu.tec[0] === 6.2 && Mu.tec[2] === 'tecrmi' && Mu.tecOpt[0] === 0.3 && Mu.tecOpt[1] === true &&
    Mu.units && Mu.units.baseHours === null && Mu.units.workUnits === 62 && /manufacturer work units, not hours/.test(Mu.units.prov.applicabilityWarning) && /cannot be put on a ticket as hours/.test(Mu.unitsRefused) &&
    Mu.providers.indexOf('shop_seed') >= 0 && /3 SOURCES ANSWERED/.test(Mu.screen) && Mu.steps && /kindOfWorkTime=0/.test(Mu.steps), JSON.stringify(Mu).slice(0, 1200));
  check('22. the chosen provider is recorded on the repair-order line',
    Mu.line.type === 'licensed-labor' && Mu.line.hours === 6.2 && Mu.line.provenance.providerId === 'tecrmi' && Mu.line.provenance.operationId === '9001' &&
    Mu.line.provenance.selectedBy === 'Zack' && /TECALLIANCE TECRMI — LICENSED LABOR GUIDE/.test(Mu.line.source) && Mu.line.provenance.vehicle.vin === 'WBS8M9C55J5J78069', JSON.stringify(Mu.line));

  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  results.persist = await page.evaluate(id => {
    const l = db.orders[id].labor[0];
    return { prov: l.provenance, source: l.source, hub: db.providerHub.motor_daas && { env: db.providerHub.motor_daas.environment } };
  }, Mu.orderId);
  check('15. provenance persists through a restart', results.persist.prov.providerId === 'tecrmi' && results.persist.prov.operationId === '9001' &&
    results.persist.prov.retrievedAt && results.persist.prov.licensed === true && results.persist.hub.env === 'production', JSON.stringify(results.persist));

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
  check('31. a price never grants entitlement — only credentials do', results.price.usable === false && /CREDENTIALS|NOT LICENSED/.test(results.price.readiness), JSON.stringify(results.price));

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
    /READY FOR LICENSE \/ CREDENTIALS/.test(results.ready.tecrmi) && /READY FOR LICENSE \/ API KEY/.test(results.ready.autodata) &&
    results.ready.mitchellApi === 'PARTNER APPROVAL REQUIRED / COMMERCIAL APPROVAL REQUIRED' && /SUBSCRIPTION REQUIRED \/ PORTAL LAUNCHER/.test(results.ready.prodemand) &&
    /SUBSCRIPTION REQUIRED/.test(results.ready.alldata) && /SUBSCRIPTION REQUIRED/.test(results.ready.bmw) && /FREE \/ FREE ACCOUNT/.test(results.ready.partstech), JSON.stringify(results.ready));
  check('P2. published subscription pricing is recorded with its date, and unverified portals say so',
    Po.bmwPlans === '$32 $270 $2,700' && Po.toyotaPlans === 7 && Po.nissan === '$35 $135 $390 $1,250' && Po.unverified, JSON.stringify(Po));

  await installHooks();
  results.adapters = await page.evaluate(async fx => {
    const d1 = dataoneRequest('WBS8M9C55J5J78069');
    const dn = normalizeDataone(fx, db.vehicles.m3)[0];
    const tl = tecrmiLoginRequest();
    const at = autodataRequest('/v1/manufacturers');
    let adErr = '';
    try { await adapterAutodataLabor(db.vehicles.m3, {}); } catch (e){ adErr = e.message; }
    window.__hubTestSecretStore['autodata/apiKey'] = 'k';
    const adOk = await autodataTest();
    db.vehicles.m3.externalIds = Object.assign({}, db.vehicles.m3.externalIds, { autodataMid: 'BMW00123' });
    const adSched = await adapterAutodataMaintenance(db.vehicles.m3);
    window.__autodataMode = 'inactive';
    const adBad = await autodataTest();
    window.__autodataMode = '';
    delete window.__hubTestSecretStore['autodata/apiKey'];
    let dnErr = '';
    try { await adapterDataoneVin(db.vehicles.m3); } catch (e){ dnErr = e.message; }
    const dnStatus = (window.__hubTestSecretStore['dataone/clientId'] ? await providerUsable('dataone') : null);
    const mitchell = PROVIDER_BY_ID.mitchell_api;
    const before = providerConfig('mitchell_api').enabled;
    toggleProvider('mitchell_api');
    return { d1, dn: { trim: dn.trim, engine: dn.engine, trans: dn.transmission, style: dn.prov.sourceRecordId, env: dn.prov.environment },
      tl, at, adErr, adOk, adSched: adSched.results[0], adBad, dnErr, dnStatus, dnBase: PROVIDER_BY_ID.dataone.baseUrl, mitchellNote: mitchell.note, mitchellPrice: mitchell.pricing.notes, mitchellStill: providerConfig('mitchell_api').enabled === before,
      prodemandKind: PROVIDER_BY_ID.mitchell_prodemand.kind };
  }, DATAONE);
  const Ad = results.adapters;
  check('D1. DataOne: decode request carries only placeholders and the result is normalized with installed engine and transmission',
    Ad.d1.method === 'POST' && /client_id=\{\{secret:clientId\}\}&authorization_code=\{\{secret:authorizationCode\}\}&decoder_query=/.test(Ad.d1.body) &&
    Ad.dn.trim === 'Base' && Ad.dn.engine === '3.0L I6 Twin Turbo' && Ad.dn.trans === '6-speed manual' && Ad.dn.style === '400123', JSON.stringify(Ad.dn));
  check('T1. TecRMI: login follows its published REST authentication and keeps the token on the desktop side',
    /\/Auth\/Login$/.test(Ad.tl.url) && Ad.tl.capture_header === 'X-AuthToken' && Ad.tl.body === '{"Company":"{{secret:company}}","Account":"{{secret:account}}","Password":"{{secret:password}}"}', JSON.stringify(Ad.tl));
  results.tecList = await page.evaluate(fx => normalizeTecrmiWorkList(fx), TEC_WORKLIST);
  check('T2. TecRMI: the work list (main group → sub group → item mount position) is normalized with its ids',
    results.tecList.length === 1 && results.tecList[0].itemMpId === 101 && results.tecList[0].korId === 7 && results.tecList[0].group === 'Engine' &&
    results.tecList[0].subGroup === 'Cooling' && results.tecList[0].text === 'Water pump — remove and install', JSON.stringify(results.tecList));
  check('A1. Autodata: API-key requests follow its published samples; the key is a placeholder; errors carry Autodata\'s code; repair times stop at an honest boundary',
    Ad.at.url === 'https://api.autodata-group.com/v1/manufacturers?country-code=us&language=en-us&api_key={{secret:apiKey}}' && !Ad.at.auth &&
    Ad.adOk.ok === true && /listed 2 manufacturers/.test(Ad.adOk.message) && Ad.adBad.ok === false && /M03140301/.test(Ad.adBad.message) && /Account Inactive/.test(Ad.adBad.message) &&
    Ad.adSched && Ad.adSched.applicationId === 'SS-100' && Ad.adSched.prov.providerId === 'autodata' && Ad.adSched.prov.originalId === 'BMW00123' &&
    /documented only to licensees/.test(Ad.adErr), JSON.stringify([Ad.at, Ad.adOk, Ad.adBad, Ad.adSched, Ad.adErr]));
  check('D5. DataOne: no decode address is assumed; without the one from the welcome letter it says so',
    Ad.dnBase === '' && /No address is assumed/.test(Ad.dnErr), JSON.stringify([Ad.dnBase, Ad.dnErr, Ad.dnStatus]));
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
    Bk.bmw.notes === 'shop login is Zack' && Bk.motor.environment === 'sandbox' && !('signingVariant' in Bk.motor) && Bk.bmwStatus === 'LIVE', JSON.stringify([Bk.bmw, Bk.motor]));
  check('28. after a restore without credentials the provider says CREDENTIALS MUST BE RE-ENTERED', Bk.credState === 'reenter' &&
    Bk.motorStatus === 'CREDENTIALS MUST BE RE-ENTERED', JSON.stringify(Bk));
  check('H1. the historical invoice is unchanged by all of it', Math.abs(Bk.invAfter - S.invoice) < 0.005 && Bk.invJson === S.invJson, JSON.stringify([Bk.invAfter, S.invoice]));

  results.guards = await page.evaluate(async () => {
    await configureProvider('motor_daas');
    document.getElementById('pc_env').value = 'production'; document.getElementById('pc_prodlicense').checked = false;
    let err = ''; try { readProviderForm('motor_daas'); } catch (e){ err = e.message; }
    closeRec();
    providerConfig('motor_daas').environment = 'sandbox'; providerConfig('motor_daas').productionLicenseConfirmed = false;
    const b = providerConfig('alldata_repair'); b.subscription.status = 'active'; b.subscription.expires = '2020-01-31';
    const expired = await providerUsable('alldata_repair');
    b.subscription.status = ''; b.subscription.expires = '';
    return { err, expired };
  });
  check('G1. PRODUCTION cannot be chosen for MOTOR without confirming a production licence — sandbox keys stay SANDBOX',
    /PRODUCTION needs the MOTOR production licence/.test(results.guards.err), results.guards.err);
  check('G2. a portal subscription past its expiry date says SUBSCRIPTION EXPIRED and still opens the official site',
    results.guards.expired.readiness === 'SUBSCRIPTION EXPIRED — PORTAL LAUNCHER' && results.guards.expired.launcher === true, JSON.stringify(results.guards.expired));

  results.matrix = await page.evaluate(async () => {
    window.__hubTestSecretStore = { 'motor_daas/publicKey': 'p', 'motor_daas/privateKey': 'k' };
    ['tecrmi', 'dataone', 'autodata'].forEach(id => { providerConfig(id).credentialsConfigured = {}; providerConfig(id).lastTest = null; });   /* a machine that never had them */
    const m = providerConfig('motor_daas'); m.environment = 'sandbox'; m.enabled = true; m.lastTest = null;
    go('providers'); await new Promise(r => setTimeout(r, 900));
    const rows = {};
    document.querySelectorAll('#capMatrix tr[data-row]').forEach(tr => { const c = {}; tr.querySelectorAll('td.cm').forEach(td => c[td.getAttribute('data-cap')] = td.textContent); rows[tr.getAttribute('data-row')] = { cells: c, text: tr.innerText }; });
    return rows;
  });
  const Mx = results.matrix;
  check('X1. the capability matrix shows what works today: NHTSA public data, MOTOR sandbox, MOTOR production NOT LICENSED, TecRMI and Autodata waiting',
    Mx['NHTSA (public data)'] && Mx['NHTSA (public data)'].cells.RECALLS === '✓' && Mx['NHTSA (public data)'].cells.COMPLAINTS === '✓' && Mx['NHTSA (public data)'].cells.LABOR_TIMES === '—' &&
    Mx['MOTOR DaaS — Sandbox'] && Mx['MOTOR DaaS — Sandbox'].cells.LABOR_TIMES === '✓' && Mx['MOTOR DaaS — Sandbox'].cells.SPECIFICATIONS === '✓' && /SANDBOX/.test(Mx['MOTOR DaaS — Sandbox'].text) &&
    Mx['MOTOR DaaS — Production'] && /NOT LICENSED/.test(Mx['MOTOR DaaS — Production'].text) && Mx['MOTOR DaaS — Production'].cells.LABOR_TIMES === '○' &&
    /READY FOR LICENSE \/ CREDENTIALS/.test(Mx['TecAlliance TecRMI'].text) && /READY FOR LICENSE \/ API KEY/.test(Mx['Autodata API'].text) &&
    /READY FOR CREDENTIALS/.test(Mx['DataOne VIN Decoder API'].text), JSON.stringify(Object.fromEntries(Object.entries(Mx).filter(([k]) => /MOTOR|TecRMI|Autodata|DataOne/.test(k)).map(([k, v]) => [k, v.text]))));

  results.oem = await page.evaluate(async () => {
    window.__copied = []; const realCopy = copyText; copyText = async t => { window.__copied.push(t); return true; };
    const realAlert = window.alert; window.alert = () => {};
    techVehicleId = 'm3'; techTab = 'OEM PORTALS'; go('techdata');
    const text = document.getElementById('app').innerText;
    const buttons = Array.from(document.querySelectorAll('#app button')).map(b => b.textContent);
    for (const b of Array.from(document.querySelectorAll('#app button')).filter(b => /^Copy /.test(b.textContent))) b.click();
    await new Promise(r => setTimeout(r, 50));
    document.getElementById('xrProv').value = 'bmw_techinfo'; document.getElementById('xrRef').value = 'SIB 11 07 25'; document.getElementById('xrNote').value = 'pump bleed';
    addVehicleExternalRef('m3');
    copyText = realCopy; window.alert = realAlert;
    return { text, buttons, copied: window.__copied, refs: db.vehicles.m3.externalRefs };
  });
  const Oe = results.oem;
  check('O1. OEM PORTALS: open the official portal, copy VIN / year-make-model / engine / RO, and record an external reference',
    /BMW TechInfo/.test(Oe.text) && Oe.buttons.filter(b => b === 'OPEN OFFICIAL PORTAL').length >= 5 && Oe.copied.indexOf('WBS8M9C55J5J78069') >= 0 &&
    Oe.copied.some(t => /^2018 BMW M3/.test(t)) && Oe.copied.length >= 3 && Oe.refs && Oe.refs[0].reference === 'SIB 11 07 25' && Oe.refs[0].providerId === 'bmw_techinfo', JSON.stringify(Oe).slice(0, 900));

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
  console.log('\n The live MOTOR sandbox call is not made here (no request leaves this machine): see cargo test motor_sandbox_live and testmotorlive.cjs.');
  if (failures.length){
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL DATA PROVIDER HUB CHECKS PASSED');
})();

function TECH_TABS_OK(seen){
  const tabs = ['OVERVIEW', 'VEHICLE', 'RECALLS', 'MANUFACTURER COMMUNICATIONS / TSBs', 'COMPLAINTS', 'INVESTIGATIONS', 'LABOR', 'PROCEDURES',
    'SPECIFICATIONS', 'MAINTENANCE', 'FLUIDS', 'DTC', 'WIRING', 'PARTS', 'OEM PORTALS', 'SAFETY INFORMATION'];
  return tabs.every(t => seen[t] > 80);
}
