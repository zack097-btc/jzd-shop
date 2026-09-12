/* LIVE: the page's MOTOR adapters against MOTOR's public DaaS sandbox.

   This is the one suite that leaves the machine. It needs the sandbox keys MOTOR
   publishes for developers at motor.com/daas-sandbox, supplied as
   MOTOR_SANDBOX_PUBLIC and MOTOR_SANDBOX_PRIVATE. They are never stored in this
   repository or in a shop book; without them the suite says SKIPPED.

   The desktop shell's provider_fetch is stood in for by a Node bridge that does
   what hub::prepare_provider_request does — MOTOR's host only, signing headers
   refused from the page, MOTOR's documented Shared signature, no redirects.
   The shell's own Rust code makes the same calls in cargo test motor_sandbox_live. */
const { chromium } = require('playwright');
const crypto = require('crypto');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const PUB = process.env.MOTOR_SANDBOX_PUBLIC, PRIV = process.env.MOTOR_SANDBOX_PRIVATE;
if (!PUB || !PRIV){
  console.log('SKIPPED: MOTOR_SANDBOX_PUBLIC / MOTOR_SANDBOX_PRIVATE are not set (see motor.com/daas-sandbox).');
  process.exit(0);
}

const failures = [];
function check(name, cond, detail){
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name);
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}

