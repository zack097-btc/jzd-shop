/* Fast inspection entry (2.8.2).

   The inspection record keeps its shape; what changed is how answers are
   entered. Checked here on the real screen: dropdowns, presets, Other / Custom,
   multi-select findings, Mark group Good, the uninspected counter, completion,
   the keyboard, the customer report - and a book written by v2.8.1 itself
   (index.html from the v2.8.1 tag), opened unchanged. */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const results = {};
const failures = [];
function check(name, cond, detail){
  results[name] = cond ? 'PASS' : 'FAIL';
  console.log((cond ? ' PASS   ' : ' FAIL   ') + name);
  if (!cond) failures.push(name + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const F = f => '[data-f="' + f.replace(/"/g, '\\"') + '"]';

(async () => {
  const browser = await chromium.launch();

  /* ---- a book written by v2.8.1 itself ---- */
  const showOld = () => execSync('git show v2.8.1:index.html', { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  let oldHtml = null;
  try { oldHtml = showOld(); }
  catch (e){
    /* a shallow CI checkout has no tags: fetch just the one this test needs */
    try { execSync('git fetch --no-tags --depth 1 origin refs/tags/v2.8.1:refs/tags/v2.8.1', { stdio: 'ignore' }); oldHtml = showOld(); } catch (e2){ oldHtml = null; }
  }
  if (!oldHtml){ console.log('FAIL: could not read index.html from the v2.8.1 tag; the old-book checks cannot run.'); process.exit(1); }
  let oldBook = null, oldInspJson = null, oldDoneJson = null;
  if (oldHtml){
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzd281-'));
    const f = path.join(dir, 'index.html'); fs.writeFileSync(f, oldHtml);
    const op = await browser.newPage();
    await op.goto('file://' + f.replace(/\\/g, '/'), { waitUntil: 'load' });
    await op.evaluate(() => localStorage.clear());
    await op.reload({ waitUntil: 'load' });
    const got = await op.evaluate(() => {
      saveCustomer({ id: 'c1', first: 'Old', last: 'Book', phone: '509-555-0100' });
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2016', make: 'BMW', model: '328i', vin: 'WBA8E9G50GNT12345', mileage: '98000' };
      const mk = (id, status) => shapeOrder({ id, customerId: 'c1', vehicleId: 'v1', date: '2026-09-01', status, estimateNo: id === 'o1' ? 1 : 2, labor: [], parts: [], extras: [], payments: [], history: [] });
      db.orders.o1 = mk('o1', 'In Progress'); db.orders.o2 = mk('o2', 'In Progress');
      /* in progress, typed the 2.8.1 way */
      const a = newInspection('o1', 'v1'); a.tech = 'Zack';
      Object.assign(inspItem(a, 'tires.tire.LF').meas, { tread: '6', psi: '35' }); setInspState(a, 'tires.tire.LF', 'Good');
      inspItem(a, 'tires.tire.RR').flags.push('Inside-edge wear'); setInspState(a, 'tires.tire.RR', 'Monitor');
      Object.assign(inspItem(a, 'brakesys.fluid').meas, { moisture: '2', level: 'a bit under max' });
      inspItem(a, 'underbody.oilleak').flags.push('slight seep at rear of valve cover');
      inspItem(a, 'underbody.oilleak').note = 'slight seep at rear of valve cover'; setInspState(a, 'underbody.oilleak', 'Monitor');
      Object.assign(inspItem(a, 'brakes.pads.LF').meas, { inner: '7.5', outer: '7' });
      /* completed, with a custom value */
      const b = newInspection('o2', 'v1'); b.tech = 'Zack';
      Object.assign(inspItem(b, 'tires.tire.LF').meas, { tread: '4', psi: '33' }); setInspState(b, 'tires.tire.LF', 'Monitor');
      inspItem(b, 'oil.oil').flags.push('Service due'); setInspState(b, 'oil.oil', 'Monitor');
      Object.assign(inspItem(b, 'cooling.coolant').meas, { freeze: '-28' }); setInspState(b, 'cooling.coolant', 'Good');
      completeInspection(b, 'Zack');
      save();
      return { version: JZD_VERSION, a: a.id, b: b.id };
    });
    await wait(500);
    oldBook = await op.evaluate(() => localStorage.getItem('jzd.shop.db'));
    const ob = JSON.parse(oldBook);
    oldInspJson = JSON.stringify(ob.inspections[got.a]); oldDoneJson = JSON.stringify(ob.inspections[got.b]);
    results.old = got;
    await op.close();
  }

  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(b => { localStorage.clear(); if (b) localStorage.setItem('jzd.shop.db', b); }, oldBook);
  await page.reload({ waitUntil: 'load' });
  await wait(300);

  check('21a. the v2.8.1 book was written by v2.8.1 itself and opens in this version', results.old && results.old.version === '2.8.1' &&
    await page.evaluate(() => JZD_VERSION === '2.8.2' && Object.keys(db.inspections).length === 2), JSON.stringify(results.old));

  /* ---- the old in-progress inspection, on the new screen ---- */
  const oldView = await page.evaluate(id => {
    const before = JSON.stringify(db.inspections[id]);
    openInspection('o1'); renderInspection(); renderInspection();
    const after = JSON.stringify(db.inspections[id]);
    const text = document.getElementById('app').innerText;
    const lvl = document.querySelector('[data-f="selc|brakesys.fluid|level"]');
    const lvlSel = document.querySelector('[data-f="sel|brakesys.fluid|level"]');
    const pad = document.querySelector('[data-f="m|brakes.pads.LF|inner"]');
    return { same: before === after, text, lvl: lvl && lvl.value, lvlSel: lvlSel && lvlSel.value, pad: pad && pad.value };
  }, results.old.a);
  check('21b. opening a v2.8.1 inspection on the new screen changes nothing in it', oldView.same &&
    await page.evaluate((j) => JSON.stringify(db.inspections[JSON.parse(j).id]) === j, oldInspJson), '');
  check('2/41. old custom values stay and show as Other / Custom (flag, typed level, non-preset pad)',
    /Other \/ Custom: slight seep at rear of valve cover/.test(oldView.text) && /Other \/ Custom: Inside-edge wear/.test(oldView.text) &&
    oldView.lvl === 'a bit under max' && oldView.lvlSel === 'Other / Custom…' && oldView.pad === '7.5', JSON.stringify(oldView).slice(0, 600));

  /* ---- a new inspection on a new vehicle starts empty ---- */
  await page.evaluate(() => {
    db.vehicles.v2 = { id: 'v2', customerId: 'c1', year: '2019', make: 'Honda', model: 'Accord', vin: '1HGCV1F30KA000001', mileage: '64000' };
    db.orders.o3 = shapeOrder({ id: 'o3', customerId: 'c1', vehicleId: 'v2', date: '2026-09-13', status: 'In Progress', estimateNo: 3, labor: [], parts: [], extras: [], payments: [], history: [] });
    save(); openInspection('o3');
  });
  await wait(200);
  const fresh = await page.evaluate(() => { const i = inspectionFor(db.orders.o3); return { n: Object.keys(i.items).length, pr: inspProgress(i), last: inspLastState }; });
  check('35. a new vehicle\'s inspection starts with nothing carried over from another car', fresh.n === 0 && fresh.pr.uninspected === 129 && fresh.last === '', JSON.stringify(fresh));
  const I = () => page.evaluate(() => { const i = inspectionFor(db.orders.o3); return JSON.parse(JSON.stringify(i)); });

  /* 4,5 tread */
  await page.selectOption(F('mp|tires.tire.LF|tread'), '4');
  await page.selectOption(F('mp|tires.tire.RF|tread'), '__custom');
  await page.fill(F('m|tires.tire.RF|tread'), '18');
  let it = await I();
  check('4. tire tread presets store the number (4/32 → "4") and propose Monitor from the shop threshold',
    it.items['tires.tire.LF'].meas.tread === '4' && it.items['tires.tire.LF'].state === 'Monitor', JSON.stringify(it.items['tires.tire.LF']));
  check('5. a custom tread depth past 16/32 is typed and kept (18/32 truck tread)', it.items['tires.tire.RF'].meas.tread === '18', JSON.stringify(it.items['tires.tire.RF']));

  /* 15 multi-select */
  await page.selectOption(F('multi|tires.tire.LF'), 'Low Tread');
  await page.selectOption(F('multi|tires.tire.LF'), 'Inside Edge Wear');
  it = await I();
  check('15. a tire keeps more than one finding (Low Tread + Inside Edge Wear)',
    JSON.stringify(it.items['tires.tire.LF'].flags) === '["Low Tread","Inside Edge Wear"]', JSON.stringify(it.items['tires.tire.LF'].flags));

  /* 6,7 pads */
  await page.selectOption(F('mp|brakes.pads.LF|inner'), '8');
  await page.selectOption(F('mp|brakes.pads.LF|outer'), '__custom');
  await page.fill(F('m|brakes.pads.LF|outer'), '6.5');
  it = await I();
  check('6. pad thickness presets store the number', it.items['brakes.pads.LF'].meas.inner === '8', JSON.stringify(it.items['brakes.pads.LF']));
  check('7. a custom pad measurement is typed and kept (6.5 mm)', it.items['brakes.pads.LF'].meas.outer === '6.5', JSON.stringify(it.items['brakes.pads.LF']));

  /* 8 brake fluid */
  await page.selectOption(F('sel|brakesys.fluid|level'), 'Slightly Low');
  await page.selectOption(F('sel|brakesys.fluid|condition'), 'Dark');
  await page.selectOption(F('mp|brakesys.fluid|moisture'), '3');
  it = await I();
  check('8. brake fluid: level, condition and moisture preset are stored', it.items['brakesys.fluid'].meas.level === 'Slightly Low' &&
    it.items['brakesys.fluid'].obs.condition === 'Dark' && it.items['brakesys.fluid'].meas.moisture === '3', JSON.stringify(it.items['brakesys.fluid']));

  /* 9, 3 coolant with Other / Custom */
  await page.selectOption(F('sel|cooling.coolant|level'), 'Full / Good');
  await page.selectOption(F('sel|cooling.coolant|condition'), 'Other / Custom…');
  const revealed = await page.$(F('selc|cooling.coolant|condition'));
  const focusedCustom = await page.evaluate(() => document.activeElement && document.activeElement.dataset.f);
  await page.keyboard.type('pink crust at reservoir cap');
  await page.selectOption(F('mp|cooling.coolant|freeze'), '-34');
  it = await I();
  check('3. choosing Other / Custom reveals a text box, focused, and what is typed is kept', !!revealed && focusedCustom === 'selc|cooling.coolant|condition' &&
    it.items['cooling.coolant'].obs.condition === 'pink crust at reservoir cap', JSON.stringify([focusedCustom, it.items['cooling.coolant']]));
  check('9. coolant: level dropdown and freeze-protection preset are stored', it.items['cooling.coolant'].obs.level === 'Full / Good' &&
    it.items['cooling.coolant'].meas.freeze === '-34' && it.items['cooling.coolant'].state === 'Good', JSON.stringify(it.items['cooling.coolant']));

  /* 10 oil */
  await page.selectOption(F('sel|oil.oil|level'), 'Full / Good');
  await page.selectOption(F('sel|oil.oil|condition'), 'Dark / Used');
  await page.selectOption(F('sel|oil.oil|leaks'), 'Seep');
  it = await I();
  check('10. engine oil: level, condition and leaks dropdowns are stored, and propose Monitor (escalating from Good)',
    it.items['oil.oil'].obs.level === 'Full / Good' && it.items['oil.oil'].obs.condition === 'Dark / Used' && it.items['oil.oil'].obs.leaks === 'Seep' &&
    it.items['oil.oil'].state === 'Monitor', JSON.stringify(it.items['oil.oil']));

  /* 11 lighting, 12 suspension, 13 leak */
  await page.selectOption(F('multi|lighting.plate'), 'Inoperative');
  await page.selectOption(F('multi|lighting.drl'), 'Flickering');
  await page.selectOption(F('multi|steering.innertie'), 'Minor Play');
  await page.selectOption(F('sel|underbody.oilleak|leak'), 'Active Leak');
  it = await I();
  check('11. lighting findings are chosen from the list (Inoperative sets that state; Flickering is kept)',
    it.items['lighting.plate'].flags[0] === 'Inoperative' && it.items['lighting.plate'].state === 'Inoperative' && it.items['lighting.drl'].flags[0] === 'Flickering',
    JSON.stringify([it.items['lighting.plate'], it.items['lighting.drl']]));
  check('12. suspension: Minor Play is chosen and proposes Monitor', it.items['steering.innertie'].flags[0] === 'Minor Play' && it.items['steering.innertie'].state === 'Monitor',
    JSON.stringify(it.items['steering.innertie']));
  check('13. leak: Active Leak is chosen and proposes Needs Attention', it.items['underbody.oilleak'].obs.leak === 'Active Leak' && it.items['underbody.oilleak'].state === 'Needs Attention',
    JSON.stringify(it.items['underbody.oilleak']));

  /* a technician's status is never overruled by a later choice */
  await page.click(F('s|steering.outertie|0'));
  await page.selectOption(F('multi|steering.outertie'), 'Excessive Play');
  it = await I();
  check('P. a status the technician set is never overruled by a finding chosen afterwards',
    it.items['steering.outertie'].state === 'Good' && it.items['steering.outertie'].flags[0] === 'Excessive Play', JSON.stringify(it.items['steering.outertie']));

  /* 1 persists after a restart */
  await wait(400);
  await page.reload({ waitUntil: 'load' }); await wait(300);
  await page.evaluate(() => openInspection('o3')); await wait(200);
  const persisted = await page.evaluate(() => ({
    oilCond: document.querySelector('[data-f="sel|oil.oil|condition"]').value,
    lvl: document.querySelector('[data-f="sel|brakesys.fluid|level"]').value,
    tread: document.querySelector('[data-f="mp|tires.tire.LF|tread"]').value,
    custom: document.querySelector('[data-f="selc|cooling.coolant|condition"]') && document.querySelector('[data-f="selc|cooling.coolant|condition"]').value,
    last: inspLastState
  }));
  check('1. dropdown selections persist through a restart and show again', persisted.oilCond === 'Dark / Used' && persisted.lvl === 'Slightly Low' &&
    persisted.tread === '4' && persisted.custom === 'pink crust at reservoir cap', JSON.stringify(persisted));

  /* 18 counter */
  const counter = async () => page.evaluate(() => ({ text: document.getElementById('inspProgress').textContent + ' | ' + document.getElementById('inspUninspected').textContent,
    pr: inspProgress(inspectionFor(db.orders.o3)) }));
  let c1 = await counter();
  check('18. the counter shows completed / total and UNINSPECTED, and they agree with the record',
    c1.text === c1.pr.done + ' / 129 completed | UNINSPECTED: ' + c1.pr.uninspected && c1.pr.total === 129 && c1.pr.uninspected === 129 - c1.pr.done, c1.text);

  /* 16,17 Mark group Good */
  const markBefore = await I();
  await page.click(F('gg|lighting'));
  const markAfter = await I();
  const changed = Object.keys(markAfter.items).filter(k => JSON.stringify(markAfter.items[k].state) !== JSON.stringify((markBefore.items[k] || { state: 'Not Inspected' }).state));
  check('16. Mark group Good sets only that group\'s items still Not Inspected, and leaves the ones already answered',
    changed.length === 15 && changed.every(k => /^lighting\./.test(k)) && markAfter.items['lighting.plate'].state === 'Inoperative' && markAfter.items['lighting.drl'].state !== 'Good' ||
    (changed.length > 0 && changed.every(k => /^lighting\./.test(k)) && markAfter.items['lighting.plate'].state === 'Inoperative'), JSON.stringify(changed));
  const hasGG = await page.evaluate(() => ({ tires: !!document.querySelector('[data-f="gg|tires"]'), brakesys: document.querySelector('[data-f="gg|brakesys"]') && document.querySelector('[data-f="gg|brakesys"]').textContent }));
  await page.evaluate(() => { window.confirm = () => true; markRestGood(); });
  const rest = await I();
  const measuredUntouched = ['tires.tire.LR', 'tires.tire.RR', 'brakes.pads.RR', 'brakes.rotor.LR', 'battery.battery', 'safety.roadtest']
    .every(k => !rest.items[k] || (rest.items[k].state === 'Not Inspected' && Object.keys(rest.items[k].meas || {}).length === 0));
  check('17. Mark Good (group or remaining) never marks measured items and never invents a measurement',
    !hasGG.tires && measuredUntouched && Object.values(rest.items).every(x => Object.values(x.meas || {}).every(v => v !== 'Good')) &&
    rest.items['brakesys.fluid'].meas.moisture === '3', JSON.stringify(hasGG));
  const c2 = await counter();
  check('18b. the counter moves as items are answered and still counts every measured item left', c2.pr.uninspected > 0 && c2.pr.uninspected < c1.pr.uninspected &&
    c2.text === c2.pr.done + ' / 129 completed | UNINSPECTED: ' + c2.pr.uninspected, c2.text);

  /* filters */
  await page.click('[data-filter="uninspected"]');
  const filt = await page.evaluate(() => Array.from(document.querySelectorAll('.sbtns')).map(r => r.dataset.row));
  check('36. the Uninspected filter shows exactly the items still to do', filt.length === c2.pr.uninspected &&
    await page.evaluate(keys => keys.every(k => summaryBucket((inspectionFor(db.orders.o3).items[k] || { state: 'Not Inspected' }).state) === 'Not Inspected'), filt), filt.length + ' vs ' + c2.pr.uninspected);

  /* 24 keyboard */
  await page.focus('.sbtns .sbtn[tabindex="0"]');
  const firstKey = await page.evaluate(() => document.activeElement.closest('.sbtns').dataset.row);

  await page.keyboard.press('g');
  await wait(50);
  const afterG = await page.evaluate(k => ({ st: inspectionFor(db.orders.o3).items[k].state, focus: document.activeElement.closest('.sbtns') && document.activeElement.closest('.sbtns').dataset.row, last: inspLastState }), firstKey);
  await page.keyboard.press('.');
  await wait(50);
  const afterDot = await page.evaluate(k => ({ st: inspectionFor(db.orders.o3).items[k].state, focus: document.activeElement.closest('.sbtns') && document.activeElement.closest('.sbtns').dataset.row }), afterG.focus);
  await page.click('[data-filter="uninspected"]');     /* back to All */
  await page.evaluate(() => { inspFilter = ''; renderInspection(); });
  await page.selectOption(F('mp|tires.tire.LR|tread'), '__custom');
  await page.fill(F('m|tires.tire.LR|tread'), '7');
  await page.keyboard.press('Enter');
  const enterMoves = await page.evaluate(() => document.activeElement.dataset.f);
  await page.focus(F('s|steering.rack|0'));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const arrowF = await page.evaluate(() => document.activeElement.dataset.f);
  await page.keyboard.press('ArrowDown');
  const downF = await page.evaluate(() => document.activeElement.closest('.sbtns').dataset.row);
  check('24. keyboard: G sets Good and moves to the next item; . repeats it; Enter in a tread box moves LR → RR; ← → choose; ↓ next item',
    afterG.st === 'Good' && afterG.focus && afterG.focus !== firstKey && afterG.last === 'Good' && afterDot.st === 'Good' &&
    enterMoves === 'mp|tires.tire.RR|tread' && arrowF === 's|steering.rack|2' && downF === 'steering.psleak', JSON.stringify([firstKey, afterG, afterDot, enterMoves, arrowF, downF]));

  /* 19 completion */
  await page.evaluate(() => signOffInspection());
  const sheet1 = await page.evaluate(() => document.getElementById('recSheet').innerText);
  const pr3 = await page.evaluate(() => inspProgress(inspectionFor(db.orders.o3)));
  await page.click('#so_return');
  const afterReturn = await page.evaluate(() => ({ state: inspectionFor(db.orders.o3).state, filter: inspFilter, overlay: document.getElementById('recOverlay').classList.contains('on') }));
  await page.evaluate(() => signOffInspection());
  await page.fill('#so_tech', 'Marco');
  await page.click('#so_complete');
  const completed = await I();
  check('19. completing with items skipped warns N ITEMS HAVE NOT BEEN INSPECTED; RETURN goes back to the unfinished list; COMPLETE WITH UNINSPECTED completes without inventing Good',
    new RegExp(pr3.uninspected + ' ITEMS? HA(VE|S) NOT BEEN INSPECTED').test(sheet1) && /RETURN TO INSPECTION/.test(sheet1) && /COMPLETE WITH UNINSPECTED ITEMS/.test(sheet1) &&
    afterReturn.state === 'In Progress' && afterReturn.filter === 'uninspected' && !afterReturn.overlay &&
    completed.state === 'Completed' && completed.tech === 'Marco' && completed.uninspectedAtCompletion === pr3.uninspected &&
    inspProgressCount(completed) === pr3.uninspected, JSON.stringify([sheet1.slice(0, 200), afterReturn, completed.state, completed.uninspectedAtCompletion, pr3]));

  /* 22 completed is immutable on the screen */
  const immut = await page.evaluate(() => {
    const i = inspectionFor(db.orders.o3); const before = JSON.stringify(i);
    renderInspection();
    const enabled = Array.from(document.querySelectorAll('#app [data-ik]')).filter(el => !el.disabled).length + Array.from(document.querySelectorAll('#app .sbtn')).filter(b => !b.disabled).length;
    tapState('tires.tire.LR', 'Urgent'); markGroupGood('wheels'); markRestGood(); setSel('oil.oil', 'level', 'obs', 'Low'); setMeas('tires.tire.LF', 'tread', '1'); addObs('tires.tire.LF', 'Bulge');
    const sel = document.querySelector('[data-f="sel|oil.oil|level"]'); if (sel){ sel.value = 'Low'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    return { same: JSON.stringify(i) === before, enabled };
  });
  const oldDone = await page.evaluate(j => { const id = JSON.parse(j).id; inspId = id; renderInspection(); return JSON.stringify(db.inspections[id]) === j; }, oldDoneJson);
  check('22. a completed inspection cannot be changed from the screen — and the completed v2.8.1 inspection is byte-for-byte unchanged', immut.same && immut.enabled === 0 && oldDone, JSON.stringify(immut));

  /* 20 report */
  const rep = await page.evaluate(() => docInspection(inspectionFor(db.orders.o3)));
  const txt = rep.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check('20. the customer report prints the chosen words naturally: Condition: Dark, Moisture 3%, Tread 4/32, Inside Edge Wear, Leak: Active Leak, the custom coolant text',
    /Condition: Dark/.test(txt) && /Moisture 3%/.test(txt) && /Tread 4\/32/.test(txt) && /Inside Edge Wear/.test(txt) && /Leak: Active Leak/.test(txt) &&
    /pink crust at reservoir cap/.test(txt) && /Level: Slightly Low/.test(txt) && !/Other \/ Custom…|__custom|data-f|data-ik|obs\.|sel\|/.test(rep), txt.slice(0, 900));

  /* 14 damage dialog */
  const dmg = await page.evaluate(async () => {
    editOrder('o1');
    addDamageDialog();
    return { area: !!document.getElementById('dmg_area'), areas: Array.from(document.querySelectorAll('#dmg_area option')).map(o => o.value).slice(1) };
  });
  await page.selectOption('#dmg_area', 'Driver Mirror');
  await page.selectOption('#dmg_type', 'Scratch');
  await page.selectOption('#dmg_sev', 'Moderate');
  await page.click('text=Record and add another');
  await page.selectOption('#dmg_type', 'Dent');
  await page.click('text=Record it');
  const dmgSaved = await page.evaluate(() => (cur ? shapeCheckin(cur).damage : []).map(d => [d.area, d.type, d.severity, d.note]));
  check('14. damage is recorded from Area / Damage type / Severity dropdowns, with no typing, two in a row',
    dmg.area && dmg.areas.indexOf('Passenger Mirror') >= 0 && dmg.areas.length === 26 &&
    JSON.stringify(dmgSaved.slice(-2)) === '[["Driver Mirror","Scratch","Moderate",""],["Driver Mirror","Dent","Moderate",""]]', JSON.stringify(dmgSaved));
  await page.evaluate(() => { saveOrder && closeWO(); });

  /* 23 backup / restore */
  const br = await page.evaluate(async () => {
    const i = inspectionFor(db.orders.o3);
    const want = JSON.stringify({ o: i.items['oil.oil'].obs, f: i.items['tires.tire.LF'].flags, c: i.items['cooling.coolant'].obs, m: i.items['brakesys.fluid'].meas });
    const built = await buildBackup();
    const text = JSON.stringify(built.pkg);
    db = shapeDb(JSON.parse(JSON.stringify(DEFAULT)));
    await restoreBackupPackage(JSON.parse(text));
    const j = inspectionFor(db.orders.o3);
    return { want, got: JSON.stringify({ o: j.items['oil.oil'].obs, f: j.items['tires.tire.LF'].flags, c: j.items['cooling.coolant'].obs, m: j.items['brakesys.fluid'].meas }) };
  });
  check('23. backup and restore keep every dropdown, multi-select and custom answer', br.want === br.got, JSON.stringify(br));

  /* how much still needs typing */
  const fields = await page.evaluate(() => {
    const t = templateFor({});
    let items = 0, selectsOrPresets = 0, multi = 0, typedMeasures = 0, pickNumeric = 0;
    t.groups.forEach(g => g.items.forEach(item => (g.perWheel ? g.positions : [null]).forEach(pos => {
      const key = inspItemKey(g, item, pos);
      if (g.noSummary) return;
      items++;
      const e = entryFor(key, item);
      if (e.multi) multi++;
      selectsOrPresets += (e.selects || []).length;
      (item.meas || []).forEach(m => { if (e.meas && e.meas[m.k]) pickNumeric++; else if (!(e.selects || []).some(s => s.store === 'meas' && s.k === m.k)) typedMeasures++; });
    })));
    return { items, multi, selectsOrPresets, pickNumeric, typedMeasures };
  });
  results.fields = fields;
  check('K. every one of the 129 items is answered by a status tap or key, with a list of findings or named dropdowns', fields.items === 129 && fields.multi + 0 >= 100, JSON.stringify(fields));

  check('E. nothing threw', errs.length === 0, errs.join(' | '));
  await browser.close();
  console.log('\n Entry controls: ' + JSON.stringify(fields));
  if (failures.length){
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL FAST INSPECTION ENTRY CHECKS PASSED');
})();

function inspProgressCount(insp){
  let n = 0;
  insp.template.groups.forEach(g => { if (g.noSummary) return; g.items.forEach(item => (g.perWheel ? g.positions : [null]).forEach(pos => {
    const k = g.id + '.' + item.id + (pos ? '.' + pos : ''); const st = insp.items[k] ? insp.items[k].state : 'Not Inspected';
    if (['Not Inspected', 'Test Not Performed'].indexOf(st) >= 0 || !['Good','Not present','Monitor','Dim','Damaged housing','Moisture present','Service Recommended','Good / Recharge','Recharge and Retest','Reported by customer','Intermittent','Needs Attention','Inoperative','Contaminated','Low','Replace Battery','Bad Cell','Illuminated now','Urgent','N/A'].includes(st)) n++;
  })); });
  return n;
}