let privateKeyInUse = PRIV;
const calls = [];
async function bridge(providerId, req){
  if (providerId !== 'motor_daas') throw new Error('the bridge only speaks for motor_daas');
  const u = new URL(req.url);
  if (u.protocol !== 'https:' || u.hostname !== 'api.motor.com' || u.username) throw new Error(u.hostname + ' is not a host that motor_daas credentials may be sent to');
  if (req.auth !== 'motor_shared') throw new Error('unsigned MOTOR request');
  const signed = (req.headers || []).find(h => /^(authorization|x-date|date)$/i.test(h[0]));
  if (signed) throw new Error('the ' + signed[0] + ' header is set by the signing step, not by the page');
  const epoch = Math.floor(Date.now() / 1000);
  const data = PUB + '\n' + (req.method || 'GET') + '\n' + epoch + '\n' + u.pathname;
  const headers = Object.fromEntries(req.headers || []);
  headers['X-Date'] = new Date(epoch * 1000).toUTCString();
  headers['Authorization'] = 'Shared ' + PUB + ':' + crypto.createHmac('sha256', privateKeyInUse).update(data).digest('base64');
  const res = await fetch(req.url, { method: req.method || 'GET', headers, redirect: 'manual' });
  const text = await res.text();
  calls.push({ path: u.pathname, status: res.status });
  if (res.status >= 300 && res.status < 400) throw new Error('REDIRECT_REFUSED');
  return { status: res.status, text };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.exposeFunction('__motorBridge', (id, req) => bridge(id, req));
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });

  const R = await page.evaluate(async () => {
    window.__hubTestProviderFetch = (id, req) => window.__motorBridge(id, req);
    /* the bridge holds the keys; the page only learns that they exist */
    window.__hubTestSecretStore = { 'motor_daas/publicKey': 'held-by-the-shell', 'motor_daas/privateKey': 'held-by-the-shell' };
    const r = {};
    db.vehicles.civic = { id: 'civic', year: '2010', make: 'Honda', model: 'Civic', vin: '19XFA1F57AE000001', customerId: '' };
    const c = providerConfig('motor_daas'); c.environment = 'sandbox'; c.enabled = true;
    c.credentialsConfigured = { publicKey: new Date().toISOString(), privateKey: new Date().toISOString() };
    save();
    r.test = await testProvider('motor_daas');
    r.status = await providerUsable('motor_daas');
    const v = db.vehicles.civic;
    const vin = await lookupCapability('VIN_IDENTIFICATION', v, {});
    r.vin = (vin.answers.find(a => a.providerId === 'motor_daas') || { results: [] }).results[0];
    const labor = await lookupCapability('LABOR_TIMES', v, { query: 'brake' });
    r.motorLabor = (labor.answers.find(a => a.providerId === 'motor_daas') || { results: [] }).results;
    r.seedLabor = (labor.answers.find(a => a.providerId === 'shop_seed') || { results: [] }).results;
    const o = shapeOrder({ id: 'live1', num: 1, vehicleId: 'civic', status: 'Estimate', labor: [], parts: [], date: '2026-09-12' });
    db.orders.live1 = o;
    try { applyLaborResult(o, r.motorLabor[0], {}); r.sandboxApplied = 'APPLIED'; } catch (e){ r.sandboxApplied = e.message; }
    r.linesAfter = o.labor.length;
    for (const cap of ['MAINTENANCE', 'SPECIFICATIONS', 'FLUIDS', 'DTC', 'TSB']){
      const x = await lookupCapability(cap, v, cap === 'FLUIDS' ? { query: 'engine oil' } : {});
      const a = x.answers.find(y => y.providerId === 'motor_daas');
      r[cap] = a ? { n: a.results.length, first: a.results[0], allSandbox: a.results.every(z => z.prov.sandbox && !z.prov.licensed) } : { failures: x.failures };
    }
    techVehicleId = 'civic'; techTab = 'LABOR'; techResults[techKey('civic', 'LABOR_TIMES')] = labor; go('techdata');
    r.screen = document.getElementById('app').innerText;
    r.label = r.motorLabor[0] && provenanceLabel(r.motorLabor[0].prov);
    return r;
  });

  check('L1. MOTOR accepts the published sandbox keys, signed with the documented Shared scheme (HelloWorld)', R.test.ok === true && R.status.readiness === 'SANDBOX CONNECTED', JSON.stringify([R.test, R.status]));
  check('L2. a vehicle endpoint answers: the VIN identifies a 2010 Honda Civic with MOTOR\'s own ids',
    R.vin && R.vin.year === 2010 && R.vin.make === 'Honda' && R.vin.model === 'Civic' && R.vin.baseVehicleId > 0 && R.vin.engineId > 0, JSON.stringify(R.vin));
  check('L3. MOTOR labor is normalized into the hub\'s labor results, in hours, with MOTOR operation and work-time ids',
    R.motorLabor.length > 0 && R.motorLabor.every(x => typeof x.baseHours === 'number' && x.operationId && x.workTimeId && x.prov.providerId === 'motor_daas'), JSON.stringify(R.motorLabor.slice(0, 2)));
  check('L4. provenance is kept: provider, capability, vehicle, retrieval time and source record',
    R.motorLabor[0] && R.motorLabor[0].prov.capability === 'LABOR_TIMES' && R.motorLabor[0].prov.vehicle.vin === '19XFA1F57AE000001' &&
    !!R.motorLabor[0].prov.retrievedAt && R.motorLabor[0].prov.sourceRecordId === R.motorLabor[0].workTimeId, JSON.stringify(R.motorLabor[0] && R.motorLabor[0].prov));
  check('L5. every sandbox result is visibly SANDBOX, and never marked licensed',
    R.vin.prov.sandbox === true && R.motorLabor.every(x => x.prov.sandbox === true && x.prov.licensed === false && x.prov.environment === 'sandbox') &&
    R.label === 'MOTOR DaaS SANDBOX — TEST DATA — NOT FOR PRODUCTION' && /MOTOR DaaS SANDBOX — TEST DATA — NOT FOR PRODUCTION/.test(R.screen), R.label);
  check('L6. sandbox labor cannot become a customer estimate line; SHOP SEED still can',
    /SANDBOX DATA CANNOT BE USED/.test(R.sandboxApplied) && R.linesAfter === 0 && /SANDBOX — NOT FOR CUSTOMERS/.test(R.screen) && R.seedLabor.length > 0, R.sandboxApplied);
  check('L7. maintenance, specifications (with values), fluids, DTCs and TSBs come back normalized and SANDBOX-marked',
    ['MAINTENANCE', 'SPECIFICATIONS', 'FLUIDS', 'DTC', 'TSB'].every(k => R[k].n > 0 && R[k].allSandbox) && R.SPECIFICATIONS.first.detail &&
    R.FLUIDS.first.detail && R.FLUIDS.first.detail.fluids.length > 0 && !!R.DTC.first.code && !!R.TSB.first.bulletinNumber,
    JSON.stringify(Object.fromEntries(['MAINTENANCE', 'SPECIFICATIONS', 'FLUIDS', 'DTC', 'TSB'].map(k => [k, R[k].n || R[k].failures]))));

  privateKeyInUse = 'not-the-private-key';
  const bad = await page.evaluate(() => testProvider('motor_daas'));
  privateKeyInUse = PRIV;
  check('L8. a wrong private key is refused by MOTOR and its own code is shown (401.000052)', bad.ok === false && bad.code === '401.000052', JSON.stringify(bad));
  check('L9. nothing threw on the page', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log('\n MOTOR sandbox calls: ' + calls.length + ' (' + Object.entries(calls.reduce((m, c) => (m[c.status] = (m[c.status] || 0) + 1, m), {})).map(([k, n]) => n + '×' + k).join(', ') + ')');
  console.log(' Vehicle: ' + [R.vin.year, R.vin.make, R.vin.model, R.vin.submodel, R.vin.engine].join(' ') + ' · first labor: ' + (R.motorLabor[0] ? R.motorLabor[0].description + ' ' + R.motorLabor[0].baseHours + ' h' : '—'));
  if (failures.length){
    console.log('\n' + failures.length + ' LIVE CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL LIVE MOTOR SANDBOX CHECKS PASSED');
})();
